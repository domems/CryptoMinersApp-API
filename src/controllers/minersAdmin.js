// src/controllers/minersAdmin.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

/* =========================
 * Helpers
 * ========================= */
function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || req.query.limit || 10)));
  const offset = Number.isFinite(Number(req.query.offset))
    ? Math.max(0, Number(req.query.offset))
    : (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

const COIN_WHITELIST = ["BTC","BCH","XEC","LTC","ETC","ZEC","DASH","CKB","HNS","KAS"];

function parseCoinQuery(req) {
  const coin = String(req.query.coin || "").trim().toUpperCase();
  return coin && COIN_WHITELIST.includes(coin) ? coin : null;
}

function normalizeDecimal(v) {
  if (v === undefined) return undefined; // não enviado
  if (v === null || v === "") return null; // limpar
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s+/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) s = s.replace(/\./g, "").replace(/,/g, ".");
  else if (hasComma) s = s.replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ORDER_BY_RECENTE = sql`COALESCE(created_at, CURRENT_TIMESTAMP) DESC, id DESC`;

/* =========================
 * Health
 * ========================= */
export async function ping(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
}

/* =========================
 * Listagens
 * ========================= */
export async function listarMinersPorEmail(req, res) {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Parâmetro 'email' é obrigatório." });

    const coin = parseCoinQuery(req);
    const { page, pageSize, offset, limit } = parsePaging(req);

    const userId = await resolveUserIdByEmail(email).catch(() => null);
    if (!userId) return res.json({ items: [], total: 0, page, pageSize });

    const whereCoin = coin ? sql`AND UPPER(coin) = ${coin}` : sql``;

    const [items, totalRow] = await Promise.all([
      sql/*sql*/`
        SELECT *
        FROM miners
        WHERE user_id = ${userId}
        ${whereCoin}
        ORDER BY ${ORDER_BY_RECENTE}
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql/*sql*/`
        SELECT COUNT(*)::int AS total
        FROM miners
        WHERE user_id = ${userId}
        ${whereCoin}
      `,
    ]);

    res.json({ items, total: totalRow?.[0]?.total ?? items.length, page, pageSize });
  } catch (err) {
    console.error("listarMinersPorEmail:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao listar miners por email." });
  }
}

export async function listarTodasAsMiners(req, res) {
  try {
    const coin = parseCoinQuery(req);
    const { page, pageSize, offset, limit } = parsePaging(req);
    const whereCoin = coin ? sql`WHERE UPPER(coin) = ${coin}` : sql``;

    const [items, totalRow] = await Promise.all([
      sql/*sql*/`
        SELECT *
        FROM miners
        ${whereCoin}
        ORDER BY ${ORDER_BY_RECENTE}
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql/*sql*/`
        SELECT COUNT(*)::int AS total
        FROM miners
        ${whereCoin}
      `,
    ]);

    res.json({ items, total: totalRow?.[0]?.total ?? items.length, page, pageSize });
  } catch (err) {
    console.error("listarTodasAsMiners:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao listar todas as miners." });
  }
}

/* =========================
 * Status
 * ========================= */
export async function obterStatusBatch(req, res) {
  try {
    const raw = String(req.query.ids || "").trim();
    const ids = raw ? raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.json([]);

    const MAX_IDS = 500;
    const idsCapped = ids.slice(0, MAX_IDS);

    const result = await sql.unsafe(
      `
      SELECT id, COALESCE(status, 'offline') AS status
      FROM miners
      WHERE id = ANY($1::int[])
      ORDER BY id ASC
      `,
      [idsCapped]
    );

    const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
    return res.json(rows.map((r) => ({ id: Number(r.id), status: String(r.status) })));
  } catch (err) {
    console.error("obterStatusBatch:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || "Erro ao obter status (batch)." });
  }
}

export async function obterStatusPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    const rows = await sql/*sql*/`
      SELECT id, COALESCE(status, 'offline') AS status
      FROM miners
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrada." });
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    console.error("obterStatusPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao obter status." });
  }
}

/* =========================
 * CRUD por ID (ecrã de edição)
 * ========================= */

// GET /api/admin/miners/:id
export async function obterMinerPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    const rows = await sql/*sql*/`
      SELECT *
      FROM miners
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrada." });
    res.json(rows[0]);
  } catch (err) {
    console.error("obterMinerPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao obter miner." });
  }
}

// PATCH/PUT /api/admin/miners/:id
export async function patchMinerPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const pickStr = (k) => {
      if (!has(k)) return undefined;
      const v = body[k];
      if (v === null) return null;
      if (typeof v === "string") {
        const s = v.trim();
        return s === "" ? null : s;
      }
      return v;
    };

    // strings
    const nome = pickStr("nome");
    const modelo = pickStr("modelo");
    const worker_name = pickStr("worker_name");
    const api_key = pickStr("api_key");

    // números
    const preco_kw = has("preco_kw") ? normalizeDecimal(body.preco_kw) : undefined;
    const consumo_kw_hora = has("consumo_kw_hora") ? normalizeDecimal(body.consumo_kw_hora) : undefined;

    // hash_rate é TEXT na BD → normalizar como string (ou null)
    let hash_rate = has("hash_rate") ? body.hash_rate : undefined;
    if (hash_rate !== undefined) {
      if (hash_rate === null || hash_rate === "") hash_rate = null;
      else hash_rate = String(hash_rate).trim();
    }

    // coin / pool
    let coin = pickStr("coin");
    if (coin !== undefined && coin !== null) {
      coin = String(coin).toUpperCase();
      if (!COIN_WHITELIST.includes(coin)) return res.status(400).json({ error: "Moeda inválida." });
    }
    let pool = pickStr("pool");
    if (pool !== undefined && pool !== null) {
      const P = String(pool);
      const POOL_WHITELIST = ["ViaBTC", "LiteCoinPool"];
      if (!POOL_WHITELIST.includes(P)) return res.status(400).json({ error: "Pool inválida." });
      pool = P;
    }

    // construir SET dinâmico
    const sets = [];
    const params = [];
    const add = (col, val) => {
      sets.push(`${col} = $${params.length + 1}`);
      params.push(val);
    };

    if (nome !== undefined) add("nome", nome);
    if (modelo !== undefined) add("modelo", modelo);
    if (hash_rate !== undefined) add("hash_rate", hash_rate);               // TEXT
    if (preco_kw !== undefined) add("preco_kw", preco_kw);                  // NUMERIC
    if (consumo_kw_hora !== undefined) add("consumo_kw_hora", consumo_kw_hora); // NUMERIC
    if (worker_name !== undefined) add("worker_name", worker_name);
    if (api_key !== undefined) add("api_key", api_key);
    if (coin !== undefined) add("coin", coin);
    if (pool !== undefined) add("pool", pool);

    if (sets.length === 0) {
      return res.status(400).json({ error: "Nada para atualizar." });
    }

    const q = `
      UPDATE miners
      SET ${sets.join(", ")}
      WHERE id = $${params.length + 1}
      RETURNING *
    `;
    const updated = await sql.unsafe(q, [...params, id]);
    const rows = Array.isArray(updated) ? updated : Array.isArray(updated?.rows) ? updated.rows : [];

    if (!rows?.length) return res.status(404).json({ error: "Miner não encontrada." });

    // opcional: log leve para debug
    // console.log("PATCH miners:", { id, setCols: sets.map(s => s.split(" = ")[0]) });

    res.json({ ok: true, miner: rows[0] });
  } catch (err) {
    console.error("patchMinerPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao atualizar miner." });
  }
}
