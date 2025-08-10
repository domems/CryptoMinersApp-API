import { startQuarterHourUptime } from "./uptimeQuarterHour.js";
import { startMonthlyClose } from "./monthlyClose.js"; // ← agora existe

let started = false;

export function startAllJobs() {
  if (started) return;
  started = true;

  startQuarterHourUptime();
  startMonthlyClose();

  console.log("[jobs] agendadores iniciados.");
}
