// src/jobs/monthlyClose.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js"; // ou o teu redis

/* ==== helpers ==== */
// devolve {year, month} do mês ATUAL (porque vamos correr no último dia)
function currentMonthLocal(baseDate = new Date()) {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth() + 1; // 1..12
  return { year: y, month: m };
}

function isLastDayOfMonth(d = new Date()) {
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return tomorrow.getDate() === 1; // amanhã é dia 1 => hoje é último dia
}

// Upsert seguro do cabeçalho da fatura
async function getOrCreateInvoiceId(userId, year, month) {
  const inserted = await sql/*sql*/`
    INSERT INTO energy_invoices (user_id, year, month, subtotal_eur, status)
    VALUES (${userId}, ${year}, ${month}, 0, 'pendente')
    ON CONFLICT (user_id, year, month) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return inserted[0].id;

  const existing = await sql/*sql*/`
    SELECT id FROM energy_invoices
    WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
    LIMIT 1
  `;
  return existing[0]?.id;
}

export function startMonthlyClose() {
  // Corre TODOS os dias às 17:33, hora de Lisboa.
  // Só executa o fecho se for o ÚLTIMO dia do mês.
  cron.schedule(
    "45 17 * * *",
    async () => {
      if (!isLastDayOfMonth()) {
        return; // não é último dia — sai calado
      }

      const { year, month } = currentMonthLocal();

      // Lock mensal para evitar duplicações entre instâncias
      const lockKey = `monthly-close:${year}-${String(month).padStart(2, "0")}`;
      const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 60 * 60 * 12 }); // 12h
      if (!gotLock) {
        console.log(`[monthlyClose] lock ativo ${year}-${month}, a ignorar duplicado.`);
        return;
      }

      try {
        const miners = await sql/*sql*/`
          SELECT
            id,
            user_id,
            nome,
            COALESCE(total_horas_online, 0)  AS hours,
            COALESCE(consumo_kw_hora, 0)     AS consumo_kw_hora,
            COALESCE(preco_kw, 0)            AS preco_kw
          FROM miners
        `;

        const byUser = new Map();
        for (const m of miners) {
          if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
          byUser.get(m.user_id).push(m);
        }

        for (const [userId, list] of byUser.entries()) {
          const invoiceId = await getOrCreateInvoiceId(userId, year, month);
          if (!invoiceId) {
            console.warn(`[monthlyClose] não foi possível criar/obter invoice para user=${userId} ${month}/${year}`);
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
                miner_nome       = EXCLUDED.miner_nome,
                hours_online     = EXCLUDED.hours_online,
                kwh_used         = EXCLUDED.kwh_used,
                preco_kw         = EXCLUDED.preco_kw,
                consumo_kw_hora  = EXCLUDED.consumo_kw_hora,
                amount_eur       = EXCLUDED.amount_eur
            `;
          }

          await sql/*sql*/`
            UPDATE energy_invoices
            SET subtotal_eur = ${+subtotal.toFixed(2)}, status = 'pendente'
            WHERE id = ${invoiceId}
          `;
        }

        // Reset do contador para o novo mês, imediatamente após o fecho
        await sql/*sql*/`UPDATE miners SET total_horas_online = 0;`;

        console.log(`✅ Fecho mensal concluído às 17:33 Europe/Lisbon: ${month}/${year}`);
      } catch (e) {
        console.error("⛔ monthlyClose:", e);
      }
    },
    { timezone: "Europe/Lisbon" }
  );
}
