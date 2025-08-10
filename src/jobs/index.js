import { startUptimeViaBTC } from "./uptimeViaBTC.js";
import { startUptimeLTCPool } from "./uptimeLiteCoinPool.js";

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

  // (opcional) fecho mensal
  import("./monthlyClose.js")
    .then((m) => m?.startMonthlyClose?.())
    .catch(() => console.log("[jobs] monthlyClose.js não encontrado (opcional)."));
}
