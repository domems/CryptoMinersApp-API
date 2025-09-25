// src/jobs/uptimeF2Pool.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/* ===== slot 15 min (UTC) ===== */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/* ===== helpers ===== */
const clean = (s) => String(s ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
function splitAccountWorker(row) {
  const wn = clean(row.worker_name);
  const i = wn.indexOf(".");
  if (i <= 0) return { account: "", worker: "" };
  return { account: wn.slice(0, i), worker: wn.slice(i + 1) };
}
function tail(s) {
  const str = clean(s);
  const i = str.lastIndexOf(".");
  return i >= 0 ? str.slice(i + 1) : str;
}
const workerKey = (w) => {
  const s = clean(w).toLowerCase();
  const k = s.replace(/^0+/, "");
  return k === "" ? "0" : k;
};
function f2slug(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC" || c === "BITCOIN") return "bitcoin";
  if (c === "BCH" || c === "BCHN") return "bitcoin-cash";
  if (c === "BSV") return "bitcoin-sv";
  if (c === "LTC" || c === "LITECOIN") return "litecoin";
  if (c === "KAS" || c === "KASPA") return "kaspa";
  if (c === "CFX" || c === "CONFLUX") return "conflux";
  if (c === "ETC") return "ethereum-classic";
  if (c === "DASH") return "dash";
  if (c === "SC" || c === "SIA") return "sia";
  return c.toLowerCase();
}

/* ===== fetch com timeout + retry (porque httpStatus:0 = erro/timeout) ===== */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}
async function fetchJSON(url, opts, timeoutMs, expect200 = true) {
  const resp = await fetchWithTimeout(url, opts, timeoutMs);
  if (expect200 && !resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`HTTP ${resp.status} ${resp.statusText} – ${text.slice(0, 200)}`);
    err.httpStatus = resp.status;
    throw err;
  }
  return { resp, data: await resp.json().catch(() => null) };
}
async function tryFetchWithBackoff(fn, tries = 3, baseDelayMs = 500) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseDelayMs * (i + 1) + Math.random() * 300));
    }
  }
  throw lastErr;
}

/* ===== normalizador de workers → { name, online } ===== */
function normalizeWorkersToOnline(list) {
  const out = [];
  const push = (name, hashrate, lastShare, onlineHint) => {
    const hr = Number(hashrate ?? 0);
    let last = null;
    if (typeof lastShare === "number" && isFinite(lastShare)) {
      last = lastShare > 1e11 ? new Date(lastShare) : new Date(lastShare * 1000);
    } else if (typeof lastShare === "string" && lastShare) {
      const t = Date.parse(lastShare);
      if (!Number.isNaN(t)) last = new Date(t);
    }
    const fresh = last ? (Date.now() - last.getTime() < 90 * 60 * 1000) : false; // 90 min
    const online = onlineHint === true ? true : (hr > 0 || fresh);
    out.push({ name: clean(name), online });
  };
  for (const w of list || []) {
    const name = clean(w?.name ?? w?.worker ?? w?.workerName ?? "");
    const hr = w?.hashrate ?? w?.hashrate_10min ?? w?.hashrate_1h ?? w?.h1 ?? w?.h24 ?? w?.hr ?? 0;
    const last = w?.last_share ?? w?.last_share_time ?? w?.lastShare ?? w?.lastShareTime ?? null;
    const hint = typeof w?.online === "boolean"
      ? w.online
      : (w?.worker_status && String(w.worker_status).toLowerCase() === "active") ? true : undefined;
    push(name, hr, last, hint);
  }
  return out;
}

/* ===== F2Pool API: v2 com token (miners.api_key) + fallback v1 pública ===== */
// Docs: header F2P-API-SECRET e POST para /v2/{request_name}. :contentReference[oaicite:0]{index=0}
async function f2poolV2Workers(account, coin, token) {
  if (!token) return { ok: false, status: 0, workers: [], endpoint: null };
  const slug = f2slug(coin);
  const headers = { "Content-Type": "application/json", "F2P-API-SECRET": token, "Accept": "application/json" };

  // Tentamos alguns endpoints usuais; paramos no primeiro 200
  const endpoints = [
    "https://api.f2pool.com/v2/workers",
    "https://api.f2pool.com/v2/miner/workers",
    "https://api.f2pool.com/v2/worker/list",
  ];

  let lastStatus = 0, lastErr = "";
  for (const url of endpoints) {
    try {
      const { data, resp } = await tryFetchWithBackoff(
        () => fetchJSON(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ currency: slug, user_name: account }),
        }, 8000, true),
        2, 600
      );
      // tenta extrair array de workers em chaves comuns
      const arr = Array.isArray(data?.workers) ? data.workers
                : Array.isArray(data?.data?.workers) ? data.data.workers
                : Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.result?.workers) ? data.result.workers
                : [];
      const workers = normalizeWorkersToOnline(arr);
      return { ok: true, status: resp.status, workers, endpoint: url, raw: data };
    } catch (e) {
      lastStatus = e?.httpStatus || 0;
      lastErr = String(e?.message || e);
    }
  }
  return { ok: false, status: lastStatus, workers: [], endpoint: null, error: lastErr };
}

async function f2poolV1Workers(account, coin) {
  const slug = f2slug(coin);
  const url = `https://api.f2pool.com/${slug}/${account}`;
  try {
    const { data, resp } = await tryFetchWithBackoff(
      () => fetchJSON(url, { method: "GET", headers: { "Accept": "application/json" } }, 8000, true),
      2, 600
    );

    let arr = [];
    if (Array.isArray(data?.workers)) {
      if (Array.isArray(data.workers[0])) {
        arr = data.workers.map(a => {
          const name = clean(String(a[0] ?? ""));
          const nums = a.filter(x => typeof x === "number");
          const hr = nums.length ? Math.max(...nums) : 0;
          const last = a.find(v => typeof v === "string" && /\d{4}-\d{2}-\d{2}T/.test(v))
                    ?? a.find(v => typeof v === "number" && v > 1e9) ?? null;
          const offlineFlag = typeof a[a.length - 1] === "boolean" ? a[a.length - 1] : undefined;
          return { name, hashrate: hr, last_share: last, online: offlineFlag === undefined ? undefined : !offlineFlag };
        });
      } else {
        arr = data.workers;
      }
    } else if (data?.workers && typeof data.workers === "object") {
      arr = Object.entries(data.workers).map(([name, v]) => {
        if (typeof v === "number") return { name, hashrate: v };
        return { name, ...v };
      });
    } else if (Array.isArray(data?.miners)) {
      arr = data.miners;
    }
    const workers = normalizeWorkersToOnline(arr);
    return { ok: true, status: resp.status, workers, endpoint: url, raw: data };
  } catch (e) {
    return { ok: false, status: e?.httpStatus || 0, workers: [], endpoint: url, error: String(e?.message || e) };
  }
}

async function fetchF2PoolWorkers(account, coin, token) {
  // 1) v2 com token; 2) fallback v1 pública
  const v2 = await f2poolV2Workers(account, coin, token);
  if (v2.ok) return v2;
  const v1 = await f2poolV1Workers(account, coin);
  return v1.ok ? v1 : { ok: false, status: v1.status || v2.status || 0, workers: [], error: v1.error || v2.error };
}

/* ===== dedupe de horas por slot ===== */
let lastSlot = null;
const updatedInSlot = new Set();
function beginSlot(s) { if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); } }
function dedupeForHours(ids) {
  const out = [];
  for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); }
  return out;
}

/* ===== Job principal ===== */
export async function runUptimeF2PoolOnce() {
  const t0 = Date.now();
  const sISO = slotISO();
  beginSlot(sISO);

  const lockKey = `uptime:${sISO}:f2pool`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) {
    console.log(`[uptime:f2pool] lock ativo (${sISO}) – ignorado nesta instância.`);
    return { ok: true, skipped: true };
  }

  let hoursUpdated = 0, statusToOnline = 0, statusToOffline = 0, groups = 0;

  try {
    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, coin, api_key
      FROM miners
      WHERE pool = 'F2Pool'
        AND worker_name IS NOT NULL
    `;
    if (!minersRaw.length) {
      console.log(`[uptime:f2pool] ${sISO} groups=0 miners=0 api=0 online(+hrs)=0 statusOn=0 statusOff=0 dur=${Date.now()-t0}ms`);
      return { ok: true, updated: 0, statusChanged: 0 };
    }

    const miners = minersRaw
      .map(r => {
        const { account, worker } = splitAccountWorker(r);
        return { ...r, account, worker, token: clean(r.api_key || "") };
      })
      .filter(m => m.account && m.worker);

    const groupMap = new Map(); // "account|coin|token"
    for (const m of miners) {
      const key = `${m.account}|${m.coin ?? ""}|${m.token}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(m);
    }
    groups = groupMap.size;

    for (const [k, list] of groupMap.entries()) {
      const [account, coin, token] = k.split("|");
      try {
        const suffixToIds = new Map();
        const allIds = [];
        for (const m of list) {
          allIds.push(m.id);
          const sfxNorm = workerKey(m.worker); // ex.: "001" -> "1"
          if (!sfxNorm) continue;
          if (!suffixToIds.has(sfxNorm)) suffixToIds.set(sfxNorm, []);
          suffixToIds.get(sfxNorm).push(m.id);
        }

        console.log("[uptime:f2pool] GROUP START", {
          account, coin, miners: list.length,
          wantWorkers: Array.from(suffixToIds.keys()),
          auth: token ? "v2-token" : "v1-public"
        });

        const { ok, status, workers, endpoint, error } = await fetchF2PoolWorkers(account, coin, token || undefined);
        if (!ok) {
          console.warn("[uptime:f2pool] GROUP SKIPPED", { account, coin, httpStatus: status || 0, auth: token ? "v2-token" : "v1-public", endpoint, error });
          continue; // NÃO marcar offline em falha de API
        }

        // classifica por SUFIXO (API pode devolver "account.worker")
        const onlineIdsRaw = [];
        for (const w of workers) {
          const sufNorm = workerKey(tail(w.name) || w.name);
          if (!suffixToIds.has(sufNorm)) continue;
          if (w.online) onlineIdsRaw.push(...(suffixToIds.get(sufNorm) || []));
        }

        const onlineSet = new Set(onlineIdsRaw);
        const offlineIdsRaw = list.map(m => m.id).filter(id => !onlineSet.has(id));

        // 1) horas online (dedupe por slot)
        const onlineIdsForHours = dedupeForHours(onlineIdsRaw);
        if (onlineIdsForHours.length) {
          await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
            WHERE id = ANY(${onlineIdsForHours})
          `;
          hoursUpdated += onlineIdsForHours.length;
        }

        // 2) status (só quando difere)
        if (onlineIdsRaw.length) {
          const r1 = await sql/*sql*/`
            UPDATE miners
            SET status = 'online'
            WHERE id = ANY(${onlineIdsRaw})
              AND status IS DISTINCT FROM 'online'
            RETURNING id
          `;
          statusToOnline += Array.isArray(r1) ? r1.length : (r1?.count || 0);
        }
        if (offlineIdsRaw.length) {
          const r2 = await sql/*sql*/`
            UPDATE miners
            SET status = 'offline'
            WHERE id = ANY(${offlineIdsRaw})
              AND status IS DISTINCT FROM 'offline'
            RETURNING id
          `;
          statusToOffline += Array.isArray(r2) ? r2.length : (r2?.count || 0);
        }

        console.log("[uptime:f2pool] GROUP RESULT", {
          account, coin, endpoint,
          onlineAPI: onlineIdsRaw.length,
          offlineAPI: offlineIdsRaw.length,
          inc: onlineIdsForHours.length
        });
      } catch (e) {
        console.error("[uptime:f2pool] GROUP ERROR", { account, coin, err: String(e?.message || e) });
      }
    }

    console.log(`[uptime:f2pool] ${sISO} groups=${groups} online(+hrs)=${hoursUpdated} statusOn=${statusToOnline} statusOff=${statusToOffline} dur=${Date.now()-t0}ms`);
    return { ok: true, updated: hoursUpdated, statusChanged: statusToOnline + statusToOffline };
  } catch (e) {
    console.error("⛔ uptime:f2pool", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeF2Pool() {
  cron.schedule(
    "*/15 * * * *",
    async () => { try { await runUptimeF2PoolOnce(); } catch (e) { console.error("⛔ f2pool cron:", e); } },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] F2Pool (*/15) agendado.");
}
