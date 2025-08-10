// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const statusCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

export async function getMinerStatus(req, res) {
  try {
    const { minerId } = req.params;
    const cached = statusCache.get(minerId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const result = await sql`
      SELECT api_key, coin, pool, worker_name
      FROM miners
      WHERE id = ${minerId}
    `;
    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }
    const { api_key, coin, pool, worker_name } = result[0];

    let workers = [];
    if (pool === "ViaBTC") {
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
      const response = await fetch(url, { headers: { "X-API-KEY": api_key } });
      const data = await response.json();
      if (!data || data.code !== 0) {
        return res.status(502).json({ error: "Erro na API da ViaBTC", detalhe: data?.message || "Erro desconhecido" });
      }
      workers = data.data?.data?.map((w) => ({
        worker_name: w.worker_name,
        worker_status: w.worker_status,
        hashrate_10min: w.hashrate_10min,
      }));
    } else if (pool === "LiteCoinPool") {
      const url = `https://www.litecoinpool.org/api?api_key=${api_key}`;
      const response = await fetch(url);
      const data = await response.json();
      if (!data || !data.workers) {
        return res.status(502).json({ error: "Erro na API da LitecoinPool", detalhe: data?.error || "Erro desconhecido" });
      }
      workers = Object.entries(data.workers).map(([name, info]) => ({
        worker_name: name,
        worker_status: info.connected ? "active" : "unactive",
        hashrate_10min: info.hash_rate * 1000,
      }));
    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

    const responseData = {
      total: workers.length,
      active: workers.filter((w) => w.worker_status === "active").length,
      unactive: workers.filter((w) => w.worker_status === "unactive").length,
      workers,
    };

    statusCache.set(minerId, { data: responseData, timestamp: Date.now() });
    return res.json(responseData);
  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
