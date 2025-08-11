// src/routes/invoices.js
import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/** helpers de datas (hora local do servidor; o cron mensal já usa Europe/Lisbon) */
function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 }; // 1..12
}

/**
 * GET /api/invoices?userId=...&includeCurrent=1
 * Lista faturas guardadas e, opcionalmente, junta a fatura "em_curso" (provisória)
 */
router.get("/invoices", async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    const includeCurrent = String(req.query.includeCurrent || "") === "1";
    if (!userId) return res.status(400).json({ error: "userId em falta" });

    const saved = await sql/*sql*/`
      SELECT year, month,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(status,'pendente') AS status,
             COALESCE(currency_code,'USD') AS currency_code
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;

    const rows = saved.map((r) => ({
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: Number(r.subtotal_amount),
      status: String(r.status),
      currency_code: String(r.currency_code || "USD"),
    }));

    if (includeCurrent) {
      const { year, month } = currentYearMonth();
      const [currencyRow] = await sql/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;

      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
          COALESCE(total_horas_online,0)               AS hours_online,
          COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
          COALESCE(preco_kw,0)                         AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY id ASC
      `;

      const items = miners.map((r) => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);
        return {
          miner_id: r.id,
          miner_nome: String(r.miner_nome),
          hours_online: hours,
          kwh_used: kwh,
          consumo_kw_hora: consumo,
          preco_kw: preco,
          amount_eur: amount, // legado: mantém o nome que a UI já consome
        };
      });

      const subtotal = +items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0).toFixed(2);

      rows.unshift({
        year,
        month,
        subtotal_amount: subtotal,
        status: "em_curso",
        currency_code: String(currencyRow?.currency_code || "USD"),
      });
    }

    res.json(rows);
  } catch (e) {
    console.error("GET /invoices:", e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/**
 * GET /api/invoices/detail
 * - Fatura em curso:  /api/invoices/detail?userId=...&current=1
 * - Fatura fechada:   /api/invoices/detail?userId=...&year=2025&month=7
 */
router.get("/invoices/detail", async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    const isCurrent = String(req.query.current || "") === "1";
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;

    if (!userId) return res.status(400).json({ error: "userId em falta" });

    if (isCurrent) {
      const { year: y, month: m } = currentYearMonth();

      // tenta achar fatura já criada (id) para este mês
      const existing = await sql/*sql*/`
        SELECT id
        FROM energy_invoices
        WHERE user_id = ${userId} AND year = ${y} AND month = ${m}
        LIMIT 1
      `;
      const existingId = existing.length ? Number(existing[0].id) : undefined;

      const [currencyRow] = await sql/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;

      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
          COALESCE(total_horas_online,0)               AS hours_online,
          COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
          COALESCE(preco_kw,0)                         AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY id ASC
      `;

      const items = miners.map((r) => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);
        return {
          miner_id: r.id,
          miner_nome: String(r.miner_nome),
          hours_online: hours,
          kwh_used: kwh,
          consumo_kw_hora: consumo,
          preco_kw: preco,
          amount_eur: amount,
        };
      });

      const subtotal = +items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0).toFixed(2);
      const total_kwh = +items.reduce((acc, it) => acc + Number(it.kwh_used || 0), 0).toFixed(3);

      return res.json({
        header: {
          invoice_id: existingId, // se já existe fatura criada para o mês, devolve o id
          year: y,
          month: m,
          status: "em_curso",
          subtotal_amount: subtotal,
          currency_code: String(currencyRow?.currency_code || "USD"),
          total_kwh,
        },
        items,
      });
    }

    if (!year || !month) {
      return res.status(400).json({ error: "year e month em falta" });
    }

    const [inv] = await sql/*sql*/`
      SELECT id, year, month,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(status,'pendente') AS status,
             COALESCE(currency_code,'USD') AS currency_code
      FROM energy_invoices
      WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const items = await sql/*sql*/`
      SELECT miner_id, miner_nome,
             COALESCE(hours_online,0)      AS hours_online,
             COALESCE(kwh_used,0)          AS kwh_used,
             COALESCE(preco_kw,0)          AS preco_kw,
             COALESCE(consumo_kw_hora,0)   AS consumo_kw_hora,
             COALESCE(amount_eur,0)        AS amount_eur
      FROM energy_invoice_items
      WHERE invoice_id = ${inv.id}
      ORDER BY miner_id ASC
    `;

    const total_kwh = +items.reduce((acc, it) => acc + Number(it.kwh_used || 0), 0).toFixed(3);

    return res.json({
      header: {
        invoice_id: Number(inv.id),
        year: Number(inv.year),
        month: Number(inv.month),
        status: String(inv.status),
        subtotal_amount: Number(inv.subtotal_amount),
        currency_code: String(inv.currency_code || "USD"),
        total_kwh,
      },
      items: items.map((r) => ({
        miner_id: r.miner_id,
        miner_nome: String(r.miner_nome),
        hours_online: Number(r.hours_online),
        kwh_used: Number(r.kwh_used),
        consumo_kw_hora: Number(r.consumo_kw_hora),
        preco_kw: Number(r.preco_kw),
        amount_eur: Number(r.amount_eur),
      })),
    });
  } catch (e) {
    console.error("GET /invoices/detail:", e);
    res.status(500).json({ error: "Erro ao obter fatura" });
  }
});

/**
 * POST /api/invoices/close-now
 * - fecha a fatura do mês corrente e grava itens
 */
router.post("/invoices/close-now", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "");
    if (!userId) return res.status(400).json({ error: "userId em falta" });

    const { year, month } = currentYearMonth();

    const miners = await sql/*sql*/`
      SELECT
        id,
        COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
        COALESCE(total_horas_online,0)               AS hours_online,
        COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
        COALESCE(preco_kw,0)                         AS preco_kw
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY id ASC
    `;

    let subtotal = 0;

    // cria/garante cabeçalho (default currency_code = 'USD')
    const inserted = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'USD')
      ON CONFLICT (user_id, year, month)
      DO UPDATE SET status = 'pendente'
      RETURNING id
    `;
    const invoiceId = inserted[0].id;

    // grava itens
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

    // atualiza subtotal
    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${+subtotal.toFixed(2)}, status = 'pendente', currency_code = 'USD'
      WHERE id = ${invoiceId}
    `;

    // reset horas
    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = 0
      WHERE user_id = ${userId}
    `;

    return res.json({
      ok: true,
      invoice: { id: invoiceId, year, month, status: "pendente", subtotal_amount: +subtotal.toFixed(2) }
    });
  } catch (e) {
    console.error("POST /invoices/close-now:", e);
    return res.status(500).json({ error: "Erro ao fechar fatura" });
  }
});

export default router;
