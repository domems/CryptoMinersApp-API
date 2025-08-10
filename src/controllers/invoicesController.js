import { sql } from "../config/db.js";
import { createMonthlyInvoices } from "../services/billing.js";

export async function listInvoices(req, res) {
  const { userId } = req.query;
  const rows = await sql`
    SELECT * FROM energy_invoices
    WHERE (${userId} IS NULL OR user_id = ${userId})
    ORDER BY year DESC, month DESC, user_id
  `;
  res.json(rows);
}

export async function listInvoiceItems(req, res) {
  const rows = await sql`
    SELECT * FROM energy_invoice_items
    WHERE invoice_id = ${req.params.id}
    ORDER BY miner_id
  `;
  res.json(rows);
}

export async function recalcInvoices(req, res) {
  const { year, month } = req.body || {};
  if (!year || !month) {
    return res.status(400).json({ error: "year e month são obrigatórios" });
  }
  await createMonthlyInvoices(Number(year), Number(month));
  res.json({ ok: true });
}
