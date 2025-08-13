// controllers/storeMinersController.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

/** Constrói WHERE dinâmico de forma segura */
function buildWhere({ q, coin, exibicao }) {
  const parts = [];
  if (q && String(q).trim()) {
    const pattern = `%${String(q).trim()}%`;
    parts.push(sql`(nome ILIKE ${pattern} OR modelo ILIKE ${pattern} OR coin ILIKE ${pattern})`);
  }
  if (coin && String(coin).trim()) {
    parts.push(sql`coin = ${String(coin).trim().toUpperCase()}`);
  }
  if (typeof exibicao !== "undefined") {
    const flag = exibicao === true || exibicao === "true";
    parts.push(sql`em_exibicao = ${flag}`);
  }
  if (parts.length === 0) return sql``;
  return sql`WHERE ${sql.join(parts, sql` AND `)}`;
}

/** GET /api/store-miners?q=&coin=&exibicao=true&limit=10&offset=0 */
export async function getStoreMiners(req, res) {
  try {
    const { q, coin, exibicao, limit = 10, offset = 0 } = req.query;
    const _limit = Math.min(Number(limit) || 10, 50);
    const _offset = Math.max(Number(offset) || 0, 0);

    const where = buildWhere({ q, coin, exibicao });

    const rows = await sql`
      SELECT *
      FROM store_miners
      ${where}
      ORDER BY created_at DESC
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

// POST /api/store-miners/:id/assign
export async function assignStoreMinerToUser(req, res) {
  try {
    const { id } = req.params;
    const { email, worker_name, preco_kw, pool } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email é obrigatório." });
    }
    const emailNorm = email.trim();

    // 1) Resolver user_id via Clerk
    let userId;
    try {
      userId = await resolveUserIdByEmail(emailNorm);
    } catch (e) {
      // Mapeamento de erros da Clerk para HTTP do teu backend
      if (e.status === 404) {
        return res.status(404).json({ error: "Utilizador não encontrado (Clerk)." });
      }
      if (e.status === 401 || e.status === 403) {
        return res
          .status(502)
          .json({ error: "Falha na verificação com a Clerk (credenciais inválidas)." });
      }
      return res.status(502).json({ error: e.message || "Erro na Clerk API." });
    }

    // 2) Buscar a máquina da loja
    const [sm] = await sql`SELECT * FROM store_miners WHERE id = ${id} LIMIT 1;`;
    if (!sm) return res.status(404).json({ error: "Máquina da loja não encontrada." });

    // 3) Evitar duplicados: mesmo user + modelo + coin + worker_name (NULL = NULL)
    const [dup] = await sql`
      SELECT id FROM miners
      WHERE user_id = ${userId}
        AND modelo   = ${sm.modelo}
        AND coin     = ${sm.coin}
        AND (worker_name IS NOT DISTINCT FROM ${worker_name || null})
      LIMIT 1
    `;
    if (dup) {
      return res
        .status(409)
        .json({ error: "Este utilizador já tem uma mineradora igual (modelo/coin/worker)." });
    }

    // 4) Normalizar número opcional (preço kWh)
    const normalizeNumber = (v) =>
      v === null || v === undefined || v === "" ? null : Number(String(v).replace(",", "."));
    const precoKwNum = normalizeNumber(preco_kw);

    // 5) Inserir em miners (status offline por omissão)
    const [row] = await sql`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, worker_name, status,
        preco_kw, consumo_kw_hora, created_at, total_horas_online,
        api_key, secret_key, coin, pool
      ) VALUES (
        ${userId},
        ${sm.nome}, ${sm.modelo}, ${sm.hash_rate},
        ${worker_name || null},
        'offline',
        ${precoKwNum},
        ${sm.consumo_kw},
        NOW(),
        0,
        NULL, NULL,
        ${sm.coin},
        ${pool || null}
      )
      RETURNING *;
    `;

    return res.status(201).json(row);
  } catch (err) {
    console.error("Erro ao atribuir máquina ao utilizador:", err);
    return res.status(500).json({ error: "Erro ao atribuir máquina ao utilizador." });
  }
}

