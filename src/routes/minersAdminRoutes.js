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
router.get("/admin/ping", adminOnly, ping);

// Listagens
router.get("/admin/miners-all", adminOnly, listarTodasAsMiners);
router.get("/admin/miners",     adminOnly, listarTodasAsMiners); // alias
router.get("/admin/miners-by-email", adminOnly, listarMinersPorEmail);

// Status
router.get("/admin/miners-status", adminOnly, obterStatusBatch);
router.get("/admin/miners/:id/status", adminOnly, obterStatusPorId);

// CRUD por ID
router.get("/admin/miners/:id", adminOnly, obterMinerPorId);
router.patch("/admin/miners/:id", adminOnly, patchMinerPorId);
router.put("/admin/miners/:id", adminOnly, patchMinerPorId);

export default router;
