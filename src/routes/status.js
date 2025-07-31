// routes/status.routes.js
import express from "express";
import { obterStatusViaBTC } from "../controllers/statusController.js";

const router = express.Router();

router.get("/status/:workerName/:coin/:apiKey/:secretKey", obterStatusViaBTC);

export default router;
