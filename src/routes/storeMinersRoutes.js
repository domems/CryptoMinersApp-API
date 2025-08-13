// routes/storeMinersRoutes.js
import { Router } from "express";
import {
  getStoreMiners,
  createStoreMiner,
  updateStoreMiner,
  deleteStoreMiner,
} from "../controllers/storeMinersController.js";

const router = Router();

router.get("/store-miners", getStoreMiners);
router.post("/store-miners", createStoreMiner);
router.put("/store-miners/:id", updateStoreMiner);
router.delete("/store-miners/:id", deleteStoreMiner);

export default router;
