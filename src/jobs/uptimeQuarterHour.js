// src/jobs/uptimeQuarterHour.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";

/** Arredonda para o início do quarto de hora (UTC) em ISO — só para logs */
function floorToQuarterISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/* ---------- helpers de matching ---------- */
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

/* ---------- ViaBTC ---------- */
async function fetchViaBTCList(apiKey, coinRaw) {
  const coin = String(coinRaw ?? ""); // usa como está na BD
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) {
    return [];
  }
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name),            // ex: "acc.001" ou "001"
    worker_status: String(w.worker_status || ""),  // "active" | "unactive" | ...
    hashrate_10min: Number(w.hashrate_10min || 0),
  }));
}

/* ---------- LitecoinPool ---------- */
async function fetchLitecoinPoolWorkers(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  return data && data.workers ? data.workers : {};
}

/** Corre UM tick (sem lock) — podes chamar por endpoint manual também */
export async function runUptimeTickOnce() {
  const slotISO = floorToQuarterISO();
  let totalUpdates = 0;
  const alreadyUpdated = new Set(); // evita somar duas vezes no mesmo tick

  try {
    // 1) miners elegíveis
    const miners = await sql/*sql*/`
      SELECT id, user_id, nome, worker_name, api_key, coin, pool
      FROM miners
      WHERE api_key IS NOT NULL AND worker_name IS NOT NULL AND pool IS NOT NULL
    `;
    if (!miners.length) {
      console.log("[uptime] sem miners elegíveis.");
      return { ok: true, updated: 0 };
    }

    // 2) agrupar por (pool, api_key[, coin])
    const groups = new Map();
    for (const m of miners) {
      const key = `${m.pool}|${m.api_key}|${m.pool === "ViaBTC" ? (m.coin ?? "") : ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // 3) para cada grupo, buscar status e atualizar em lote
    for (const [key, list] of groups) {
      const [pool, apiKey, coin] = key.split("|");
      const onlineIds = [];

      if (pool === "ViaBTC") {
        const workers = await fetchViaBTCList(apiKey, coin);
        for (const m of list) {
          const w = workers.find((x) => matchWorkerName(x.worker_name, m.worker_name));
          if (w && (w.worker_status === "active" || w.hashrate_10min > 0)) {
            if (!alreadyUpdated.has(m.id)) {
              onlineIds.push(m.id);
              alreadyUpdated.add(m.id);
            }
          }
        }
      } else if (pool === "LiteCoinPool") {
        const workers = await fetchLitecoinPoolWorkers(apiKey);
        for (const m of list) {
          const info = workers?.[m.worker_name];
          if (info && info.connected === true) {
            if (!alreadyUpdated.has(m.id)) {
              onlineIds.push(m.id);
              alreadyUpdated.add(m.id);
            }
          }
        }
      } else {
        // outras pools: ignora
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

/** Inicia o cron de 15 em 15 minutos (sem lock) */
export function startQuarterHourUptime() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      await runUptimeTickOnce();
    },
    { timezone: "Europe/Lisbon" }
  );
}
