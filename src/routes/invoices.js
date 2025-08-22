import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/** helpers de datas */
function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/**
 * GET /api/invoices?userId=...&includeCurrent=1
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

      // (lista resumida para o cartão de "em curso"; no detalhe faremos outra query)
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
          amount_eur: amount
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
 * - em curso:   /api/invoices/detail?userId=...&current=1
 * - fechada:    /api/invoices/detail?userId=...&year=YYYY&month=M
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

      // ⬇️ agora traz também modelo e hash_rate e já ordena por worker_name
      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
          COALESCE(worker_name, '')                    AS worker_name,
          COALESCE(modelo, '')                         AS modelo,
          COALESCE(hash_rate, '')                      AS hash_rate,
          COALESCE(total_horas_online,0)               AS hours_online,
          COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
          COALESCE(preco_kw,0)                         AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY
          CASE WHEN NULLIF(worker_name,'') IS NULL THEN 1 ELSE 0 END,
          LOWER(COALESCE(NULLIF(worker_name,''), nome, CONCAT('Miner#', id::text))),
          id ASC
      `;

      const items = miners.map((r) => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);
        const worker = String(r.worker_name || "").trim() || null;
        const modelo = String(r.modelo || "").trim() || null;
        const hashRate = String(r.hash_rate || "").trim() || null;

        return {
          miner_id: r.id,
          miner_nome: String(r.miner_nome),
          worker_name: worker,
          modelo,
          hash_rate: hashRate,
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
          invoice_id: existingId,
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

    // ⬇️ junta a tabela miners p/ worker_name, modelo e hash_rate e ordena por worker
    const items = await sql/*sql*/`
      SELECT 
        eii.miner_id,
        eii.miner_nome,
        COALESCE(eii.hours_online,0)     AS hours_online,
        COALESCE(eii.kwh_used,0)         AS kwh_used,
        COALESCE(eii.preco_kw,0)         AS preco_kw,
        COALESCE(eii.consumo_kw_hora,0)  AS consumo_kw_hora,
        COALESCE(eii.amount_eur,0)       AS amount_eur,
        COALESCE(m.worker_name, '')      AS worker_name,
        COALESCE(m.modelo, '')           AS modelo,
        COALESCE(m.hash_rate, '')        AS hash_rate
      FROM energy_invoice_items eii
      LEFT JOIN miners m ON m.id = eii.miner_id
      WHERE eii.invoice_id = ${inv.id}
      ORDER BY
        CASE WHEN NULLIF(m.worker_name,'') IS NULL THEN 1 ELSE 0 END,
        LOWER(COALESCE(NULLIF(m.worker_name,''), eii.miner_nome)),
        eii.miner_id ASC
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
        worker_name: (String(r.worker_name || "").trim() || null),
        modelo: (String(r.modelo || "").trim() || null),
        hash_rate: (String(r.hash_rate || "").trim() || null),
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
      SET subtotal_amount = ${+subtotal.toFixed(2)}, status = 'pendente', currency_code = 'USD'
      WHERE id = ${invoiceId}
    `;

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

/**
 * GET /api/invoices/status?invoiceId=123
 */
router.get("/invoices/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT id, status, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    res.json({
      ok: true,
      invoice: { id: Number(inv.id), status: String(inv.status), subtotal_amount: Number(inv.subtotal_amount) }
    });
  } catch (e) {
    console.error("GET /invoices/status:", e);
    res.status(500).json({ error: "Erro ao consultar estado da fatura" });
  }
});

export default router;
