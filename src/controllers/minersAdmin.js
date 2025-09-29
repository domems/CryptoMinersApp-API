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

function parseBool(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (["1","true","t","yes","y","on"].includes(s)) return true;
  if (["0","false","f","no","n","off"].includes(s)) return false;
  return undefined;
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

    // Tenta enriquecer com owner_email (não explode se Clerk falhar)
    const miner = rows[0];
    let owner_email = null;
    try {
      // Se tiveres uma função resolveEmailByUserId, usa-a aqui.
      // Como só temos resolveUserIdByEmail (email->id), não dá para inverter sem uma API extra.
      // Devolvemos só user_id e owner_email = null. (O UI mostra "Current owner" só se vier)
      owner_email = null;
    } catch { /* ignore */ }

    res.json({ ...miner, owner_email });
  } catch (err) {
    console.error("obterMinerPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao obter miner." });
  }
}

// PATCH /api/admin/miners/:id
export async function patchMinerPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    // Confirma que existe
    const exists = await sql/*sql*/`SELECT id, user_id, pool, api_key, secret_key FROM miners WHERE id = ${id} LIMIT 1`;
    if (!(Array.isArray(exists) ? exists.length : exists?.rows?.length)) {
      return res.status(404).json({ error: "Miner não encontrada." });
    }
    const currentRow = Array.isArray(exists) ? exists[0] : exists.rows[0];

    // Helpers
    const normStr = (v) => {
      if (v === undefined) return undefined;      // não enviado
      if (v === null) return null;                // limpar
      const s = String(v).trim();
      return s === "" ? null : s;
    };
    const normDec = (v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      let s = String(v).trim().replace(/\s+/g, "");
      const hasComma = s.includes(",");
      const hasDot   = s.includes(".");
      if (hasComma && hasDot) s = s.replace(/\./g, "").replace(/,/g, ".");
      else if (hasComma)      s = s.replace(/,/g, ".");
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    // Extrai body
    let {
      nome, modelo, hash_rate, preco_kw, consumo_kw_hora,
      worker_name, api_key, secret_key, coin, pool,
      locked, // pode vir do admin
      user_email, owner_email, email, // <<< NOVO: aceitar qualquer um destes
    } = req.body || {};

    // Validações mínimas e normalizações
    if (nome !== undefined) {
      nome = normStr(nome);
      if (nome === null) return res.status(400).json({ error: "Campo 'nome' não pode ser vazio." });
    }
    modelo          = normStr(modelo);
    worker_name     = normStr(worker_name);
    api_key         = normStr(api_key);
    secret_key      = normStr(secret_key); // pode ser null para limpar

    // NUMERIC
    preco_kw        = normDec(preco_kw);
    consumo_kw_hora = normDec(consumo_kw_hora);

    // hash_rate: TEXT no DB → trata como string
    if (hash_rate !== undefined) {
      hash_rate = hash_rate == null ? null : String(hash_rate).trim();
      if (hash_rate === "") hash_rate = null;
    }

    // Whitelists
    if (coin !== undefined && coin !== null) {
      coin = String(coin).toUpperCase().trim();
      if (!COIN_WHITELIST.includes(coin)) return res.status(400).json({ error: "Moeda inválida." });
    } else if (coin === null) {
      // permitir limpar
    }

    const POOL_WHITELIST = ["ViaBTC", "LiteCoinPool", "Binance", "F2Pool", "MiningDutch"];
    if (pool !== undefined && pool !== null) {
      pool = String(pool).trim();
      if (!POOL_WHITELIST.includes(pool)) return res.status(400).json({ error: "Pool inválida." });
    } else if (pool === null) {
      // permitir limpar
    }

    // Verifica se as colunas 'updated_at' e 'locked' existem
    const [{ exists: hasUpdatedAt }] = await sql/*sql*/`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'miners' AND column_name = 'updated_at'
      ) AS exists;
    `;
    const [{ exists: hasLocked }] = await sql/*sql*/`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'miners' AND column_name = 'locked'
      ) AS exists;
    `;

    // Validação Binance (considera valores finais)
    const willBePool = pool !== undefined ? pool : undefined;
    const willBeApi  = api_key !== undefined ? api_key : undefined;
    const willBeSec  = secret_key !== undefined ? secret_key : undefined;

    if ((willBePool === "Binance") || (willBeApi !== undefined) || (willBeSec !== undefined)) {
      const finalPool = willBePool ?? currentRow?.pool ?? null;
      const finalApi  = willBeApi  !== undefined ? willBeApi  : (currentRow?.api_key ?? null);
      const finalSec  = willBeSec  !== undefined ? willBeSec  : (currentRow?.secret_key ?? null);

      if (finalPool === "Binance" && (!finalApi || !finalSec)) {
        return res.status(400).json({ error: "Para Binance, 'api_key' e 'secret_key' são obrigatórias." });
      }
    }

    // Reatribuição de dono via e-mail (Clerk)
    let newUserId = undefined;
    const targetEmail = [user_email, owner_email, email].map(v => (v ?? "")).find(v => String(v).trim() !== "");
    if (targetEmail) {
      try {
        newUserId = await resolveUserIdByEmail(String(targetEmail).trim().toLowerCase());
      } catch (e) {
        const status = e?.status && e.status !== 200 ? e.status : 502;
        const msg =
          e?.status === 404
            ? "Utilizador não encontrado (Clerk)."
            : e?.status === 401 || e?.status === 403
            ? "Falha na verificação com a Clerk (credenciais)."
            : e?.message || "Erro na Clerk API.";
        return res.status(status).json({ error: msg });
      }
    }

    // Constrói dinamicamente o SET evitando colunas inexistentes e vírgulas a mais
    const setParts = [];
    setParts.push(sql`nome = COALESCE(${nome ?? null}, nome)`);
    setParts.push(sql`modelo = COALESCE(${modelo ?? null}, modelo)`);
    setParts.push(sql`hash_rate = COALESCE(${hash_rate ?? null}, hash_rate)`);
    setParts.push(sql`preco_kw = COALESCE(${preco_kw ?? null}, preco_kw)`);
    setParts.push(sql`consumo_kw_hora = COALESCE(${consumo_kw_hora ?? null}, consumo_kw_hora)`);
    setParts.push(sql`worker_name = COALESCE(${worker_name ?? null}, worker_name)`);
    setParts.push(sql`api_key = COALESCE(${api_key ?? null}, api_key)`);
    setParts.push(sql`secret_key = COALESCE(${secret_key ?? null}, secret_key)`);
    setParts.push(sql`coin = COALESCE(${coin ?? null}, coin)`);
    setParts.push(sql`pool = COALESCE(${pool ?? null}, pool)`);
    if (newUserId !== undefined) {
      setParts.push(sql`user_id = ${newUserId}`);
    }

    const lockedParsed = parseBool(locked);
    if (hasLocked && lockedParsed !== undefined) {
      setParts.push(sql`locked = ${lockedParsed}`);
    }
    if (hasUpdatedAt) {
      setParts.push(sql`updated_at = NOW()`);
    }

    const setSql = setParts.reduce((acc, frag, idx) => (idx === 0 ? sql`${frag}` : sql`${acc}, ${frag}`), sql``);

    const [updated] = await sql/*sql*/`
      UPDATE miners
      SET ${setSql}
      WHERE id = ${id}
      RETURNING *;
    `;

    if (!updated) return res.status(404).json({ error: "Miner não encontrada." });

    // Opcional: devolve owner_email se tens maneira server-side de o obter. Mantemos null.
    return res.json({ ok: true, miner: { ...updated, owner_email: null } });
  } catch (err) {
    console.error("patchMinerPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao atualizar miner." });
  }
}
