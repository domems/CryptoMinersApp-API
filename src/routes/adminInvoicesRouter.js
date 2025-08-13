// backend/routes/adminInvoicesRouter.js
import express from "express";
import { sql } from "../config/db.js";
// importa o helper que já usas no /admin/miners-by-email
import { resolveUserIdByEmail, assertAdminFromHeader } from "../utils/admin-helpers.js";

const router = express.Router();

/**
 * GET /api/admin/invoices-by-email?email=...
 * Lista faturas do cliente por email (inclui "em_curso")
 */
router.get("/admin/invoices-by-email", async (req, res) => {
  try {
    await assertAdminFromHeader(req); // valida admin via "x-user-email"
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email em falta" });

    const userId = await resolveUserIdByEmail(email);
    if (!userId) return res.json([]); // sem utilizador

    // faturas guardadas
    const saved = await sql/*sql*/`
      SELECT id, user_id, year, month,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(status,'pendente') AS status,
             COALESCE(currency_code,'EUR') AS currency_code
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;

    // fatura em curso (on-the-fly)
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;

    const miners = await sql/*sql*/`
      SELECT
        COALESCE(total_horas_online,0) AS hours_online,
        COALESCE(consumo_kw_hora,0)    AS consumo_kw_hora,
        COALESCE(preco_kw,0)           AS preco_kw
      FROM miners
      WHERE user_id = ${userId}
    `;
    const subtotalCurrent = +miners.reduce((acc, r) => {
      const hours = Number(r.hours_online) || 0;
      const consumo = Number(r.consumo_kw_hora) || 0;
      const preco = Number(r.preco_kw) || 0;
      return acc + (hours * consumo * preco);
    }, 0).toFixed(2);

    const currencyRow = await sql/*sql*/`
      SELECT COALESCE(MAX(currency_code),'EUR') AS currency_code
      FROM energy_invoices
      WHERE user_id = ${userId}
    `;
    const currency_code = String(currencyRow?.[0]?.currency_code || "EUR");

    const currentRow = {
      // sem id porque ainda não está fechada/gravada
      user_id: userId,
      year: y,
      month: m,
      subtotal_amount: subtotalCurrent,
      status: "em_curso",
      currency_code,
    };

    return res.json([currentRow, ...saved.map(r => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: Number(r.subtotal_amount),
      status: String(r.status),
      currency_code: String(r.currency_code || "EUR"),
    }))]);
  } catch (e) {
    console.error("GET /admin/invoices-by-email:", e);
    res.status(500).json({ error: "Erro ao listar faturas (admin)" });
  }
});

/**
 * POST /api/admin/invoices/close-now
 * body: { email }
 * Fecha a fatura do mês atual para o cliente indicado
 */
router.post("/admin/invoices/close-now", async (req, res) => {
  try {
    await assertAdminFromHeader(req);
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email em falta" });

    const userId = await resolveUserIdByEmail(email);
    if (!userId) return res.status(404).json({ error: "Utilizador não encontrado" });

    // Reutiliza a tua lógica /invoices/close-now
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const miners = await sql/*sql*/`
      SELECT
        id,
        COALESCE(nome, CONCAT('Miner#', id::text)) AS miner_nome,
        COALESCE(total_horas_online,0)             AS hours_online,
        COALESCE(consumo_kw_hora,0)                AS consumo_kw_hora,
        COALESCE(preco_kw,0)                       AS preco_kw
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY id ASC
    `;

    let subtotal = 0;

    const inserted = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'EUR')
      ON CONFLICT (user_id, year, month)
      DO UPDATE SET status = 'pendente'
      RETURNING id
    `;
    const invoiceId = inserted[0].id;

    for (const r of miners) {
      const hours = Number(r.hours_online) || 0;
      const consumo = Number(r.consumo_kw_hora) || 0;
      const preco = Number(r.preco_kw) || 0;
      const kwh = +(hours * consumo).toFixed(3);
      const amount = +(kwh * preco).toFixed(2);
      subtotal += amount;

      await sql/*sql*/`
        INSERT INTO energy_invoice_items
          (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
        VALUES
          (${invoiceId}, ${r.id}, ${r.miner_nome}, ${hours}, ${kwh}, ${preco}, ${consumo}, ${amount})
        ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
          miner_nome        = EXCLUDED.miner_nome,
          hours_online      = EXCLUDED.hours_online,
          kwh_used          = EXCLUDED.kwh_used,
          preco_kw          = EXCLUDED.preco_kw,
          consumo_kw_hora   = EXCLUDED.consumo_kw_hora,
          amount_eur        = EXCLUDED.amount_eur
      `;
    }

    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${+subtotal.toFixed(2)}, status = 'pendente', currency_code = 'EUR'
      WHERE id = ${invoiceId}
    `;

    // Zera as horas
    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = 0
      WHERE user_id = ${userId}
    `;

    return res.json({ ok: true, invoice: { id: invoiceId, year, month, status: "pendente", subtotal_amount: +subtotal.toFixed(2) } });
  } catch (e) {
    console.error("POST /admin/invoices/close-now:", e);
    res.status(500).json({ error: "Erro ao fechar fatura (admin)" });
  }
});

/**
 * GET /api/admin/invoices/:id
 * Devolve header da fatura
 */
router.get("/admin/invoices/:id", async (req, res) => {
  try {
    await assertAdminFromHeader(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });

    const [inv] = await sql/*sql*/`
      SELECT id, user_id, year, month, status,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(currency_code,'EUR') AS currency_code
      FROM energy_invoices
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    res.json({
      ok: true,
      invoice: {
        id: Number(inv.id),
        user_id: String(inv.user_id),
        year: Number(inv.year),
        month: Number(inv.month),
        status: String(inv.status),
        subtotal_amount: Number(inv.subtotal_amount),
        currency_code: String(inv.currency_code || "EUR"),
      },
    });
  } catch (e) {
    console.error("GET /admin/invoices/:id:", e);
    res.status(500).json({ error: "Erro ao obter fatura (admin)" });
  }
});

/**
 * PATCH /api/admin/invoices/:id
 * body: { status?, currency_code? }
 */
router.patch("/admin/invoices/:id", async (req, res) => {
  try {
    await assertAdminFromHeader(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });

    const { status, currency_code } = req.body || {};
    if (!status && !currency_code) {
      return res.status(400).json({ error: "Nada para atualizar" });
    }

    await sql/*sql*/`
      UPDATE energy_invoices
      SET
        status = COALESCE(${status}, status),
        currency_code = COALESCE(${currency_code}, currency_code)
      WHERE id = ${id}
    `;

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /admin/invoices/:id:", e);
    res.status(500).json({ error: "Erro ao atualizar fatura (admin)" });
  }
});

/**
 * DELETE /api/admin/invoices/:id
 * Apaga fatura e respetivos itens
 */
router.delete("/admin/invoices/:id", async (req, res) => {
  try {
    await assertAdminFromHeader(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });

    await sql/*sql*/`DELETE FROM energy_invoice_items WHERE invoice_id = ${id}`;
    await sql/*sql*/`DELETE FROM energy_invoices WHERE id = ${id}`;

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /admin/invoices/:id:", e);
    res.status(500).json({ error: "Erro ao eliminar fatura (admin)" });
  }
});

export default router;
