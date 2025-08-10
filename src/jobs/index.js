// src/jobs/index.js
import { startUptimeTracker } from "./uptimeTracker.js";

let started = false;
export function startAllJobs() {
  if (started) return;
  started = true;

  startUptimeTracker();

  // (opcional) fecho mensal
  import("./monthlyClose.js")
    .then(mod => mod?.startMonthlyClose?.())
    .catch(() => console.log("[jobs] monthlyClose.js não encontrado (opcional)."));
}
