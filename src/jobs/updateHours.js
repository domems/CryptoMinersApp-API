// jobs/updateHours.js
import { sql } from "../config/db.js";
import cron from "node-cron";

// a cada 15 minutos
cron.schedule("*/15 * * * *", async () => {
  try {
    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = total_horas_online + 0.25
      WHERE status = 'online'
    `;
    console.log("✅ Acrescentei +0.25h às máquinas online");
  } catch (err) {
    console.error("❌ Erro ao atualizar horas online:", err);
  }
});
