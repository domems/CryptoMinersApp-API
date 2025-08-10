// src/jobs/uptimeTracker.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js"; // usa o mesmo redis que já tens

/** ISO do início do quarto de hora (UTC) — define o “slot” do tick */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/* -------------------- helpers de matching (ViaBTC) -------------------- */
const norm = (s) => String(s ?? "").trim();
const low = (s) => norm(s).toLowerCase();
const lastToken = (s) => {
  const parts = norm(s).split(/[._-]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : norm(s);
};
/** Match robusto: igual, case-insensitive, termina com ".worker", ou último token */
function matchWorkerName(apiName, dbName) {
  const a = norm(apiName);
  const b = norm(dbName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (low(a) === low(b)) return true;
  if (a.endsWith(`.${b}`)) return true;
  if (low(a).endsWith(`.${low(b)}`)) return true;
  if (low(lastToken(a)) === low(b)) return true;
  return false;
}

/* -------------------- fetchers -------------------- */
async function fetchViaBTCList(apiKey, coinRaw) {
  const coin = String(coinRaw ?? ""); // mantém como está na BD
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) return [];
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name),
    worker_status: String(w.worker_status || ""),
    hashrate_10min: Number(w.hashrate_10min || 0),
  }));
}

async function fetchLitecoinPoolWorkers(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  return data && data.workers ? data.workers : {};
}

/* -------------------- main runner -------------------- */
export async function runUptimeTrackerOnce() {
  const sISO = slotISO();

  // 1) lock distribuído (impede duplicar o mesmo slot entre instâncias)
  const lockKey = `uptime:slot:${sISO}`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 }); // 14 min
  if (!gotLock) {
    console.log(`[uptime] lock ativo (${sISO}) – ignorado nesta instância.`);
    return { ok: true, skipped: true };
  }

  // dedupe local por segurança adicional
  const updatedOnce = new Set();

  try {
    // 2) buscar miners elegíveis
    const miners = await sql/*sql*/`
      SELECT id, user_id, nome, worker_name, api_key, coin, pool
      FROM miners
      WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
    `;
    if (!miners.length) {
      console.log("[uptime] sem miners elegíveis.");
      return { ok: true, updated: 0 };
    }

    // 3) agrupar por (pool, api_key[, coin]) → 1 chamada por grupo
    const groups = new Map(); // key -> Miner[]
    for (const m of miners) {
      const key = m.pool === "ViaBTC"
        ? `ViaBTC|${m.api_key}|${m.coin ?? ""}`
        : `LiteCoinPool|${m.api_key}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // 4) processar todos os grupos; erros por grupo não travam os restantes
    const toUpdateIds = [];

    for (const [key, list] of groups) {
      const [pool, apiKey, coin = ""] = key.split("|");
      let candidateIds = [];

      try {
        if (pool === "ViaBTC") {
          const workers = await fetchViaBTCList(apiKey, coin);
          for (const m of list) {
            const w = workers.find((x) => matchWorkerName(x.worker_name, m.worker_name));
            if (w && (w.worker_status === "active" || w.hashrate_10min > 0)) {
              candidateIds.push(m.id);
            }
          }
        } else if (pool === "LiteCoinPool") {
          const workers = await fetchLitecoinPoolWorkers(apiKey);
          for (const m of list) {
            const info = workers?.[m.worker_name]; // match exato
            if (info && info.connected === true) {
              candidateIds.push(m.id);
            }
          }
        } else {
          console.warn(`[uptime] pool desconhecida no grupo: ${pool}`);
        }
      } catch (e) {
        console.error(`[uptime] erro a processar grupo ${key}:`, e);
      }

      // dedupe local por slot
      for (const id of candidateIds) {
        if (!updatedOnce.has(id)) {
          updatedOnce.add(id);
          toUpdateIds.push(id);
        }
      }

      const poolTag = pool === "ViaBTC" ? `ViaBTC(${coin})` : pool;
      console.log(`[uptime] grupo ${poolTag} – workers: ${list.length}, online: ${candidateIds.length}, únicos neste slot: ${candidateIds.filter(id => !updatedOnce.has(id)).length}`);
    }

    // 5) update único para todos os miners online do slot
    if (toUpdateIds.length) {
      await sql/*sql*/`
        UPDATE miners
        SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
        WHERE id = ANY(${toUpdateIds})
      `;
    }

    console.log(`[uptime] ${sISO} – miners atualizadas: ${toUpdateIds.length}`);
    return { ok: true, updated: toUpdateIds.length };
  } catch (e) {
    console.error("⛔ uptimeTracker:", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/* -------------------- scheduler -------------------- */
export function startUptimeTracker() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        await runUptimeTrackerOnce();
      } catch (e) {
        console.error("⛔ erro no job de uptime:", e);
      }
    },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] Uptime tracker (*/15) agendado.");
}
