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

  // cada job tem o seu próprio lock por slot
  startUptimeViaBTC();
  startUptimeLTCPool();
  startUptimeBinance();
  startUptimeF2Pool();
  startUptimeMiningDutch();

  // (opcional) fecho mensal
  import("./monthlyClose.js")
    .then((m) => m?.startMonthlyClose?.())
    .catch(() => console.log("[jobs] monthlyClose.js não encontrado (opcional)."));
}
