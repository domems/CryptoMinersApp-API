// src/jobs/deliverInapp.js
import { deliverInappOnce } from "../workers/inappWorker.js";

(async () => {
  try {
    const res = await deliverInappOnce();
    console.log(`[deliverInapp] delivered=${res.delivered}`);
    process.exit(0);
  } catch (e) {
    console.error("[deliverInapp] ERRO:", e);
    process.exit(1);
  }
})();
