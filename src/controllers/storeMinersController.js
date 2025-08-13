// controllers/storeMinersController.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

/** Constrói WHERE dinâmico de forma segura */
// helpers no topo (antes das funções)
function parseBool(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
  return undefined;
}

/** Constrói WHERE dinâmico de forma segura (multi-termo, case-insensitive) */
function buildWhere({ search, coin, exibicao }) {
  const parts = [];

  // — Pesquisa multi-termo
  if (search && String(search).trim()) {
    const terms = String(search).trim().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const pattern = `%${term}%`;
      // cada termo tem de existir numa das colunas (OR); todos os termos são AND entre si
      parts.push(
        sql`(nome ILIKE ${pattern} OR modelo ILIKE ${pattern} OR coin ILIKE ${pattern} OR descricao ILIKE ${pattern})`
      );
    }
  }

  // — Filtro coin (normaliza para uppercase)
  if (coin && String(coin).trim()) {
    parts.push(sql`coin = ${String(coin).trim().toUpperCase()}`);
  }

  // — Filtro em_exibicao (aceita true/false/1/0/on/off)
  const exib = parseBool(exibicao);
  if (typeof exib === "boolean") {
    parts.push(sql`em_exibicao = ${exib}`);
  }

  if (parts.length === 0) return sql``;
  return sql`WHERE ${sql.join(parts, sql` AND `)}`;
}


/** GET /api/store-miners?q=&search=&coin=&exibicao=true&limit=10&offset=0 */
export async function getStoreMiners(req, res) {
  try {
    const { q, search, coin, exibicao, limit = 10, offset = 0 } = req.query;

    const _limit = Math.min(Number(limit) || 10, 50);
    const _offset = Math.max(Number(offset) || 0, 0);

    // usa q ou search (qualquer um serve)
    const searchParam = (typeof q === "string" && q.length ? q : search) || "";

    const where = buildWhere({ search: searchParam, coin, exibicao });

    const rows = await sql`
      SELECT *
      FROM store_miners
      ${where}
      ORDER BY created_at DESC NULLS LAST
      LIMIT ${_limit} OFFSET ${_offset}
    `;

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM store_miners
      ${where}
    `;

    res.json({
      items: rows,
      total: count,
      hasMore: _offset + rows.length < count,
      nextOffset: _offset + rows.length,
    });
  } catch (err) {
    console.error("Erro ao buscar máquinas da loja:", err);
    res.status(500).json({ error: "Erro ao buscar máquinas da loja." });
  }
}


/** POST /api/store-miners */
export async function createStoreMiner(req, res) {
  try {
    const {
      nome,
      modelo,
      hash_rate,
      consumo_kw,
      preco,
      quantidade,
      descricao,
      imagem_url,
      coin,
      em_exibicao,
    } = req.body;

    // Obrigatórios mínimos p/ tua tabela
    if (!nome || !modelo || consumo_kw == null || preco == null) {
      return res
        .status(400)
        .json({ error: "Preencha Nome, Modelo, Consumo kW e Preço." });
    }

    // Números
    const toNum = (v) =>
      v === null || v === undefined || v === ""
        ? null
        : Number(String(v).replace(",", "."));
    const consumo = toNum(consumo_kw);
    const price = toNum(preco);
    const qnt = Number(quantidade ?? 1);

    if (!Number.isFinite(consumo) || !Number.isFinite(price)) {
      return res
        .status(400)
        .json({ error: "Consumo kW e Preço devem ser números válidos." });
    }

    // Default de coin se não vier: 'BTC'
    const coinSafe =
      (typeof coin === "string" && coin.trim() && coin.trim().toUpperCase()) ||
      "BTC";

    const [row] = await sql`
      INSERT INTO store_miners (
        nome, modelo, hash_rate, consumo_kw, preco, quantidade, descricao, imagem_url, coin, em_exibicao
      ) VALUES (
        ${nome}, ${modelo}, ${hash_rate ?? ""}, ${consumo}, ${price},
        ${Number.isFinite(qnt) ? qnt : 1},
        ${descricao ?? ""}, ${imagem_url ?? ""}, ${coinSafe}, ${!!em_exibicao}
      )
      RETURNING *;
    `;

    res.status(201).json(row);
  } catch (err) {
    console.error("Erro ao criar máquina da loja:", err);
    res.status(500).json({ error: "Erro ao criar máquina da loja." });
  }
}

/** PUT /api/store-miners/:id */
export async function updateStoreMiner(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID em falta." });

    const {
      nome,
      modelo,
      hash_rate,
      consumo_kw,
      preco,
      quantidade,
      descricao,
      imagem_url,
      coin, // pode não vir: se não vier, mantém o valor existente
      em_exibicao,
    } = req.body;

    if (!nome || !modelo || consumo_kw == null || preco == null) {
      return res
        .status(400)
        .json({ error: "Preencha Nome, Modelo, Consumo kW e Preço." });
    }

    const toNum = (v) =>
      v === null || v === undefined || v === ""
        ? null
        : Number(String(v).replace(",", "."));
    const consumo = toNum(consumo_kw);
    const price = toNum(preco);
    const qnt = Number(quantidade ?? 1);

    // coin opcional no update: normaliza se vier, caso contrário deixa a existente
    const coinNormalized =
      typeof coin === "string" && coin.trim()
        ? coin.trim().toUpperCase()
        : null;

    const [row] = await sql`
      UPDATE store_miners
      SET
        nome         = ${nome},
        modelo       = ${modelo},
        hash_rate    = ${hash_rate ?? ""}, 
        consumo_kw   = ${consumo},
        preco        = ${price},
        quantidade   = ${Number.isFinite(qnt) ? qnt : 1},
        descricao    = ${descricao ?? ""},
        imagem_url   = ${imagem_url ?? ""},
        coin         = COALESCE(NULLIF(${coinNormalized}, ''), coin),
        em_exibicao  = ${!!em_exibicao},
        updated_at   = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;

    if (!row) return res.status(404).json({ error: "Máquina não encontrada." });

    res.json(row);
  } catch (err) {
    console.error("Erro ao atualizar máquina da loja:", err);
    res.status(500).json({ error: "Erro ao atualizar máquina da loja." });
  }
}

/** DELETE /api/store-miners/:id */
export async function deleteStoreMiner(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID em falta." });

    const [row] = await sql`DELETE FROM store_miners WHERE id = ${id} RETURNING id;`;
    if (!row) return res.status(404).json({ error: "Máquina não encontrada." });

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao apagar máquina da loja:", err);
    res.status(500).json({ error: "Erro ao apagar máquina da loja." });
  }
}


// util
const normalizeDecimal = (v) =>
  v === null || v === undefined || v === "" ? null : Number(String(v).trim().replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));

function generateWorkerList(input, qty) {
  const trimmed = String(input || "").trim();
  qty = Math.max(1, Number(qty) || 1);
  if (!trimmed) return Array.from({ length: qty }, () => null);

  const hasDot = trimmed.includes(".");
  const isDigitsOnly = /^[0-9]+$/.test(trimmed);

  if (!hasDot && isDigitsOnly) {
    const width = trimmed.length;
    const start = parseInt(trimmed, 10);
    return Array.from({ length: qty }, (_, i) => String(start + i).padStart(width, "0"));
  }

  if (hasDot) {
    const [acc, suffix = ""] = trimmed.split(".", 2);
    const numericSuffix = /^[0-9]+$/.test(suffix);
    if (numericSuffix) {
      const width = suffix.length;
      const start = parseInt(suffix, 10);
      return Array.from({ length: qty }, (_, i) => `${acc}.${String(start + i).padStart(width, "0")}`);
    }
    if (qty === 1) return [trimmed];
    return Array.from({ length: qty }, (_, i) => `${trimmed}.${String(i + 1).padStart(3, "0")}`);
  }

  return Array.from({ length: qty }, (_, i) => `${trimmed}.${String(i + 1).padStart(3, "0")}`);
}

// POST /api/store-miners/:id/assign
export async function assignStoreMinerToUser(req, res) {
  try {
    const { id } = req.params;
    const {
      email,
      quantity = 1,
      worker_pattern,         // ex: "acc.001", "acc", "001" (gera lista server-side)
      nome,                   // overrides opcionais
      modelo,
      hash_rate,
      consumo_kw_hora,
      preco_kw,
      coin,
      pool,
      api_key,
    } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email é obrigatório." });
    }

    // 1) Resolve user_id via Clerk
    let user_id;
    try {
      user_id = await resolveUserIdByEmail(email.trim());
    } catch (e) {
      const msg =
        e.status === 404
          ? "Utilizador não encontrado (Clerk)."
          : e.status === 401 || e.status === 403
          ? "Falha na verificação com a Clerk (credenciais)."
          : e.message || "Erro na Clerk API.";
      return res.status(e.status && e.status !== 200 ? e.status : 502).json({ error: msg });
    }

    // 2) Buscar máquina da loja
    const [sm] = await sql`SELECT * FROM store_miners WHERE id = ${id} LIMIT 1;`;
    if (!sm) return res.status(404).json({ error: "Máquina da loja não encontrada." });

    // 3) Defaults a partir da loja + overrides do body
    const baseNome   = (nome ?? sm.nome) || "Miner";
    const useModelo  = (modelo ?? sm.modelo) || null;
    const useHash    = (hash_rate ?? sm.hash_rate) || null;    // tua coluna é text
    const useConsumo = normalizeDecimal(consumo_kw_hora ?? sm.consumo_kw);
    const usePreco   = normalizeDecimal(preco_kw);
    const useCoin    = (coin || sm.coin || null);
    const usePool    = pool || null;
    const useApiKey  = api_key || null;

    const qty = Math.max(1, Number(quantity) || 1);
    const workers = generateWorkerList(worker_pattern, qty);

    let created = 0;
    const failed = []; // { index, reason }

    for (let i = 0; i < qty; i++) {
      const worker_name = workers[i];
      const nomeSeq = `${baseNome}${qty > 1 ? ` #${String(i + 1).padStart(2, "0")}` : ""}`;

      try {
        // Duplicados só se houver worker_name (se for null, permitimos múltiplos iguais)
        if (worker_name) {
          const [dup] = await sql`
            SELECT 1 FROM miners
            WHERE user_id = ${user_id}
              AND modelo   = ${useModelo}
              AND coin     = ${useCoin}
              AND worker_name = ${worker_name}
            LIMIT 1
          `;
          if (dup) {
            failed.push({ index: i, reason: "duplicate" });
            continue;
          }
        }

        await sql`
          INSERT INTO miners (
            user_id, nome, modelo, hash_rate, worker_name, status,
            preco_kw, consumo_kw_hora, created_at, total_horas_online,
            api_key, secret_key, coin, pool
          ) VALUES (
            ${user_id},
            ${nomeSeq}, ${useModelo}, ${useHash},
            ${worker_name || null},
            'offline',
            ${usePreco},
            ${useConsumo},
            NOW(),
            0,
            ${useApiKey}, NULL,
            ${useCoin},
            ${usePool}
          )
        `;
        created++;
      } catch (e) {
        console.error("assign/insert error:", e);
        failed.push({ index: i, reason: "db_error" });
      }
    }

    return res.status(created > 0 ? 201 : 400).json({ created, failed, total: qty });
  } catch (err) {
    console.error("Erro ao atribuir máquina ao utilizador:", err);
    return res.status(500).json({ error: "Erro ao atribuir máquina ao utilizador." });
  }
}


