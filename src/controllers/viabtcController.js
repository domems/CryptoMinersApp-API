import { sql } from "../config/db.js";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;

    // 1. Buscar api_key e coin da BD
    const result = await sql`
      SELECT api_key, coin
      FROM miners
      WHERE id = ${minerId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }

    const { api_key, coin } = result[0];

    // 2. Endpoint OpenAPI da ViaBTC para lista de workers
    const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;

    // 3. Fazer pedido com X-API-KEY
    const response = await fetch(url, {
      headers: {
        "X-API-KEY": api_key
      }
    });

    const data = await response.json();

    // 4. Validar resposta
    if (!data || data.code !== 0) {
      console.error("Erro da API:", data);
      return res.status(502).json({ error: "Erro na API da ViaBTC", detalhe: data?.message || "Erro desconhecido" });
    }

    // 5. Retornar resposta JSON da API
    return res.json(data);

  } catch (err) {
    console.error("❌ Erro no controller getViaBTCData:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API da ViaBTC." });
  }
}
