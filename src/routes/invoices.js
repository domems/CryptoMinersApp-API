import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/**
 * Lista todas as faturas de um utilizador
 * GET /api/invoices?userId=123
 */
router.get("/", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "userId é obrigatório" });
  }

  try {
    const invoices = await sql/*sql*/`
      SELECT id, year, month, subtotal_eur, status, created_at, updated_at
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;
    res.json(invoices);
  } catch (err) {
    console.error("❌ Erro ao listar faturas:", err);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/**
 * Lista os itens (máquinas) de uma fatura
 * GET /api/invoices/:id/items
 */
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;

  try {
    const items = await sql/*sql*/`
      SELECT miner_id, miner_nome, hours_online, kwh_used,
             preco_kw, consumo_kw_hora, amount_eur
      FROM energy_invoice_items
      WHERE invoice_id = ${id}
      ORDER BY miner_nome
    `;
    res.json(items);
  } catch (err) {
    console.error("❌ Erro ao listar itens da fatura:", err);
    res.status(500).json({ error: "Erro ao listar itens da fatura" });
  }
});

export default router;
