import cron from "node-cron";
import { sql } from "../config/db.js";
import { isMinerOnline } from "../services/minerStatus.js";

export function startQuarterHourUptime() {
  // corre de 15 em 15 minutos
  cron.schedule("*/15 * * * *", async () => {
    try {
      const miners = await sql/*sql*/`
        SELECT id, nome, worker_name, api_key, coin, pool
        FROM miners
        WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
      `;

      for (const m of miners) {
        let online = false;
        try {
          online = await isMinerOnline(m);
        } catch {
          online = false;
        }
        if (online) {
          await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
            WHERE id = ${m.id}
          `;
        }
      }
      console.log("✅ Tick 15m concluído");
    } catch (e) {
      console.error("⛔ uptimeQuarterHour:", e);
    }
  }, { timezone: "Europe/Lisbon" });
}
