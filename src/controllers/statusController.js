// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";

export async function getMinerStatus(req, res) {
  try {
    const { minerId } = req.params;

    const result = await sql`
      SELECT api_key, coin, pool, worker_name
      FROM miners
      WHERE id = ${minerId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }

    const { api_key, coin, pool, worker_name } = result[0];

    if (pool === "ViaBTC") {
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;

      const response = await fetch(url, {
        headers: { "X-API-KEY": api_key }
      });

      const data = await response.json();

      if (!data || data.code !== 0) {
        console.error("Erro da API ViaBTC:", data);
        return res.status(502).json({ error: "Erro na API da ViaBTC", detalhe: data?.message || "Erro desconhecido" });
      }

      const workers = data.data?.data?.map(worker => ({
        worker_name: worker.worker_name,
        worker_status: worker.worker_status,
        hashrate_10min: worker.hashrate_10min
      }));

      return res.json({
        total: workers.length,
        active: workers.filter(w => w.worker_status === "active").length,
        unactive: workers.filter(w => w.worker_status === "unactive").length,
        workers
      });

    } else if (pool === "LiteCoinPool") {
      const url = `https://www.litecoinpool.org/api?api_key=${api_key}`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data || !data.workers) {
        return res.status(502).json({ error: "Erro na API da LitecoinPool", detalhe: data?.error || "Erro desconhecido" });
      }

      const workers = Object.entries(data.workers).map(([name, info]) => ({
        worker_name: name,
        worker_status: info.alive ? "active" : "unactive",
        hashrate_10min: info.hashrate
      }));

      return res.json({
        total: workers.length,
        active: workers.filter(w => w.worker_status === "active").length,
        unactive: workers.filter(w => w.worker_status === "unactive").length,
        workers
      });

    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
