import express from "express";
import { getMinerStatus } from "../controllers/statusController.js";

const router = express.Router();
router.get("/miners/:id/status", getMinerStatus);
router.get("/miners/status", getMinersStatusBatch);

export default router;



