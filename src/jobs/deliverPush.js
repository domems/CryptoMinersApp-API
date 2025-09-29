// src/jobs/deliverPush.js
import { deliverPushOnce } from "../workers/pushWorker.js";

(async () => {
  try {
    const res = await deliverPushOnce();
    console.log(`[deliverPush] picked=${res.picked} delivered=${res.delivered}`);
    process.exit(0);
  } catch (e) {
    console.error("[deliverPush] ERRO:", e);
    process.exit(1);
  }
})();
