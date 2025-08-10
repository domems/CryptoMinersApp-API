// src/jobs/monthlySnapshot.js
import cron from "node-cron";
import { sql } from "../config/db.js";

function prevMonthUTC() {
  const now = new Date();
  const prevMonth = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return { year, month: prevMonth };
}

export function startMonthlySnapshot() {
  // 00:05 do dia 1 — mês anterior está fechado
  cron.schedule("5 0 1 * *", async () => {
    const { year, month } = prevMonthUTC();
    try {
      // lê valores atuais (que são do mês acabado de terminar)
      const miners = await sql/*sql*/`
        SELECT id, user_id, nome, preco_kw, consumo_kw_hora, COALESCE(horas_online, 0) AS horas_online
        FROM miners
      `;

      // snapshot por miner
      for (const m of miners) {
        const hours = Number(m.horas_online || 0);
        const kwh = +(hours * Number(m.consumo_kw_hora || 0)).toFixed(3);
        const amount = +(kwh * Number(m.preco_kw || 0)).toFixed(2);

        // upsert para segurança (idempotente)
        await sql/*sql*/`
          INSERT INTO miner_monthly_usage
            (user_id, miner_id, year, month, horas_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
          VALUES
            (${m.user_id}, ${m.id}, ${year}, ${month}, ${hours}, ${kwh}, ${m.preco_kw || 0}, ${m.consumo_kw_hora || 0}, ${amount})
          ON CONFLICT (miner_id, year, month) DO UPDATE SET
            horas_online    = EXCLUDED.horas_online,
            kwh_used        = EXCLUDED.kwh_used,
            preco_kw        = EXCLUDED.preco_kw,
            consumo_kw_hora = EXCLUDED.consumo_kw_hora,
            amount_eur      = EXCLUDED.amount_eur,
            created_at      = now()
        `;
      }

      // reset para começar novo mês
      await sql/*sql*/`UPDATE miners SET horas_online = 0;`;

      console.log(`✅ Snapshot mensal criado para ${month}/${year} & reset feito.`);
    } catch (e) {
      console.error("⛔ monthlySnapshot:", e);
    }
  }, { timezone: "Europe/Lisbon" });
}
