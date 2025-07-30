import { sql } from "../config/db.js";

// Lista de emails de administradores
const adminEmails = [
  "domems@gmail.com", 
  "admin2@email.com"
];

export const criarMiner = async (req, res) => {
  const { user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora } = req.body;

  try {
    const [novoMiner] = await sql`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status
      ) VALUES (
        ${user_id}, ${nome}, ${modelo}, ${hash_rate}, ${preco_kw}, ${consumo_kw_hora}, 'offline'
      )
      RETURNING *;
    `;
    res.status(201).json(novoMiner);
  } catch (err) {
    console.error("Erro ao criar miner:", err);
    res.status(500).json({ error: "Erro ao criar miner" });
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

export const atualizarStatusMiner = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
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

// Atualização feita por admin (todos os campos)
export const atualizarMinerComoAdmin = async (req, res) => {
  const { id } = req.params;
  const userEmail = req.header("x-user-email");

  if (!adminEmails.includes(userEmail)) {
    return res.status(403).json({ error: "Acesso negado. Apenas admins podem editar todos os campos." });
  }

  const {
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora
  } = req.body;

  try {
    const [updatedMiner] = await sql`
      UPDATE miners
      SET nome = ${nome},
          modelo = ${modelo},
          hash_rate = ${hash_rate},
          preco_kw = ${preco_kw},
          consumo_kw_hora = ${consumo_kw_hora}
      WHERE id = ${id}
      RETURNING *;
    `;
    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (admin):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (admin)" });
  }
};

// Atualização feita por cliente (apenas watcher_key e worker_name)
export const atualizarMinerComoCliente = async (req, res) => {
  const { id } = req.params;
  const { worker_name, watcher_key } = req.body;

  try {
    const [updatedMiner] = await sql`
      UPDATE miners
      SET worker_name = ${worker_name},
          watcher_key = ${watcher_key}
      WHERE id = ${id}
      RETURNING *;
    `;
    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (cliente):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (cliente)" });
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

// Obter miner por ID
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
