// src/routes/notifications.js
import express from "express";
import { listMyNotifications } from "../controllers/notificationsController.js";
// Se tens middleware de auth, mete aqui: import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// router.use(requireAuth); // descomenta se tiveres
router.get("/me/notifications", listMyNotifications);

export default router;
