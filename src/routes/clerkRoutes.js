import express from "express";
import { getUserIdByEmail } from "../controllers/clerkController.js";

const router = express.Router();

router.get("/user/:email", getUserIdByEmail);

export default router;
