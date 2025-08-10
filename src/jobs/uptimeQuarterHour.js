// src/jobs/uptimeQuarterHour.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/**
 * Arredonda o tempo para o início do quarto de hora (UTC) e devolve ISO.
 * Ex.: 22:17 -> 22:15:00Z
 */
function floorToQuarterISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/** --------- VIA BTC (match EXATO, como no teu controller) --------- */
async function fetchViaBTCList(apiKey, coin) {
  // Mantemos o coin como vem da DB (sem forçar maiúsculas) para replicar o controller
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) {
    console.warn("[uptime] ViaBTC resposta inesperada:", data);
    return [];
  }
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name),
    worker_status: w.worker_status,
    hashrate_10min: Number(w.hashrate_10min || 0),
  }));
}

/** --------- LITECOINPOOL --------- */
async function fetchLitecoinPoolObject(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  if (!data || !data.workers) {
    console.warn("[uptime] LitecoinPool resposta inesperada:", data);
    return {};
  }
  return data.workers; // { [name]: { connected, hash_rate, ... } }
}

/**
 * Corre UM tick de 15 minutos.
 * @param {{ignoreLock?: boolean}} opts
 */
export async function runUptimeTickOnce({ ignoreLock = false } = {}) {
  const slotISO = floorToQuarterISO();
  const lockKey = `uptime:quarter:${slotISO}`;

  // Lock distribuído para impedir duplicação do job na mesma janela
  if (!ignoreLock) {
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 }); // 14 min
    if (!gotLock) {
      console.log(`[uptime] lock ativo (${slotISO}) – a ignorar duplicado.`);
      return { ok: true, skipped: true };
    }
  }

  let totalUpdates = 0;

  try {
    // 1) Carrega miners elegíveis
    const miners = await sql/*sql*/`
      SELECT id, user_id, nome, worker_name, api_key, coin, pool
      FROM miners
      WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
    `;
    if (!miners.length) {
      console.log("[uptime] sem miners elegíveis.");
      return { ok: true, updated: 0 };
    }

    // 2) Agrupa por (pool, api_key[, coin]) para reduzir chamadas
    const groups = new Map(); // key -> Miner[]
    for (const m of miners) {
      const key = `${m.pool}|${m.api_key}|${m.pool === "ViaBTC" ? (m.coin ?? "") : ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // 3) Para cada grupo, busca status e atualiza em lote
    for (const [key, list] of groups) {
      const [pool, apiKey, coin] = key.split("|");

      const onlineIds = [];

      if (pool === "ViaBTC") {
        // === ViaBTC com MATCH EXATO (como no teu controller) ===
        const workers = await fetchViaBTCList(apiKey, coin);
        for (const m of list) {
          const w = workers.find((x) => x.worker_name === m.worker_name);
          if (w && w.worker_status === "active") {
            onlineIds.push(m.id);
          }
        }
      } else if (pool === "LiteCoinPool") {
        // === LitecoinPool: connected === true
        const workers = await fetchLitecoinPoolObject(apiKey);
        for (const m of list) {
          const info = workers?.[m.worker_name];
          if (info && info.connected === true) {
            onlineIds.push(m.id);
          }
        }
      } else {
        // outras pools (se aparecerem), ignorar
        console.warn(`[uptime] pool não suportada no cron: ${pool}`);
      }

      if (onlineIds.length) {
        await sql/*sql*/`
          UPDATE miners
          SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
          WHERE id = ANY(${onlineIds})
        `;
        totalUpdates += onlineIds.length;
      }

      const poolTag = pool === "ViaBTC" ? `ViaBTC(${coin})` : pool;
      console.log(`[uptime] grupo ${poolTag} – workers: ${list.length}, online: ${onlineIds.length}`);
    }

    console.log(`[uptime] ${slotISO} – miners atualizadas: ${totalUpdates}`);
    return { ok: true, updated: totalUpdates };
  } catch (e) {
    console.error("⛔ uptimeQuarterHour:", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Inicia o cron (Europe/Lisbon) de 15 em 15 minutos */
export function startQuarterHourUptime() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      await runUptimeTickOnce();
    },
    { timezone: "Europe/Lisbon" }
  );
}
