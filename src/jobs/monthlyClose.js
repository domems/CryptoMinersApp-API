// src/jobs/monthlyClose.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js"; // para evitar duplicação em múltiplas instâncias

function previousMonthLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1..12
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

export function startMonthlyClose() {
  // 00:05 do dia 1 (hora de Lisboa)
  cron.schedule("5 0 1 * *", async () => {
    const { year, month } = previousMonthLocal();

    // lock mensal (evita correr duas vezes se houver 2 instâncias)
    const lockKey = `monthly-close:${year}-${month}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 60 * 60 * 12 }); // 12h
    if (!gotLock) {
      console.log(`[monthlyClose] lock ativo ${year}-${month}, a ignorar duplicado.`);
      return;
    }

    try {
      const miners = await sql/*sql*/`
        SELECT id, user_id, nome,
               COALESCE(total_horas_online,0) AS hours,
               COALESCE(consumo_kw_hora,0) AS consumo_kw_hora,
               COALESCE(preco_kw,0) AS preco_kw
        FROM miners
      `;

      const byUser = new Map();
      for (const m of miners) {
        if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
        byUser.get(m.user_id).push(m);
      }

      for (const [userId, list] of byUser.entries()) {
        const [inv] = await sql/*sql*/`
          INSERT INTO energy_invoices (user_id, year, month, subtotal_eur, status)
          VALUES (${userId}, ${year}, ${month}, 0, 'pendente')
          ON CONFLICT (user_id, year, month)
          DO UPDATE SET updated_at = now()
          RETURNING id
        `;

        let subtotal = 0;

        for (const m of list) {
          const hours = Number(m.hours);
          const kwh = +(hours * Number(m.consumo_kw_hora)).toFixed(3);
          const amount = +(kwh * Number(m.preco_kw)).toFixed(2);
          subtotal += amount;

          await sql/*sql*/`
            INSERT INTO energy_invoice_items
              (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
            VALUES
              (${inv.id}, ${m.id}, ${m.nome || `Miner#${m.id}`}, ${hours}, ${kwh},
               ${m.preco_kw}, ${m.consumo_kw_hora}, ${amount})
            ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
              miner_nome = EXCLUDED.miner_nome,
              hours_online = EXCLUDED.hours_online,
              kwh_used = EXCLUDED.kwh_used,
              preco_kw = EXCLUDED.preco_kw,
              consumo_kw_hora = EXCLUDED.consumo_kw_hora,
              amount_eur = EXCLUDED.amount_eur
          `;
        }

        await sql/*sql*/`
          UPDATE energy_invoices
          SET subtotal_eur = ${+subtotal.toFixed(2)}, status = 'pendente'
          WHERE id = ${inv.id}
        `;
      }

      // reset para o novo mês
      await sql/*sql*/`UPDATE miners SET total_horas_online = 0;`;

      console.log(`✅ Fecho mensal concluído: ${month}/${year}`);
    } catch (e) {
      console.error("⛔ monthlyClose:", e);
    }
  }, { timezone: "Europe/Lisbon" });
}
