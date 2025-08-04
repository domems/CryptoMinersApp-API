import { sql } from "../config/db.js";
import crypto from "crypto";
import fetch from "node-fetch";

export async function getViaBTCData(req, res) {
  try {
    const { minerId } = req.params;
    const result = await sql`SELECT api_key, secret_key, coin FROM miners WHERE id = ${minerId}`;
    if (result.length === 0) return res.status(404).json({ error: "Miner não encontrado." });

    const { api_key, secret_key, coin } = result[0];
    const tonce = Date.now();
    const params = { access_id: api_key, coin, tonce };
    const sortedKeys = Object.keys(params).sort();
    const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join("&");

    const sign = crypto
      .createHash("sha1")
      .update(`${queryString}&secret_key=${secret_key}`)
      .digest("hex");

    const url = `https://api.viabtc.com/v1/pool/worker/list?${queryString}&sign=${sign}`;
    const response = await fetch(url);
    const data = await response.json();

    return res.json(data);
  } catch (err) {
    console.error("Erro API ViaBTC:", err);
    res.status(500).json({ error: "Erro ao chamar a API." });
  }
}
