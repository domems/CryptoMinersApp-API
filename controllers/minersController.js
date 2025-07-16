import { sql } from "../config/db.js";

// Criar novo miner
export const criarMiner = async (req, res) => {
  const { user_id, nome, modelo, hash_rate } = req.body;

  try {
    const [novoMiner] = await sql`
      INSERT INTO miners (user_id, nome, modelo, hash_rate)
      VALUES (${user_id}, ${nome}, ${modelo}, ${hash_rate})
      RETURNING *;
    `;
    res.status(201).json(novoMiner);
  } catch (err) {
    console.error("Erro ao criar miner:", err);
    res.status(500).json({ error: "Erro ao criar miner" });
  }
};

// Listar miners de um utilizador
export const listarMinersPorUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const miners = await sql`
      SELECT * FROM miners WHERE user_id = ${userId} ORDER BY data_registo DESC;
    `;
    res.json(miners);
  } catch (err) {
    console.error("Erro ao listar miners:", err);
    res.status(500).json({ error: "Erro ao buscar miners" });
  }
};

// Atualizar status (online/offline)
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
// Apagar mineradora
export const apagarMiner = async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM miners WHERE id = ${id}`;
    res.status(204).send(); // 204 = No Content
  } catch (err) {
    console.error("Erro ao apagar miner:", err);
    res.status(500).json({ error: "Erro ao apagar miner" });
  }
};
