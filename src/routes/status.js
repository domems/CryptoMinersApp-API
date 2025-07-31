// routes/status.routes.js
import express from "express";
import { obterStatusViaBTC } from "../controllers/statusController.js";
import { obterStatusViaWatcher } from "../controllers/statusScrapingController.js";

const router = express.Router();

router.get("/status/watcher/:workerName/:coin/:watcherKey", obterStatusViaWatcher);
router.get("/status/:workerName/:coin/:apiKey/:secretKey", obterStatusViaBTC);

export default router;
