// src/jobs/monthlyClose.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js"; // se usas ../config/ratelimit.js, troca o caminho

function previousMonthLocal() {
  // Usa timezone do servidor para determinar o mês anterior; o cron já corre em Europe/Lisbon
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1..12
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

// Upsert seguro do cabeçalho da fatura (sem depender de updated_at)
async function getOrCreateInvoiceId(userId, year, month) {
  // Tenta inserir; se já existir, não falha e não altera nada
  const inserted = await sql/*sql*/`
    INSERT INTO energy_invoices (user_id, year, month, subtotal_eur, status)
    VALUES (${userId}, ${year}, ${month}, 0, 'pendente')
    ON CONFLICT (user_id, year, month) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return inserted[0].id;

  // Já existia: lê o id
  const existing = await sql/*sql*/`
    SELECT id FROM energy_invoices
    WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
    LIMIT 1
  `;
  return existing[0]?.id;
}

export function startMonthlyClose() {
  // 00:05 do dia 1 (hora de Lisboa)
  cron.schedule(
    "5 0 1 * *",
    async () => {
      const { year, month } = previousMonthLocal();

      // Lock mensal para evitar duplicação entre instâncias
      const lockKey = `monthly-close:${year}-${month}`;
      const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 60 * 60 * 12 }); // 12h
      if (!gotLock) {
        console.log(`[monthlyClose] lock ativo ${year}-${month}, a ignorar duplicado.`);
        return;
      }

      try {
        // Busca todos os miners com dados necessários
        const miners = await sql/*sql*/`
          SELECT
            id,
            user_id,
            nome,
            COALESCE(total_horas_online, 0)        AS hours,
            COALESCE(consumo_kw_hora, 0)           AS consumo_kw_hora,
            COALESCE(preco_kw, 0)                  AS preco_kw
          FROM miners
        `;

        // Agrupa por utilizador
        const byUser = new Map();
        for (const m of miners) {
          if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
          byUser.get(m.user_id).push(m);
        }

        for (const [userId, list] of byUser.entries()) {
          const invoiceId = await getOrCreateInvoiceId(userId, year, month);
          if (!invoiceId) {
            console.warn(`[monthlyClose] não foi possível obter/crear invoice para user=${userId} ${month}/${year}`);
            continue;
          }

          let subtotal = 0;

          for (const m of list) {
            const hours = Number(m.hours) || 0;
            const consumo = Number(m.consumo_kw_hora) || 0;
            const preco = Number(m.preco_kw) || 0;

            const kwh = +(hours * consumo).toFixed(3);
            const amount = +(kwh * preco).toFixed(2);
            subtotal += amount;

            await sql/*sql*/`
              INSERT INTO energy_invoice_items
                (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
              VALUES
                (${invoiceId}, ${m.id}, ${m.nome || `Miner#${m.id}`}, ${hours}, ${kwh}, ${preco}, ${consumo}, ${amount})
              ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
                miner_nome        = EXCLUDED.miner_nome,
                hours_online      = EXCLUDED.hours_online,
                kwh_used          = EXCLUDED.kwh_used,
                preco_kw          = EXCLUDED.preco_kw,
                consumo_kw_hora   = EXCLUDED.consumo_kw_hora,
                amount_eur        = EXCLUDED.amount_eur
            `;
          }

          await sql/*sql*/`
            UPDATE energy_invoices
            SET subtotal_eur = ${+subtotal.toFixed(2)}, status = 'pendente'
            WHERE id = ${invoiceId}
          `;
        }

        // Reset contador para o novo mês
        await sql/*sql*/`UPDATE miners SET total_horas_online = 0;`;

        console.log(`✅ Fecho mensal concluído: ${month}/${year}`);
      } catch (e) {
        console.error("⛔ monthlyClose:", e);
      }
    },
    { timezone: "Europe/Lisbon" }
  );
}
