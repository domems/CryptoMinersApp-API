// src/routes/push.js
import express from "express";
import { registerPushToken, deletePushToken } from "../controllers/pushController.js";

const router = express.Router();
// Se tiveres middleware de auth, mete aqui: router.use(requireAuth);

router.post("/me/push-token", express.json(), registerPushToken);
router.delete("/me/push-token", express.json(), deletePushToken);

export default router;
