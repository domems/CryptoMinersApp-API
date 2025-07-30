import express from "express";
import { obterStatusViaBTC } from "../controllers/statusController.js";

const router = express.Router();

router.post("/status", obterStatusViaBTC);

export default router;
