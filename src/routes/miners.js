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

// Rota mais específica vem primeiro
router.get("/miners/:id", obterMinerPorId); // <-- esta deve vir antes da rota :userId
router.put("/admin/:id", atualizarMinerComoAdmin);
router.put("/cliente/:id", atualizarMinerComoCliente);
//router.put("/:id/status", atualizarStatusMiner);
router.delete("/:id", apagarMiner);

// Rota de listagem por userId deve ser a ÚLTIMA
router.get("/:userId", listarMinersPorUser); // <-- ESTA FICA POR ÚLTIMO

// Criação vem no início porque não entra em conflito
router.post("/", criarMiner);



export default router;
