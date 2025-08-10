import cron from "node-cron";
import { sql } from "../config/db.js";
import { isMinerOnline } from "../services/minerStatus.js";
import { createMonthlyInvoices } from "../services/billing.js";

// poll de estado (grava só quando muda)
async function pollOnce() {
  const miners = await sql`SELECT * FROM miners`;
  for (const m of miners) {
    const online = await isMinerOnline(m);

    const last = await sql`
      SELECT status FROM miner_status_logs
      WHERE miner_id = ${m.id}
      ORDER BY at DESC LIMIT 1
    `;
    const lastStatus = last[0]?.status;
    if (lastStatus === undefined || lastStatus !== online) {
      await sql`
        INSERT INTO miner_status_logs (miner_id, status, source, extra)
        VALUES (${m.id}, ${online}, ${m.pool}, '{}'::jsonb)
      `;
    }
  }
}

export function startAllJobs() {
  // a cada 5 minutos
  cron.schedule("*/5 * * * *", pollOnce, { timezone: "Europe/Lisbon" });

  // faturar às 00:05 do dia 1 (mês anterior)
  cron.schedule(
    "5 0 1 * *",
    async () => {
      const now = new Date();
      const prevMonth = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
      const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      await createMonthlyInvoices(year, prevMonth);
    },
    { timezone: "Europe/Lisbon" }
  );
}
