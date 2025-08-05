// routes/storeMiners.js
import express from "express";
import { getStoreMiners, createStoreMiner } from "../controllers/storeMinersController.js";

const router = express.Router();

router.get("/", getStoreMiners);
router.post("/", createStoreMiner);

export default router;
