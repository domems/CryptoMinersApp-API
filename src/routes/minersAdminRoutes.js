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

// Saude/diagnóstico (usado pelo frontend p/ autodetectar o prefixo)
router.get("/ping", ping);

// Listagens
router.get("/miners-all", listarTodasAsMiners);
router.get("/miners-by-email", listarMinersPorEmail);

// Status (batch e por id)
router.get("/miners-status", obterStatusBatch);
router.get("/miners/:id/status", obterStatusPorId);

export default router;
