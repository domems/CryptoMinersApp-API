import express from "express";
import { obterStatusViaWatcher } from "../controllers/statusController.js";

const router = express.Router();

router.get("/:watcherKey/:workerName", obterStatusViaWatcher);

export default router;
