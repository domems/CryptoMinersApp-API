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
 * Lista faturas guardadas e, opcionalmente, junta a fatura "em_curso"
 */
router.get("/invoices", async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    const includeCurrent = String(req.query.includeCurrent || "") === "1";

    if (!userId) return res.status(400).json({ error: "userId em falta" });

    // 1) faturas armazenadas
    const saved = await sql/*sql*/`
      SELECT year, month, COALESCE(subtotal_eur,0) AS subtotal_eur,
             COALESCE(status,'pendente')           AS status
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY year DESC, month DESC
    `;

    const rows = saved.map(r => ({
      year: Number(r.year),
      month: Number(r.month),
      subtotal_eur: Number(r.subtotal_eur),
      status: String(r.status),
    }));

    // 2) fatura "em_curso" (calculada) — opcional
    if (includeCurrent) {
      const { year, month } = currentYearMonth();

      // calcula subtotal a partir das miners do utilizador
      // subtotal = Σ ( total_horas_online * consumo_kw_hora * preco_kw )
      const [agg] = await sql/*sql*/`
        SELECT
          COALESCE(SUM(
            COALESCE(total_horas_online,0) * COALESCE(consumo_kw_hora,0) * COALESCE(preco_kw,0)
          ), 0) AS subtotal
        FROM miners
        WHERE user_id = ${userId}
      `;

      const subtotal = Number(agg?.subtotal || 0);

      // só adiciona se existirem miners (ou se quiseres mostrar mesmo 0 €, mantém)
      rows.unshift({
        year,
        month,
        subtotal_eur: +subtotal.toFixed(2),
        status: "em_curso",
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
      // ————— Fatura provisória (em curso) —————
      const { year: y, month: m } = currentYearMonth();

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

      return res.json({
        header: {
          year: y,
          month: m,
          status: "em_curso",
          subtotal_eur: subtotal,
        },
        items,
      });
    }

    // ————— Fatura fechada (guardada) —————
    if (!year || !month) {
      return res.status(400).json({ error: "year e month em falta" });
    }

    const [inv] = await sql/*sql*/`
      SELECT id, year, month, COALESCE(subtotal_eur,0) AS subtotal_eur,
             COALESCE(status,'pendente') AS status
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

    return res.json({
      header: {
        year: Number(inv.year),
        month: Number(inv.month),
        status: String(inv.status),
        subtotal_eur: Number(inv.subtotal_eur),
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

export default router;
