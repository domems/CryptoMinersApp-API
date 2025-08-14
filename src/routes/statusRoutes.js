import express from "express";
import { getMinerStatus } from "../controllers/statusController.js";

const router = express.Router();
router.get("/miners/:minerId/status", getMinerStatus);

export default router;



