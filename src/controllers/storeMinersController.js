// controllers/storeMinersController.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

// --- helpers ---
function parseBool(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
  return undefined;
}

function buildFilters({ search, coin, exibicao }) {
  const filters = [];

  // termos de pesquisa (multi-termo, cada termo tem de aparecer numa das colunas)
  const terms = String(search || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  for (const term of terms) {
    const pattern = `%${term}%`;
    filters.push(
      sql`AND (nome ILIKE ${pattern} OR modelo ILIKE ${pattern} OR coin ILIKE ${pattern} OR descricao ILIKE ${pattern})`
      // se quiseres incluir hash_rate (texto):  OR hash_rate ILIKE ${pattern}
    );
  }

  if (coin && String(coin).trim()) {
    filters.push(sql`AND coin = ${String(coin).trim().toUpperCase()}`);
  }

  const exib = parseBool(exibicao);
  if (typeof exib === "boolean") {
    filters.push(sql`AND em_exibicao = ${exib}`);
  }

  const filterSql = filters.reduce((acc, frag) => sql`${acc} ${frag}`, sql``);
  return { filterSql };
}

/** Conversor decimal robusto:
 *  - aceita number direto (não mexe)
 *  - aceita strings "3.57", "3,57", "1.234,56", "1,234.56"
 *  - assume que o ÚLTIMO separador (.,) é o decimal e remove o restante como milhares
 */
export function parseDecimalFlexible(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  let s = String(v).trim().replace(/\s+/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    const decSep = lastComma > lastDot ? "," : ".";
    const thouSep = decSep === "," ? "\\." : ",";
    // remove milhares e troca decimal por ponto
    s = s.replace(new RegExp(thouSep, "g"), "");
    s = s.replace(decSep, ".");
  } else if (hasComma) {
    // "3,57" ou "1,234" -> supomos vírgula decimal; remove pontos só se existirem (milhares)
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // só dígitos e/ou ponto -> já está OK
    // NÃO remover o ponto decimal!
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** GET /api/store-miners?q=&search=&coin=&exibicao=true&limit=10&offset=0 */
export async function getStoreMiners(req, res) {
  try {
    const { q, search, coin, exibicao, limit = 10, offset = 0 } = req.query;

    const _limit = Math.min(Number(limit) || 10, 50);
    const _offset = Math.max(Number(offset) || 0, 0);

    const searchParam = (typeof q === "string" && q.length ? q : search) || "";
    const { filterSql } = buildFilters({ search: searchParam, coin, exibicao });

    const rows = await sql`
      SELECT *
      FROM store_miners
      WHERE 1=1
      ${filterSql}
      ORDER BY created_at DESC NULLS LAST
      LIMIT ${_limit} OFFSET ${_offset}
    `;

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM store_miners
      WHERE 1=1
      ${filterSql}
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

    if (!nome || !modelo || consumo_kw == null || preco == null) {
      return res
        .status(400)
        .json({ error: "Preencha Nome, Modelo, Consumo kW e Preço." });
    }

    const toNum = (v) => (v === null || v === undefined || v === "" ? null : parseDecimalFlexible(v));
    const consumo = toNum(consumo_kw);
    const price = toNum(preco);
    const qnt = Number(quantidade ?? 1);

    if (!Number.isFinite(consumo) || !Number.isFinite(price)) {
      return res
        .status(400)
        .json({ error: "Consumo kW e Preço devem ser números válidos." });
    }

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
      coin,
      em_exibicao,
    } = req.body;

    if (!nome || !modelo || consumo_kw == null || preco == null) {
      return res
        .status(400)
        .json({ error: "Preencha Nome, Modelo, Consumo kW e Preço." });
    }

    const toNum = (v) => (v === null || v === undefined || v === "" ? null : parseDecimalFlexible(v));
    const consumo = toNum(consumo_kw);
    const price = toNum(preco);
    const qnt = Number(quantidade ?? 1);

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

// ====== Atribuir a utilizador ======

// Gera uma lista de worker_names a partir de padrão e quantidade
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
      worker_pattern,
      nome,
      modelo,
      hash_rate,
      consumo_kw_hora,
      preco_kw,
      coin,
      pool,
      api_key,
      secret_key, // <<< LÊ DO BODY
    } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email é obrigatório." });
    }

    // opcional: força pools válidas
    const ALLOWED_POOLS = new Set(["ViaBTC", "LiteCoinPool", "Binance", "F2Pool", "MiningDutch"]);
    const usePool = pool && ALLOWED_POOLS.has(pool) ? pool : null;

    // Clerk
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

    // Loja
    const [sm] = await sql`SELECT * FROM store_miners WHERE id = ${id} LIMIT 1;`;
    if (!sm) return res.status(404).json({ error: "Máquina da loja não encontrada." });

    // Defaults + overrides
    const baseNome   = (nome ?? sm.nome) || "Miner";
    const useModelo  = (modelo ?? sm.modelo) || null;
    const useHash    = (hash_rate ?? sm.hash_rate) || null;

    const useConsumo = parseDecimalFlexible(consumo_kw_hora ?? sm.consumo_kw);
    const usePreco   = parseDecimalFlexible(preco_kw);

    const useCoin    = (coin || sm.coin || null);
    const useApiKey  = api_key || null;

    // Regras: Binance precisa de api+secret; outras não guardam secret
    const useSecretKey = usePool === "Binance" ? (secret_key || null) : null;

    if (!Number.isFinite(useConsumo) || !Number.isFinite(usePreco)) {
      return res.status(400).json({ error: "Valores numéricos inválidos (consumo/preço)." });
    }

    if (usePool === "Binance" && (!useApiKey || !useSecretKey)) {
      return res.status(400).json({ error: "Para Binance, api_key e secret_key são obrigatórias." });
    }

    const qty = Math.max(1, Number(quantity) || 1);
    const workers = generateWorkerList(worker_pattern, qty);

    let created = 0;
    const failed = [];

    for (let i = 0; i < qty; i++) {
      const worker_name = workers[i];
      const nomeSeq = `${baseNome}${qty > 1 ? ` #${String(i + 1).padStart(2, "0")}` : ""}`;

      try {
        if (worker_name) {
          const [dup] = await sql`
            SELECT 1 FROM miners
            WHERE user_id = ${user_id}
              AND modelo   = ${useModelo}
              AND coin     = ${useCoin}
              AND worker_name = ${worker_name}
            LIMIT 1
          `;
          if (dup) { failed.push({ index: i, reason: "duplicate" }); continue; }
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
            ${useApiKey}, ${useSecretKey},   -- <<< DEIXA DE SER NULL
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

