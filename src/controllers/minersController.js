// src/controllers/minersController.js
import { sql } from "../config/db.js";

/** Admins autorizados (case-insensitive) */
const adminEmails = ["domems@gmail.com", "admin2@email.com"].map((e) =>
  String(e).trim().toLowerCase()
);

/** Converte "0,08" -> 0.08; "", undefined, null -> null; lança se for inválido */
function normalizeDecimal(input) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Valor numérico inválido: "${input}"`);
    return input;
  }
  const s = String(input).trim().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: "${input}"`);
  return n;
}

/** Construção dinâmica de SET para UPDATE */
function buildUpdateSet(fields) {
  const updates = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      updates.push(sql`${sql.ident(key)} = ${val}`);
    }
  }
  return updates;
}

/* ============================= CRIAR ============================= */

export const criarMiner = async (req, res) => {
  const {
    user_id,
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora,
    worker_name,
    api_key,
    secret_key,
    coin,
    pool,
  } = req.body || {};

  try {
    const nomeClean = String(nome || "").trim();
    if (!user_id || !nomeClean) {
      return res
        .status(400)
        .json({ error: "Campos obrigatórios em falta: user_id e nome." });
    }

    // Normaliza decimais (aceita vírgulas). Campos vazios ficam NULL.
    let hashRateNum = null;
    let precoKwNum = null;
    let consumoNum = null;
    try {
      hashRateNum = normalizeDecimal(hash_rate);
      precoKwNum = normalizeDecimal(preco_kw);
      consumoNum = normalizeDecimal(consumo_kw_hora);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const [novoMiner] = await sql`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status,
        worker_name, api_key, secret_key, coin, pool
      ) VALUES (
        ${user_id},
        ${nomeClean},
        ${modelo ? String(modelo).trim() : null},
        ${hashRateNum},
        ${precoKwNum},
        ${consumoNum},
        'offline',
        ${worker_name ? String(worker_name).trim() : null},
        ${api_key ? String(api_key).trim() : null},
        ${secret_key ? String(secret_key).trim() : null},
        ${coin ? String(coin).trim() : null},
        ${pool ? String(pool).trim() : null}
      )
      RETURNING *;
    `;

    res.status(201).json(novoMiner);
  } catch (err) {
    console.error("Erro ao criar miner:", err);
    res.status(500).json({ error: "Erro ao criar miner" });
  }
};

/* =================== ATUALIZAR (CLIENTE / CAMPOS LÓGICOS) =================== */
/** Atualiza apenas os campos enviados; todos são opcionais */
export const atualizarMinerComoCliente = async (req, res) => {
  const { id } = req.params;
  let { worker_name, api_key, coin, pool } = req.body || {};

  try {
    const updates = buildUpdateSet({
      worker_name: worker_name === undefined ? undefined : (worker_name || null),
      api_key: api_key === undefined ? undefined : (api_key || null), // agora opcional
      coin: coin === undefined ? undefined : (coin || null),
      pool: pool === undefined ? undefined : (pool || null),
    });

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    const [updatedMiner] = await sql`
      UPDATE miners
      SET ${sql.join(updates, sql`, `)}
      WHERE id = ${id}
      RETURNING *;
    `;

    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (cliente):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (cliente)" });
  }
};

/* =================== ATUALIZAR (ADMIN / CAMPOS TÉCNICOS) =================== */

export const atualizarMinerComoAdmin = async (req, res) => {
  const { id } = req.params;
  const userEmail = String(req.header("x-user-email") || "").toLowerCase();

  try {
    if (!adminEmails.includes(userEmail)) {
      return res
        .status(403)
        .json({ error: "Acesso negado. Apenas admins podem editar." });
    }

    let { nome, modelo, hash_rate, preco_kw, consumo_kw_hora } = req.body || {};

    // Valida e normaliza:
    // - Se 'nome' vier definido, não pode ser vazio (coluna NOT NULL).
    if (nome !== undefined) {
      const clean = String(nome).trim();
      if (!clean) {
        return res.status(400).json({ error: "Campo 'nome' não pode ser vazio." });
      }
      nome = clean;
    }

    // - modelo pode ser string vazia ⇒ NULL
    if (modelo !== undefined) {
      modelo = String(modelo).trim() || null;
    }

    // - Decimais
    try {
      if (hash_rate !== undefined) hash_rate = normalizeDecimal(hash_rate);
      if (preco_kw !== undefined) preco_kw = normalizeDecimal(preco_kw);
      if (consumo_kw_hora !== undefined) consumo_kw_hora = normalizeDecimal(consumo_kw_hora);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const updates = buildUpdateSet({
      nome,
      modelo,
      hash_rate,
      preco_kw,
      consumo_kw_hora,
    });

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    const [updatedMiner] = await sql`
      UPDATE miners
      SET ${sql.join(updates, sql`, `)}
      WHERE id = ${id}
      RETURNING *;
    `;

    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (admin):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (admin)" });
  }
};

/* ============================= OBTÉNS / LISTAGENS ============================= */

export const obterMinerPorId = async (req, res) => {
  const { id } = req.params;

  try {
    const [miner] = await sql`SELECT * FROM miners WHERE id = ${id}`;
    if (!miner) return res.status(404).json({ error: "Mineradora não encontrada" });

    res.json(miner);
  } catch (err) {
    console.error("Erro ao buscar miner:", err);
    res.status(500).json({ error: "Erro ao buscar mineradora" });
  }
};

export const listarMinersPorUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const miners = await sql`
      SELECT * FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC;
    `;
    res.json(miners);
  } catch (err) {
    console.error("Erro ao listar miners:", err);
    res.status(500).json({ error: "Erro ao buscar miners" });
  }
};

/* ============================== STATUS & DELETE ============================== */

export const atualizarStatusMiner = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  try {
    if (status !== undefined) {
      const clean = String(status).toLowerCase();
      if (!["online", "offline"].includes(clean)) {
        return res.status(400).json({ error: "Status inválido (use 'online' ou 'offline')." });
      }
    }

    const [updatedMiner] = await sql`
      UPDATE miners
      SET status = ${status}
      WHERE id = ${id}
      RETURNING *;
    `;
    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
    res.status(500).json({ error: "Erro ao atualizar status do miner" });
  }
};

export const apagarMiner = async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM miners WHERE id = ${id}`;
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao apagar miner:", err);
    res.status(500).json({ error: "Erro ao apagar miner" });
  }
};
