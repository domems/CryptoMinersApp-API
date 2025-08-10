import { startQuarterHourUptime } from "./uptimeQuarterHour.js";
// se também usas o fecho mensal:
// import { startMonthlyClose } from "./monthlyClose.js";

let started = false;

export function startAllJobs() {
  if (started) {
    console.log("[jobs] já iniciado – a ignorar nova chamada.");
    return;
  }
  started = true;

  startQuarterHourUptime();
  startMonthlyClose();

  console.log("[jobs] agendadores iniciados.");
}
