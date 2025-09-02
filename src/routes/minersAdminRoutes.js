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
router.get("/admin/ping", ping);

// Listagens
router.get("/admin/miners-all",  listarTodasAsMiners);
router.get("/admin/miners",      listarTodasAsMiners); // alias
router.get("/admin/miners-by-email",  listarMinersPorEmail);

// Status
router.get("/admin/miners-status",  obterStatusBatch);
router.get("/admin/miners/:id/status",  obterStatusPorId);

// CRUD por ID
router.get("/admin/miners/:id",  obterMinerPorId);
router.patch("/admin/miners/:id",  patchMinerPorId);
router.put("/admin/miners/:id",  patchMinerPorId);

export default router;
