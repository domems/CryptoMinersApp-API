// src/jobs/detectState.js
import { detectAllOnce } from "../detectors/stateDetector.js";

(async () => {
  try {
    const res = await detectAllOnce();
    console.log(`[detectState] miners=${res.total} transicoes=${res.changed}`);
    process.exit(0);
  } catch (e) {
    console.error("[detectState] ERRO:", e);
    process.exit(1);
  }
})();
