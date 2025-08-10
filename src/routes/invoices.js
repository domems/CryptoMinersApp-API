import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/** Lista faturas por utilizador (headers) */
router.get("/", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });

  try {
    const rows = await sql/*sql*/`
      SELECT id, year, month, subtotal_eur, status, created_at
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;
    res.json(rows);
  } catch (e) {
    console.error("invoices list:", e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/** Linhas de uma fatura (por invoice_id) */
router.get("/:id(\\d+)/items", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const items = await sql/*sql*/`
      SELECT miner_id, miner_nome, hours_online, kwh_used,
             preco_kw, consumo_kw_hora, amount_eur
      FROM energy_invoice_items
      WHERE invoice_id = ${id}
      ORDER BY miner_nome
    `;
    res.json(items);
  } catch (e) {
    console.error("invoice items:", e);
    res.status(500).json({ error: "Erro ao listar itens da fatura" });
  }
});

export default router;
