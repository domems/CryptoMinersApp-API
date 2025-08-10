import cron from "node-cron";
import { sql } from "../config/db.js";
import { logMinerIfChanged } from "../services/uptimeLogger.js";

export function startUptimePoller() {
  cron.schedule(
    "*/5 * * * *",
    async () => {
      const miners = await sql`SELECT * FROM miners`;
      await Promise.all(miners.map((m) => logMinerIfChanged(m)));
    },
    { timezone: "Europe/Lisbon" }
  );
}
