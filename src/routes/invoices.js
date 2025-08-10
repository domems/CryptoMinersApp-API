import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/** Lista meses com subtotal
 * GET /api/invoices?userId=...&includeCurrent=1
 * Retorna [{ year, month, subtotal_eur, status }]
 *  - meses fechados: vêm de miner_monthly_usage (status='fechada')
 *  - mês atual (opcional): calculado em curso (status='em_curso')
 */
router.get("/", async (req, res) => {
  const { userId, includeCurrent } = req.query;
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });

  try {
    const closed = await sql/*sql*/`
      SELECT year, month, ROUND(SUM(amount_eur)::numeric, 2) AS subtotal_eur, 'fechada' AS status
      FROM miner_monthly_usage
      WHERE user_id = ${userId}
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `;

    if (String(includeCurrent) === "1") {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;

      const [current] = await sql/*sql*/`
        SELECT
          ROUND(SUM(COALESCE(horas_online,0) * COALESCE(consumo_kw_hora,0) * COALESCE(preco_kw,0))::numeric, 2)
          AS subtotal_eur
        FROM miners
        WHERE user_id = ${userId}
      `;
      const subtotal = Number(current?.subtotal_eur || 0);
      // coloca no topo; não tem id, só ano/mês
      closed.unshift({ year, month, subtotal_eur: subtotal, status: "em_curso" });
    }

    res.json(closed);
  } catch (e) {
    console.error("invoices list:", e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/** Linhas de mês fechado
 * GET /api/invoices/:year/:month/items?userId=...
 */
router.get("/:year(\\d{4})/:month(\\d{1,2})/items", async (req, res) => {
  const { userId } = req.query;
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });

  try {
    const rows = await sql/*sql*/`
      SELECT miner_id, miner_nome, horas_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur
      FROM miner_monthly_usage
      WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
      ORDER BY miner_nome
    `;
    res.json(rows);
  } catch (e) {
    console.error("closed items:", e);
    res.status(500).json({ error: "Erro ao listar itens" });
  }
});

/** Linhas da fatura em curso (não gravadas)
 * GET /api/invoices/current/items?userId=...
 */
router.get("/current/items", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });

  try {
    const miners = await sql/*sql*/`
      SELECT id, nome, COALESCE(horas_online,0) AS horas_online,
             COALESCE(preco_kw,0) AS preco_kw,
             COALESCE(consumo_kw_hora,0) AS consumo_kw_hora
      FROM miners
      WHERE user_id = ${userId}
    `;

    const items = miners.map((m) => {
      const hours = Number(m.horas_online || 0);
      const kwh = +(hours * Number(m.consumo_kw_hora || 0)).toFixed(3);
      const amount = +(kwh * Number(m.preco_kw || 0)).toFixed(2);
      return {
        miner_id: m.id,
        miner_nome: m.nome || `Miner#${m.id}`,
        hours_online: hours,
        kwh_used: kwh,
        preco_kw: Number(m.preco_kw),
        consumo_kw_hora: Number(m.consumo_kw_hora),
        amount_eur: amount,
      };
    });

    res.json(items);
  } catch (e) {
    console.error("current items:", e);
    res.status(500).json({ error: "Erro ao calcular itens em curso" });
  }
});

export default router;
