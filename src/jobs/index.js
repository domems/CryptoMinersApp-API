// src/jobs/index.js
import { startUptimeViaBTC } from "./uptimeViaBTC.js";
import { startUptimeLTCPool } from "./uptimeLiteCoinPool.js";
import { startUptimeBinance } from "./uptimeBinance.js";
import { startUptimeF2Pool } from "./uptimeF2Pool.js";
import { startUptimeMiningDutch } from "./uptimeMiningDutch.js";

let started = false;

export function startAllJobs() {
  if (started) {
    console.log("[jobs] já iniciado – a ignorar nova chamada.");
    return;
  }
  started = true;

  // cada job agenda o seu próprio cron (*/15)
  try { startUptimeViaBTC(); } catch (e) { console.error("[jobs] ViaBTC falhou:", e); }
  try { startUptimeLTCPool(); } catch (e) { console.error("[jobs] LiteCoinPool falhou:", e); }
  try { startUptimeBinance(); } catch (e) { console.error("[jobs] Binance falhou:", e); }
  try { startUptimeF2Pool(); } catch (e) { console.error("[jobs] F2Pool falhou:", e); }
  try { startUptimeMiningDutch(); } catch (e) { console.error("[jobs] MiningDutch falhou:", e); }

  // monthly close (17:33 Europe/Lisbon no próprio ficheiro)
  import("./monthlyClose.js")
    .then(m => m?.startMonthlyClose?.())
    .catch(() => console.log("[jobs] monthlyClose.js não encontrado (opcional)."));
}
