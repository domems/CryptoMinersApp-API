// routes/minersAdminRoutes.js
import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  listarMinersPorEmail,
  listarTodasAsMiners,
} from "../controllers/minersAdmin.js";

const router = express.Router();

// health/diagnóstico da proteção
router.get("/admin/ping", requireAdmin, (_req, res) => res.json({ ok: true }));

// Listagens
router.get("/admin/miners-by-email", requireAdmin, listarMinersPorEmail);
router.get("/admin/miners", requireAdmin, listarTodasAsMiners);
// alias compat
router.get("/admin/miners-all", requireAdmin, listarTodasAsMiners);

export default router;
