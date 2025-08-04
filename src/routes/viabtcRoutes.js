import express from "express";
import { getViaBTCData } from "../controllers/viabtcController.js";

const router = express.Router();
router.get("/viabtc/workers/:minerId", getViaBTCData);

export default router;
