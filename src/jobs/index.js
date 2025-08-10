// src/jobs/index.js
import { startQuarterHourUptime } from "./uptimeQuarterHour.js";
import { startMonthlySnapshot } from "./monthlySnapshot.js";

export function startAllJobs() {
  startQuarterHourUptime();
  startMonthlySnapshot();
}
