import express from "express";
import { sql } from "../config/db.js";
import { computeProvisionalInvoiceForUser } from "../services/provisionalInvoice.js";

const router = express.Router();

/**
 * Lista faturas do utilizador.
 *   GET /api/invoices?userId=...&includeCurrent=1
 * - Se includeCurrent=1, adiciona a "fatura em curso" (mês atual, não gravada).
 */
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
        status: prov.header.status, // "em_curso"
        created_at: null,
      });
    }

    res.json(rows);
  } catch (err) {
    console.error("❌ Erro ao listar faturas:", err);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/** Detalhe (header) de fatura fechada por ID */
router.get("/:id", async (req, res) => {
  try {
    const [row] = await sql/*sql*/`
      SELECT id, user_id, year, month, subtotal_eur, status, created_at
      FROM energy_invoices
      WHERE id = ${req.params.id}
    `;
    if (!row) return res.status(404).json({ error: "Fatura não encontrada" });
    res.json(row);
  } catch (e) {
    console.error("❌ Erro ao obter fatura:", e);
    res.status(500).json({ error: "Erro ao obter fatura" });
  }
});

/** Linhas (itens) de fatura fechada */
router.get("/:id/items", async (req, res) => {
  try {
    const items = await sql/*sql*/`
      SELECT miner_id, miner_nome, hours_online, kwh_used,
             preco_kw, consumo_kw_hora, amount_eur
      FROM energy_invoice_items
      WHERE invoice_id = ${req.params.id}
      ORDER BY miner_nome
    `;
    res.json(items);
  } catch (e) {
    console.error("❌ Erro ao listar itens:", e);
    res.status(500).json({ error: "Erro ao listar itens da fatura" });
  }
});

/** Linhas “em curso” do mês atual (não gravadas) */
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

export default router;
