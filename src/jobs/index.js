import { startQuarterHourUptime } from "./uptimeQuarterHour.js";
import { startMonthlyClose } from "./monthlyClose.js";

export function startAllJobs() {
  startQuarterHourUptime();
  startMonthlyClose();
}
