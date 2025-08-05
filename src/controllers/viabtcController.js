import { sql } from "../config/db.js";
import crypto from "crypto";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;

    // Buscar API key, secret_key e coin
    const result = await sql`
      SELECT api_key, secret_key, coin
      FROM miners
      WHERE id = ${minerId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }

    const {
      api_key,
      secret_key,
      coin
    } = result[0];

    // Parâmetros da query
    const tonce = Date.now();
    const params = { coin, tonce };
    const queryString = new URLSearchParams(params).toString();

    // Assinatura HMAC-SHA256
    const signature = crypto
      .createHmac("sha256", secret_key)
      .update(queryString)
      .digest("hex");

    // URL completa
    const url = `https://pool.viabtc.com/res/openapi/v1/account/sub/hashrate?${queryString}`;

    // Fazer o request com X-API-KEY e X-SIGNATURE
    const response = await fetch(url, {
      headers: {
        "X-API-KEY": api_key,
        "X-SIGNATURE": signature
      }
    });

    const data = await response.json();
    return res.json(data);

  } catch (err) {
    console.error("Erro ao chamar a OpenAPI da ViaBTC:", err);
    return res.status(500).json({ error: "Erro ao chamar a OpenAPI da ViaBTC." });
  }
}
