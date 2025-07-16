import express from "express";
import {
  criarMiner,
  listarMinersPorUser,
  atualizarStatusMiner,
  apagarMiner
} from "../controllers/minersController.js";

const router = express.Router();

router.post("/", criarMiner);
router.get("/:userId", listarMinersPorUser);
router.put("/:id/status", atualizarStatusMiner);
router.delete("/:id", apagarMiner);

export default router;
