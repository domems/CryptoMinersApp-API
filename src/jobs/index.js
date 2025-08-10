// src/jobs/index.js
import cron from "node-cron";
import { runUptimeQuarterHour } from "./uptimeQuarterHour.js";

let started = false;

/**
 * Arranca todos os jobs do backend.
 * - Uptime: a cada 15 minutos (Europe/Lisbon)
 * - MonthlyClose: tenta carregar ./monthlyClose.js (opcional)
 */
export async function startAllJobs() {
  if (started) {
    console.log("[jobs] já iniciado – a ignorar nova chamada.");
    return;
  }
  started = true;

  // Uptime (*/15)
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        await runUptimeQuarterHour();
      } catch (e) {
        console.error("⛔ erro no job de uptime:", e);
      }
    },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] Uptime (*/15) agendado.");

  // Monthly close (opcional)
  try {
    const mod = await import("./monthlyClose.js"); // só carrega se existir
    if (mod?.startMonthlyClose) {
      mod.startMonthlyClose();
      console.log("[jobs] MonthlyClose agendado.");
    } else {
      console.log("[jobs] monthlyClose.js encontrado mas sem startMonthlyClose().");
    }
  } catch {
    console.log("[jobs] monthlyClose.js não encontrado (opcional).");
  }
}
