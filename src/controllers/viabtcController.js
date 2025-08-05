import { sql } from "../config/db.js";
import crypto from "crypto";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;

    // 1. Buscar dados da base de dados
    const result = await sql`
      SELECT api_key, secret_key, coin
      FROM miners
      WHERE id = ${minerId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }

    const {
      api_key: access_id,
      secret_key,
      coin
    } = result[0];

    // 2. Parâmetros obrigatórios
    const tonce = Date.now();
    const path = "/v1/hashrate/info";

    const params = { access_id, coin, tonce };

    // 3. Criar query ordenada
    const sortedQuery = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join("&");

    // 4. Criar assinatura
    const stringToSign = `${path}?${sortedQuery}`;
    const signature = crypto
      .createHmac("sha256", secret_key)
      .update(stringToSign)
      .digest("hex");

    // 5. Montar URL final
    const url = `https://api.viabtc.com${path}?${sortedQuery}&signature=${signature}`;
    console.log("🔗 URL final:", url);

    // 6. Fazer request
    const response = await fetch(url);
    const data = await response.json();

    // 7. Devolver resposta
    return res.json(data);
  } catch (err) {
    console.error("❌ Erro ao chamar a API da ViaBTC:", err);
    return res.status(500).json({ error: "Erro ao chamar a API da ViaBTC." });
  }
}
