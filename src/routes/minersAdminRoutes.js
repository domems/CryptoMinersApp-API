// routes/minersAdminRoutes.js
import express from "express";
import { listarMinersPorEmail, listarTodasAsMiners } from "../controllers/minersAdmin.js";

const router = express.Router();

// GET /api/admin/miners-by-email?email=cliente@dominio.com
router.get("/miners-by-email", listarMinersPorEmail);
router.get("/miners", listarTodasAsMiners);

export default router;
