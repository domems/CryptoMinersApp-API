// src/routes/admin.js
import { Router } from "express";
import {
  ping,
  listarMinersPorEmail,
  listarTodasAsMiners,
  obterStatusBatch,
  obterStatusPorId,
  obterMinerPorId,
  patchMinerPorId,
} from "../controllers/minersAdmin.js";

const router = Router();

// Health
router.get("/ping", ping);

// Listagens
router.get("/miners-all",        listarTodasAsMiners);
router.get("/miners",            listarTodasAsMiners); // alias
router.get("/miners-by-email",   listarMinersPorEmail);

// Status
router.get("/miners-status",       obterStatusBatch);
router.get("/miners/:id/status",   obterStatusPorId);

// CRUD por ID
router.get("/miners/:id",    obterMinerPorId);
router.patch("/miners/:id",  patchMinerPorId);
router.put("/miners/:id",    patchMinerPorId);

export default router;
