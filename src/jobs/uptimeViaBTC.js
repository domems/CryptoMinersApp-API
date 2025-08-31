// src/jobs/uptimeViaBTC.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";

function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

// ===== helpers =====
const norm = (s) => String(s ?? "").trim();
const low  = (s) => norm(s).toLowerCase();
/** usa só o sufixo depois do último "." (mantém zeros à esquerda) */
const tail = (s) => {
  const str = norm(s);
  const i = str.lastIndexOf(".");
  return i >= 0 ? str.slice(i + 1) : str;
};
function normalizeCoin(c) {
  const s = String(c ?? "").trim().toUpperCase();
  return s === "BTC" || s === "LTC" ? s : "";
}
/** estado online sem falsos positivos (ex.: "unactive" NÃO é "active") */
function isOnlineFrom(w) {
  const hr = Number(w?.hashrate_10min ?? 0);
  if (Number.isFinite(hr) && hr > 0) return true;
  const ws = low(w?.worker_status ?? "");
  const NEG = new Set(["unactive", "inactive", "offline", "down", "dead"]);
  if (NEG.has(ws)) return false;
  const POS = new Set(["active", "online", "alive", "running", "up", "ok"]);
  if (POS.has(ws)) return true;
  return false;
}

// ===== API fetch + caches =====
const API_TTL_MS = 60_000; // cache em memória por grupo (api_key|coin)
const apiCache = new Map(); // key -> { workers, ts }
let lastSlot = null;
let slotCache = new Map();  // `${slot}|${api_key}|${coin}` -> workers
const updatedInSlot = new Set();

function beginSlot(s) {
  if (s !== lastSlot) {
    lastSlot = s;
    slotCache = new Map();     // limpa cache do slot quando muda
    updatedInSlot.clear();     // mantém dedupe de incrementos por slot
  }
}
function dedupe(ids) {
  const out = [];
  for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); }
  return out;
}

async function fetchViaBTCList(apiKey, coin) {
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) return [];
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name ?? ""),
    worker_status: String(w.worker_status ?? ""),
    hashrate_10min: Number(w.hashrate_10min ?? 0),
  }));
}

/**
 * Obtém workers da ViaBTC para (apiKey, coin) com 2 camadas de cache:
 *  - cache do SLOT atual (reutiliza dentro do mesmo slot de 15 min)
 *  - cache temporário em memória com TTL (evita refetchs em execuções próximas)
 * Retorna { workers, cache: "slot"|"memory"|"miss" }
 */
async function getViaBTCWorkersCached(apiKey, coin, slot) {
  const groupKey = `${apiKey}|${coin}`;
  const slotKey  = `${slot}|${groupKey}`;

  // 1) cache por slot (mais forte)
  if (slotCache.has(slotKey)) {
    return { workers: slotCache.get(slotKey), cache: "slot" };
  }

  // 2) cache com TTL
  const c = apiCache.get(groupKey);
  if (c && Date.now() - c.ts < API_TTL_MS) {
    slotCache.set(slotKey, c.workers);
    return { workers: c.workers, cache: "memory" };
  }

  // 3) fetch real
  const workers = await fetchViaBTCList(apiKey, coin);
  apiCache.set(groupKey, { workers, ts: Date.now() });
  slotCache.set(slotKey, workers);
  return { workers, cache: "miss" };
}

// ===== Job principal =====
export async function runUptimeViaBTCOnce() {
  const t0 = Date.now();
  const sISO = slotISO();
  beginSlot(sISO);

  let updated = 0;
  let totalMiners = 0;
  let totalGroups = 0;
  let workersRelevant = 0;
  let workersExtra = 0;
  let groupErrors = 0;
  let apiCalls = 0;

  // novos contadores de alterações de status
  let statusToOnline = 0;
  let statusToOffline = 0;

  // limitar concorrência para não bombardear a API
  const CONCURRENCY = 3;
  const queue = [];

  try {
    // agrupar por (api_key, coin normalizada)
    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, api_key, coin
      FROM miners
      WHERE pool = 'ViaBTC' AND api_key IS NOT NULL AND worker_name IS NOT NULL
    `;
    const miners = minersRaw
      .map(m => ({ ...m, coin: normalizeCoin(m.coin) }))
      .filter(m => m.coin);
    totalMiners = miners.length;

    if (!totalMiners) {
      console.log(`[uptime:viabtc] ${sISO} groups=0 miners=0 api=0 workers=0 extra=0 online=0 errs=0 statusOn=0 statusOff=0 dur=${Date.now() - t0}ms`);
      return { ok: true, updated: 0 };
    }

    const groups = new Map(); // `${api_key}|/${coin}` -> Miner[]
    for (const m of miners) {
      const k = `${m.api_key}|${m.coin}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    totalGroups = groups.size;

    const groupEntries = Array.from(groups.entries());

    async function processGroup([k, list]) {
      const [apiKey, coin] = k.split("|");

      try {
        // mapa tail -> [ids]
        const tailToIds = new Map();
        for (const m of list) {
          const t = tail(m.worker_name);
          if (!t) continue;
          if (!tailToIds.has(t)) tailToIds.set(t, []);
          tailToIds.get(t).push(m.id);
        }
        const tailsWanted = new Set(tailToIds.keys());
        const allIds = list.map(m => m.id);

        // fetch (com caches)
        const { workers, cache } = await getViaBTCWorkersCached(apiKey, coin, sISO);
        if (cache === "miss") apiCalls += 1;

        // filtrar apenas relevantes para a BD
        const relevant = [];
        let extra = 0;
        for (const w of workers) {
          const tw = tail(w.worker_name);
          if (tailsWanted.has(tw)) relevant.push(w);
          else extra += 1;
        }
        workersRelevant += relevant.length;
        workersExtra += extra;

        // determinar online e acumular ids
        const onlineIdsRaw = [];
        for (const w of relevant) {
          if (!isOnlineFrom(w)) continue;
          const ids = tailToIds.get(tail(w.worker_name)) || [];
          onlineIdsRaw.push(...ids);
        }

        // offline = todos os ids do grupo que não estão em online
        const onlineSet = new Set(onlineIdsRaw);
        const offlineIdsRaw = allIds.filter(id => !onlineSet.has(id));

        // 1) Horas online (dedupe por slot para não contar a dobrar)
        const ids = dedupe(onlineIdsRaw);
        if (ids.length) {
          await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online,0) + 0.25
            WHERE id = ANY(${ids})
          `;
          updated += ids.length;
        }

        // 2) Status (só altera quando diverge — null-safe com IS DISTINCT FROM)
        if (onlineIdsRaw.length) {
          const r1 = await sql/*sql*/`
            UPDATE miners
            SET status = 'online'
            WHERE id = ANY(${onlineIdsRaw})
              AND status IS DISTINCT FROM 'online'
            RETURNING id
          `;
          statusToOnline += (Array.isArray(r1) ? r1.length : (r1?.count || 0));
        }
        if (offlineIdsRaw.length) {
          const r2 = await sql/*sql*/`
            UPDATE miners
            SET status = 'offline'
            WHERE id = ANY(${offlineIdsRaw})
              AND status IS DISTINCT FROM 'offline'
            RETURNING id
          `;
          statusToOffline += (Array.isArray(r2) ? r2.length : (r2?.count || 0));
        }
      } catch {
        groupErrors += 1;
      }
    }

    // executa com concorrência limitada (mantido como no teu código)
    for (const entry of groupEntries) {
      const p = processGroup(entry);
      queue.push(p);
      if (queue.length >= CONCURRENCY) {
        await Promise.race(queue).catch(() => {});
        // (nota: manter como está; se quiseres posso trocar para um limitador mais robusto)
      }
    }
    await Promise.allSettled(queue);

    console.log(
      `[uptime:viabtc] ${sISO} groups=${totalGroups} miners=${totalMiners} api=${apiCalls} workers=${workersRelevant} extra=${workersExtra} online(+hrs)=${updated} statusOn=${statusToOnline} statusOff=${statusToOffline} errs=${groupErrors} dur=${Date.now() - t0}ms`
    );
    return {
      ok: true,
      updated, // nº de miners a quem somámos 0.25h
      statusChanged: statusToOnline + statusToOffline,
      statusToOnline,
      statusToOffline,
      groups: totalGroups,
      miners: totalMiners,
      api: apiCalls,
      workers_relevant: workersRelevant,
      workers_extra: workersExtra,
      errs: groupErrors
    };
  } catch (e) {
    console.error(`[uptime:viabtc] ${sISO} ERROR: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeViaBTC() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try { await runUptimeViaBTCOnce(); } catch {}
    },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] ViaBTC (*/15) agendado.");
}
