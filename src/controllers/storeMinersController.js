// controllers/storeMinersController.js
import { sql } from "../config/db.js";

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
