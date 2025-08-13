// routes/storeMinersRoutes.js
import { Router } from "express";
import {
  getStoreMiners,
  createStoreMiner,
  updateStoreMiner,
  deleteStoreMiner,
  assignStoreMinerToUser,
} from "../controllers/storeMinersController.js";

const router = Router();

router.get("/store-miners", getStoreMiners);
router.post("/store-miners", createStoreMiner);
router.put("/store-miners/:id", updateStoreMiner);
router.delete("/store-miners/:id", deleteStoreMiner);
router.post("/store-miners/:id/assign", assignStoreMinerToUser);

export default router;
