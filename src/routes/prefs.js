import express from "express";
import { getMyPrefs, patchMyPrefs } from "../controllers/prefsController.js";

const router = express.Router();
// router.use(requireAuth);
router.get("/me/notification-prefs", getMyPrefs);
router.patch("/me/notification-prefs", express.json(), patchMyPrefs);

export default router;
