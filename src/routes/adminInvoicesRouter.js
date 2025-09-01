import express from "express";
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

const router = express.Router();

/** Opcional: health para autodetecção no frontend */
router.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * GET /api/admin/invoices-feed?limit=10&offset=0&status=...
 * Lista global paginada (sem email). Não inclui linha "em_curso".
 */
router.get("/invoices-feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "10"), 10) || 10, 1), 50); // 1..50
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    let status = String(req.query.status || "").trim().toLowerCase();
    const allowed = new Set(["em_curso", "pendente", "aguarda_pagamento", "fechada", "pago"]);
    if (!allowed.has(status)) status = ""; // ignora inválidos

    const where = status ? sql`WHERE status = ${status}` : sql``;

    const items = await sql/*sql*/`
      SELECT id, user_id, year, month,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(status,'pendente') AS status,
             COALESCE(currency_code,'USD') AS currency_code
      FROM energy_invoices
      ${where}
      ORDER BY year DESC, month DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const mapped = items.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: Number(r.subtotal_amount),
      status: String(r.status),
      currency_code: String(r.currency_code || "USD"),
    }));

    const nextOffset = offset + mapped.length;
    const hasMore = mapped.length === limit;

    res.json({ items: mapped, nextOffset, hasMore });
  } catch (e) {
    console.error("GET /admin/invoices-feed:", e);
    res.status(500).json({ error: "Erro ao listar faturas (feed)" });
  }
});

/**
 * GET /api/admin/invoices-by-email?email=...&status=...
 * Lista faturas do cliente por email (inclui linha "em_curso" se status for vazio ou 'em_curso')
 */
router.get("/invoices-by-email", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    let status = String(req.query.status || "").trim().toLowerCase();

    if (!email) {
      // Sem email: o frontend já chama /invoices-feed; evita encadeamentos aqui
      return res.status(400).json({ error: "Parâmetro 'email' é obrigatório." });
    }

    const allowed = new Set(["em_curso", "pendente", "aguarda_pagamento", "fechada", "pago"]);
    if (!allowed.has(status)) status = ""; // ignora inválidos

    const userId = await resolveUserIdByEmail(email).catch(() => null);
    if (!userId) return res.json([]);

    // faturas guardadas
    const saved =
      status && status !== "em_curso"
        ? await sql/*sql*/`
            SELECT id, user_id, year, month,
                   COALESCE(subtotal_amount,0) AS subtotal_amount,
                   COALESCE(status,'pendente') AS status,
                   COALESCE(currency_code,'USD') AS currency_code
            FROM energy_invoices
            WHERE user_id = ${userId} AND status = ${status}
            ORDER BY year DESC, month DESC
          `
        : await sql/*sql*/`
            SELECT id, user_id, year, month,
                   COALESCE(subtotal_amount,0) AS subtotal_amount,
                   COALESCE(status,'pendente') AS status,
                   COALESCE(currency_code,'USD') AS currency_code
            FROM energy_invoices
            WHERE user_id = ${userId}
            ORDER BY year DESC, month DESC
          `;

    // linha "em_curso"
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
      return acc + hours * consumo * preco;
    }, 0).toFixed(2);

    const currencyRow = await sql/*sql*/`
      SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
      FROM energy_invoices
      WHERE user_id = ${userId}
    `;
    const currency_code = String(currencyRow?.[0]?.currency_code || "USD");

    const currentRow = {
      user_id: userId,
      year: y,
      month: m,
      subtotal_amount: subtotalCurrent,
      status: "em_curso",
      currency_code,
    };

    const mappedSaved = saved.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: Number(r.subtotal_amount),
      status: String(r.status),
      currency_code: String(r.currency_code || "USD"),
    }));

    const includeCurrent = !status || status === "em_curso";
    const payload = includeCurrent ? [currentRow, ...mappedSaved] : mappedSaved;

    res.json(payload);
  } catch (e) {
    console.error("GET /admin/invoices-by-email:", e);
    res.status(500).json({ error: "Erro ao listar faturas (admin)" });
  }
});

/**
 * POST /api/admin/invoices/close-now
 */
router.post("/invoices/close-now", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email em falta" });

    const userId = await resolveUserIdByEmail(email).catch(() => null);
    if (!userId) return res.status(404).json({ error: "Utilizador não encontrado" });

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const miners = await sql/*sql*/`
      SELECT
        id,
        COALESCE(nome, 'Miner#' || id::text)      AS miner_nome,
        COALESCE(total_horas_online,0)            AS hours_online,
        COALESCE(consumo_kw_hora,0)               AS consumo_kw_hora,
        COALESCE(preco_kw,0)                      AS preco_kw
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY id ASC
    `;

    let subtotal = 0;

    const inserted = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'USD')
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
          (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, pay_amount)
        VALUES
          (${invoiceId}, ${r.id}, ${r.miner_nome}, ${hours}, ${kwh}, ${preco}, ${consumo}, ${amount})
        ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
          miner_nome        = EXCLUDED.miner_nome,
          hours_online      = EXCLUDED.hours_online,
          kwh_used          = EXCLUDED.kwh_used,
          preco_kw          = EXCLUDED.preco_kw,
          consumo_kw_hora   = EXCLUDED.consumo_kw_hora,
          pay_amount        = EXCLUDED.pay_amount
      `;
    }

    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${+subtotal.toFixed(2)}, status = 'pendente', currency_code = 'USD'
      WHERE id = ${invoiceId}
    `;

    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = 0
      WHERE user_id = ${userId}
    `;

    res.json({
      ok: true,
      invoice: {
        id: invoiceId,
        year,
        month,
        status: "pendente",
        subtotal_amount: +subtotal.toFixed(2),
      },
    });
  } catch (e) {
    console.error("POST /admin/invoices/close-now:", e);
    res.status(500).json({ error: "Erro ao fechar fatura (admin)" });
  }
});

/**
 * GET /api/admin/invoices/:id
 */
router.get("/invoices/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });

    const [inv] = await sql/*sql*/`
      SELECT id, user_id, year, month, status,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(currency_code,'USD') AS currency_code
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
        currency_code: String(inv.currency_code || "USD"),
      },
    });
  } catch (e) {
    console.error("GET /admin/invoices/:id:", e);
    res.status(500).json({ error: "Erro ao obter fatura (admin)" });
  }
});

/**
 * PATCH /api/admin/invoices/:id
 */
router.patch("/invoices/:id", async (req, res) => {
  try {
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
 */
router.delete("/invoices/:id", async (req, res) => {
  try {
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
