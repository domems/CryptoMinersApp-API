// controllers/minersAdmin.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || req.query.limit || 10)));
  const offset = Number.isFinite(Number(req.query.offset))
    ? Math.max(0, Number(req.query.offset))
    : (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

function parseCoin(req) {
  const coin = String(req.query.coin || "").trim().toUpperCase();
  return coin === "BTC" || coin === "LTC" ? coin : null;
}

const ORDER_BY_RECENTE = sql`COALESCE(created_at, data_registo, CURRENT_TIMESTAMP) DESC`;

export async function listarMinersPorEmail(req, res) {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Parâmetro 'email' é obrigatório." });

    const coin = parseCoin(req);
    const { page, pageSize, offset, limit } = parsePaging(req);

    const userId = await resolveUserIdByEmail(email);
    const whereCoin = coin ? sql`AND UPPER(coin) = ${coin}` : sql``;

    const [items, totalRow] = await Promise.all([
      sql`
        SELECT *
        FROM miners
        WHERE user_id = ${userId}
        ${whereCoin}
        ORDER BY ${ORDER_BY_RECENTE}
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM miners
        WHERE user_id = ${userId}
        ${whereCoin}
      `,
    ]);

    return res.json({
      items,
      total: totalRow?.[0]?.total ?? items.length,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("listarMinersPorEmail:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || "Erro ao listar miners por email." });
  }
}

export async function listarTodasAsMiners(req, res) {
  try {
    const coin = parseCoin(req);
    const { page, pageSize, offset, limit } = parsePaging(req);

    const whereCoin = coin ? sql`WHERE UPPER(coin) = ${coin}` : sql``;

    const [items, totalRow] = await Promise.all([
      sql`
        SELECT *
        FROM miners
        ${whereCoin}
        ORDER BY ${ORDER_BY_RECENTE}
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM miners
        ${whereCoin}
      `,
    ]);

    return res.json({
      items,
      total: totalRow?.[0]?.total ?? items.length,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("listarTodasAsMiners:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || "Erro ao listar todas as miners." });
  }
}
