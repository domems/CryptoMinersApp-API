// src/jobs/uptimeQuarterHour.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { isMinerOnline } from "../services/minerStatus.js";

// corre de 15 em 15 minutos
export function startQuarterHourUptime() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      const miners = await sql/*sql*/`
        SELECT id, nome, worker_name, api_key, coin, pool
        FROM miners
        WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
      `;

      for (const m of miners) {
        const online = await isMinerOnline(m).catch(() => false);
        if (online) {
          await sql/*sql*/`
            UPDATE miners
            SET horas_online = COALESCE(horas_online, 0) + 0.25
            WHERE id = ${m.id}
          `;
        }
      }
    } catch (e) {
      console.error("⛔ uptime 15m:", e);
    }
  }, { timezone: "Europe/Lisbon" });
}
