// src/routes/admin.js
import { Router } from "express";
import {
  ping,
  listarMinersPorEmail,
  listarTodasAsMiners,
  obterStatusBatch,
  obterStatusPorId,
} from "../controllers/minersAdmin.js";

const router = Router();

router.get("/ping", ping);
router.get("/miners-by-email", listarMinersPorEmail);
router.get("/miners", listarTodasAsMiners);
router.get("/miners-status", obterStatusBatch);
router.get("/miners/:id/status", obterStatusPorId);
router.get("/miners/:id", obterMinerPorId);
router.patch("/miners/:id", patchMinerPorId);
router.put("/miners/:id", patchMinerPorId);

export default router;
