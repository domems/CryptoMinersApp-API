// jobs/uptimeQuarterHour.js
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js"; 
import fetch from "node-fetch";

export async function runUptimeQuarterHour() {
  const now = new Date();
  const quarterKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${Math.floor(now.getUTCMinutes() / 15)}`;

  const lockKey = `uptime-lock-${quarterKey}`;
  const gotLock = await redis.set(lockKey, "locked", { nx: true, ex: 60 * 14 });
  if (!gotLock) return;

  const miners = await sql`
    SELECT id, pool, api_key, coin, worker_name
    FROM miners
  `;

  for (const miner of miners) {
    const isActive = await checkMinerOnline(miner);
    if (isActive) {
      await sql`
        UPDATE miners
        SET total_horas_online = total_horas_online + 0.25
        WHERE id = ${miner.id}
      `;
    }
  }
}

async function checkMinerOnline({ pool, api_key, coin, worker_name }) {
  try {
    if (pool === "ViaBTC") {
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
      const res = await fetch(url, { headers: { "X-API-KEY": api_key } });
      const data = await res.json();
      if (data?.code !== 0) return false;

      const worker = data.data?.data?.find(w => w.worker_name === worker_name);
      return worker?.worker_status === "active";
    }

    if (pool === "LiteCoinPool") {
      const url = `https://www.litecoinpool.org/api?api_key=${api_key}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data?.workers) return false;

      // match exato, sem incluir outros workers
      const workerInfo = data.workers[worker_name];
      return workerInfo?.connected === true;
    }

    return false;
  } catch {
    return false;
  }
}
