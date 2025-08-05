// controllers/storeMinersController.js
import { sql } from "../config/db.js";

export async function getStoreMiners(req, res) {
  try {
    const result = await sql`SELECT * FROM store_miners ORDER BY created_at DESC`;
    res.json(result);
  } catch (err) {
    console.error("Erro ao buscar máquinas da loja:", err);
    res.status(500).json({ error: "Erro ao buscar máquinas da loja." });
  }
}

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
    } = req.body;

    if (!nome || !modelo || !hash_rate || !consumo_kw || !preco) {
      return res.status(400).json({ error: "Preencha todos os campos obrigatórios." });
    }

    const result = await sql`
      INSERT INTO store_miners (
        nome, modelo, hash_rate, consumo_kw, preco, quantidade, descricao, imagem_url
      ) VALUES (
        ${nome}, ${modelo}, ${hash_rate}, ${consumo_kw}, ${preco}, ${quantidade || 1}, ${descricao || ""}, ${imagem_url || ""}
      ) RETURNING *;
    `;

    res.status(201).json(result[0]);
  } catch (err) {
    console.error("Erro ao criar máquina da loja:", err);
    res.status(500).json({ error: "Erro ao criar máquina da loja." });
  }
}
