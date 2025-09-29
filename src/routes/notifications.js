// src/routes/notifications.js
import express from "express";
import { listMyNotifications, markMyNotificationRead } from "../controllers/notificationsController.js";

const router = express.Router();
// router.use(requireAuth);
router.get("/me/notifications", listMyNotifications);
router.post("/me/notifications/:id/read", express.json(), markMyNotificationRead);

export default router;


