import cron from "node-cron";
import { sql } from "../config/db.js";
import fetch from "node-fetch";
import { redis } from "../config/upstash.js";

function floorToQuarterISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// ==== VIA BTC ====
// nota: coin em maiúsculas e pedimos 200 por página
async function fetchViaBTCMap(apiKey, coinRaw) {
  const coin = String(coinRaw || "").toUpperCase();
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}&page=1&size=200`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);

  const map = new Map();
  if (data?.code === 0 && Array.isArray(data.data?.data)) {
    for (const w of data.data.data) {
      const name = norm(w.worker_name);
      const online = (w.worker_status === "active") || (Number(w.hashrate_10min) > 0);
      map.set(name, online);
    }
  } else {
    console.warn("[uptime] ViaBTC resposta inesperada:", data);
  }
  return map;
}

// ==== LITECOINPOOL ====
async function fetchLitecoinPoolMap(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  const map = new Map();
  if (data?.workers && typeof data.workers === "object") {
    for (const [name, info] of Object.entries(data.workers)) {
      map.set(norm(name), !!(info && info.connected));
    }
  } else {
    console.warn("[uptime] LitecoinPool resposta inesperada:", data);
  }
  return map;
}

export async function runUptimeTickOnce() {
  const slotISO = floorToQuarterISO();
  const lockKey = `uptime:quarter:${slotISO}`;

  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) {
    console.log(`[uptime] lock ativo (${slotISO}) – a ignorar duplicado.`);
    return { ok: true, skipped: true };
  }

  let totalUpdates = 0;
  try {
    const miners = await sql/*sql*/`
      SELECT id, user_id, nome, worker_name, api_key, coin, pool
      FROM miners
      WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
    `;
    if (!miners.length) {
      console.log("[uptime] sem miners elegíveis.");
      return { ok: true, updated: 0 };
    }

    // agrupar corretamente
    const groups = new Map(); // key -> Miner[]
    for (const m of miners) {
      const key = `${m.pool}|${m.api_key}|${m.pool === "ViaBTC" ? (m.coin ?? "") : ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    for (const [key, list] of groups) {
      const [pool, apiKey, coin] = key.split("|");
      let statusMap = new Map();

      try {
        statusMap =
          pool === "ViaBTC" ? await fetchViaBTCMap(apiKey, coin) :
          pool === "LiteCoinPool" ? await fetchLitecoinPoolMap(apiKey) :
          new Map();
      } catch (e) {
        console.error(`[uptime] erro a buscar ${pool}:`, e);
        continue;
      }

      const onlineIds = [];
      const unmatched = []; // para debug
      for (const m of list) {
        const keyName = norm(m.worker_name);
        const has = statusMap.has(keyName);
        const online = statusMap.get(keyName) === true;
        if (!has) unmatched.push(m.worker_name);
        if (online) onlineIds.push(m.id);
      }

      if (onlineIds.length) {
        await sql/*sql*/`
          UPDATE miners
          SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
          WHERE id = ANY(${onlineIds})
        `;
        totalUpdates += onlineIds.length;
      }

      const poolTag = pool === "ViaBTC" ? `ViaBTC(${String(coin).toUpperCase()})` : pool;
      console.log(`[uptime] grupo ${poolTag} – workers: ${list.length}, online: ${onlineIds.length}`);
      if (unmatched.length) {
        console.log(`[uptime]   nomes não encontrados (${poolTag}):`, unmatched.join(", "));
      }
    }

    console.log(`[uptime] ${slotISO} – miners atualizadas: ${totalUpdates}`);
    return { ok: true, updated: totalUpdates };
  } catch (e) {
    console.error("⛔ uptimeQuarterHour:", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startQuarterHourUptime() {
  cron.schedule("*/15 * * * *", async () => {
    await runUptimeTickOnce();
  }, { timezone: "Europe/Lisbon" });
}
