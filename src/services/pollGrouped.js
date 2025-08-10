import { sql } from "../config/db.js";
import fetch from "node-fetch";

// helper: group by key
const groupBy = (arr, keyFn) =>
  arr.reduce((m, x) => {
    const k = keyFn(x);
    (m.get(k) || m.set(k, []).get(k)).push(x);
    return m;
  }, new Map());

export async function pollUptimeOnce() {
  // pega todas as miners com info de pool
  const miners = await sql/*sql*/`
    SELECT id, user_id, nome, worker_name, api_key, coin, pool
    FROM miners
    WHERE pool IS NOT NULL AND api_key IS NOT NULL AND worker_name IS NOT NULL
  `;

  if (!miners.length) return;

  // agrupar por combo que permite 1 chamada para N workers
  // ViaBTC: endpoint por (coin, api_key)
  // LitecoinPool: 1 chamada por api_key, devolve todos os workers
  const groups = groupBy(miners, (m) => `${m.pool}|${m.coin || ""}|${m.api_key}`);

  for (const [key, list] of groups.entries()) {
    const [pool, coin, api_key] = key.split("|");

    let workers = [];

    try {
      if (pool === "ViaBTC") {
        const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
        const resp = await fetch(url, { headers: { "X-API-KEY": api_key } });
        const data = await resp.json();
        if (data?.code === 0) {
          workers = (data.data?.data || []).map((w) => ({
            worker_name: w.worker_name,
            online: w.worker_status === "active",
          }));
        }
      } else if (pool === "LiteCoinPool") {
        const url = `https://www.litecoinpool.org/api?api_key=${api_key}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data?.workers) {
          workers = Object.entries(data.workers).map(([name, info]) => ({
            worker_name: name,
            online: !!info.connected,
          }));
        }
      }
    } catch (e) {
      // falha do fornecedor: ignora este grupo nesta ronda
      continue;
    }

    // index rápido por worker_name
    const idx = new Map(workers.map((w) => [w.worker_name, w.online]));

    // para cada miner do grupo, compara e grava só se mudou
    for (const m of list) {
      const online = idx.get(m.worker_name) || false;

      const last = await sql/*sql*/`
        SELECT status FROM miner_status_logs
        WHERE miner_id = ${m.id}
        ORDER BY at DESC LIMIT 1
      `;
      const lastStatus = last[0]?.status;

      if (lastStatus === undefined || lastStatus !== online) {
        await sql/*sql*/`
          INSERT INTO miner_status_logs (miner_id, status, source, extra)
          VALUES (${m.id}, ${online}, ${pool}, '{}'::jsonb)
        `;
      }
    }
  }
}
