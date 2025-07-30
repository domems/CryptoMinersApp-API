import express from "express";
import { obterStatusViaWatcher } from "../controllers/statusController.js";

const router = express.Router();

router.get("/:key/:worker", obterStatusViaWatcher);

export default router;
