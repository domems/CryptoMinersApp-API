import cron from "node-cron";
import { sql } from "../config/db.js";
import fetch from "node-fetch";
import { redis } from "../config/upstash.js";

// --- utils --- //
function floorToQuarterISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString(); // ex: 2025-08-10T12:45:00.000Z
}

async function fetchViaBTCMap(apiKey, coin) {
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  const map = new Map();
  if (data?.code === 0 && Array.isArray(data.data?.data)) {
    for (const w of data.data.data) {
      map.set(String(w.worker_name), w.worker_status === "active");
    }
  }
  return map;
}

async function fetchLitecoinPoolMap(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  const map = new Map();
  if (data?.workers && typeof data.workers === "object") {
    for (const [name, info] of Object.entries(data.workers)) {
      map.set(String(name), !!info.connected);
    }
  }
  return map;
}

export function startQuarterHourUptime() {
  // corre de 15 em 15 minutos
  cron.schedule(
    "*/15 * * * *",
    async () => {
      const slotISO = floorToQuarterISO();              // janela de 15 min
      const lockKey = `uptime:quarter:${slotISO}`;

      // 1) LOCK distribuído: impede duplicação do job nesta janela
      const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
      if (!gotLock) {
        console.log(`[uptime] lock ativo (${slotISO}) – a ignorar duplicado.`);
        return;
      }

      try {
        // 2) Carregar miners com credenciais
        const miners = await sql/*sql*/`
          SELECT id, user_id, nome, worker_name, api_key, coin, pool
          FROM miners
          WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
        `;
        if (!miners.length) {
          console.log("[uptime] sem miners elegíveis.");
          return;
        }

        // 3) Agrupar por (pool, api_key[, coin]) – 1 chamada por grupo
        const groups = new Map();
        for (const m of miners) {
          const key = `${m.pool}|${m.api_key}|${m.pool === "ViaBTC" ? (m.coin ?? "") : ""}`;
          (groups.get(key) || groups.set(key, []).get(key)).push(m);
        }

        let totalUpdates = 0;

        // 4) Para cada grupo, obter status map e fazer update em lote
        for (const [key, list] of groups) {
          const [pool, apiKey, coin] = key.split("|");
          let statusMap = new Map();

          try {
            if (pool === "ViaBTC") statusMap = await fetchViaBTCMap(apiKey, coin);
            else if (pool === "LiteCoinPool") statusMap = await fetchLitecoinPoolMap(apiKey);
            else statusMap = new Map();
          } catch (e) {
            console.error(`[uptime] erro a buscar ${pool}:`, e);
            continue;
          }

          const onlineIds = [];
          for (const m of list) {
            const online = !!statusMap.get(String(m.worker_name));
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
        }

        console.log(`[uptime] ${slotISO} – miners atualizadas: ${totalUpdates}`);
      } catch (e) {
        console.error("⛔ uptimeQuarterHour:", e);
      } finally {
        // o lock expira sozinho; não precisamos dar DEL
      }
    },
    { timezone: "Europe/Lisbon" }
  );
}
