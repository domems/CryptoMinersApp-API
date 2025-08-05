import { sql } from "../config/db.js";
import crypto from "crypto";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;

    // Buscar dados da BD
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

    const tonce = Date.now();
    const path = "/v1/hashrate/info";

    // Parâmetros ordenados por nome
    const params = { access_id, coin, tonce };
    const sortedKeys = Object.keys(params).sort();
    const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join("&");

    // Assinar com HMAC-SHA256
    const stringToSign = `${path}?${queryString}`;
    const signature = crypto
      .createHmac("sha256", secret_key)
      .update(stringToSign)
      .digest("hex");

    // Montar URL final
    const url = `https://api.viabtc.com${path}?${queryString}&signature=${signature}`;

    // Fazer o pedido
    const response = await fetch(url);
    const data = await response.json();

    return res.json(data);
  } catch (err) {
    console.error("Erro ao chamar a API da ViaBTC:", err);
    return res.status(500).json({ error: "Erro ao chamar a API da ViaBTC." });
  }
}
