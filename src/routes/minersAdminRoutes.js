// routes/minersAdminRoutes.js
import express from "express";
import { listarMinersPorEmail } from "../controllers/minersAdmin.js";

const router = express.Router();

// GET /api/admin/miners-by-email?email=cliente@dominio.com
router.get("/miners-by-email", listarMinersPorEmail);

export default router;
