import { sql } from "../config/db.js";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;

    // Vamos buscar apenas a API key (não é necessário secret_key)
    const result = await sql`
      SELECT api_key, coin
      FROM miners
      WHERE id = ${minerId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }

    const { api_key, coin } = result[0];

    // Endpoint da OpenAPI
    const url = `https://www.viabtc.net/res/openapi/v1/hashrate/info?coin=${coin}`;

    // Fazer o pedido com o header 'X-API-KEY'
    const response = await fetch(url, {
      headers: {
        "X-API-KEY": api_key
      }
    });

    const data = await response.json();
    return res.json(data);

  } catch (err) {
    console.error("Erro ao chamar a OpenAPI da ViaBTC:", err);
    return res.status(500).json({ error: "Erro ao chamar a OpenAPI da ViaBTC." });
  }
}
