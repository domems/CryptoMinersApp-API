// src/routes/invoices.js
import express from "express";
import { sql } from "../config/db.js";
import { computeProvisionalInvoiceForUser } from "../services/provisionalInvoice.js";

const router = express.Router();

// 1) current primeiro!
router.get("/current/items", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });
  try {
    const prov = await computeProvisionalInvoiceForUser(userId);
    res.json(prov.items);
  } catch (e) {
    console.error("❌ Erro em current/items:", e);
    res.status(500).json({ error: "Erro ao calcular fatura em curso" });
  }
});

// lista (podes manter como está)
router.get("/", async (req, res) => {
  const { userId, includeCurrent } = req.query;
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });

  try {
    const rows = await sql/*sql*/`
      SELECT id, year, month, subtotal_eur, status, created_at
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;

    if (String(includeCurrent) === "1") {
      const prov = await computeProvisionalInvoiceForUser(userId);
      rows.unshift({
        id: null,
        year: prov.header.year,
        month: prov.header.month,
        subtotal_eur: prov.header.subtotal_eur,
        status: prov.header.status,
        created_at: null,
      });
    }

    res.json(rows);
  } catch (err) {
    console.error("❌ Erro ao listar faturas:", err);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

// 2) usa regex para garantir que :id é numérico
router.get("/:id(\\d+)", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await sql/*sql*/`
    SELECT id, user_id, year, month, subtotal_eur, status, created_at
    FROM energy_invoices
    WHERE id = ${id}
  `;
  if (!row) return res.status(404).json({ error: "Fatura não encontrada" });
  res.json(row);
});

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
    console.error("❌ Erro ao listar itens:", e);
    res.status(500).json({ error: "Erro ao listar itens da fatura" });
  }
});

export default router;
