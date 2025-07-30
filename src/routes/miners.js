import express from "express";
import {
  criarMiner,
  listarMinersPorUser,
  atualizarStatusMiner,
  atualizarMinerComoAdmin,
  atualizarMinerComoCliente,
  apagarMiner,
  obterMinerPorId
} from "../controllers/minersController.js";

const router = express.Router();

router.post("/", criarMiner);
router.get("/:userId", listarMinersPorUser);

// PUT /miners/admin/:id → usado pelo admin (edita tudo)
router.put("/admin/:id", atualizarMinerComoAdmin);

// PUT /miners/cliente/:id → usado pelo cliente (edita apenas watcher_key e worker_name)
router.put("/cliente/:id", atualizarMinerComoCliente);

router.put("/:id/status", atualizarStatusMiner);
router.delete("/:id", apagarMiner);

//Obter o miner pelo ID
router.get("/miners/:id", obterMinerPorId);


export default router;
