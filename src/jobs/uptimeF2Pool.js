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
  if (c === "BCH") return "bitcoin-cash";
  if (c === "BSV") return "bitcoin-sv";
  if (c === "LTC" || c === "LITECOIN") return "litecoin";
  if (c === "KAS" || c === "KASPA") return "kaspa";
  if (c === "CFX") return "conflux";
  if (c === "ETC") return "ethereum-classic";
  if (c === "DASH") return "dash";
  if (c === "SC" || c === "SIA") return "sia";
  return c.toLowerCase();
}

/* ===== Parser "online" genérico ===== */
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
    const now = Date.now();
    const freshMs = 90 * 60 * 1000; // 90 min de folga
    const fresh = last ? (now - last.getTime() < freshMs) : false;
    const online = onlineHint === true ? true : (hr > 0 || fresh);
    out.push({ name: clean(name), online });
  };
  for (const w of list) {
    if (!w) continue;
    const name = clean(w.name ?? w.worker ?? w.workerName ?? "");
    const hr = w.hashrate ?? w.hashrate_10min ?? w.hashrate_1h ?? w.h1 ?? w.h24 ?? w.hr ?? 0;
    const last = w.last_share ?? w.last_share_time ?? w.lastShare ?? w.lastShareTime ?? null;
    const hint = typeof w.online === "boolean" ? w.online :
                 (w.worker_status && String(w.worker_status).toLowerCase() === "active") ? true : undefined;
    push(name, hr, last, hint);
  }
  return out;
}

/* ===== F2Pool API fetchers ===== */

/** v2 com token no header (usa miners.api_key como token). Posta currency + user_name. */
async function f2poolV2Workers(account, coin, token) {
  if (!token) return { ok: false, status: 0, workers: [] };
  const slug = f2slug(coin);
  const headers = { "Content-Type": "application/json", "F2P-API-SECRET": token };

  // vários endpoints possíveis (mudaram ao longo do tempo). Tentamos 2 e ficamos com o 1º que der 200.
  const candidates = [
    "https://api.f2pool.com/v2/workers",
    "https://api.f2pool.com/v2/miner/workers",
  ];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ currency: slug, user_name: account }),
        timeout: 10000,
      });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      if (!data) continue;

      // tenta localizar array de workers em várias chaves comuns
      const arr = Array.isArray(data.workers) ? data.workers
                : Array.isArray(data.data?.workers) ? data.data.workers
                : Array.isArray(data.data) ? data.data
                : Array.isArray(data.result?.workers) ? data.result.workers
                : [];
      const workers = normalizeWorkersToOnline(arr);
      return { ok: true, status: 200, workers, used: "v2", endpoint: url };
    } catch {}
  }
  return { ok: false, status: 0, workers: [] };
}

/** v1 pública (sem token): GET /{slug}/{account} */
async function f2poolV1Workers(account, coin) {
  const slug = f2slug(coin);
  const url = `https://api.f2pool.com/${slug}/${account}`;
  try {
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) return { ok: false, status: resp.status, workers: [] };
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, status: 200, workers: [] };

    // normaliza diferentes formatos de v1 para a mesma shape
    let arr = [];
    if (Array.isArray(data.workers)) {
      if (Array.isArray(data.workers[0])) {
        // ex.: array de arrays
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
        // ex.: array de objetos
        arr = data.workers;
      }
    } else if (data.workers && typeof data.workers === "object") {
      // mapa name -> valor
      arr = Object.entries(data.workers).map(([name, v]) => {
        if (typeof v === "number") return { name, hashrate: v };
        return { name, ...v };
      });
    } else if (Array.isArray(data.miners)) {
      arr = data.miners;
    }
    const workers = normalizeWorkersToOnline(arr);
    return { ok: true, status: 200, workers, used: "v1", endpoint: url };
  } catch {
    return { ok: false, status: 0, workers: [] };
  }
}

/** fetch unificado com fallback */
async function fetchF2PoolWorkers(account, coin, token) {
  // tenta v2 com token; se não resultar, cai para v1
  const v2 = await f2poolV2Workers(account, coin, token);
  if (v2.ok) return v2;
  const v1 = await f2poolV1Workers(account, coin);
  return v1.ok ? v1 : { ok: false, status: 0, workers: [] };
}

/* ===== dedupe de horas por slot ===== */
let lastSlot = null;
const updatedInSlot = new Set();
function beginSlot(s) {
  if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); }
}
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

  // lock do slot (14m)
  const lockKey = `uptime:${sISO}:f2pool`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) {
    console.log(`[uptime:f2pool] lock ativo (${sISO}) – ignorado nesta instância.`);
    return { ok: true, skipped: true };
  }

  let hoursUpdated = 0;
  let statusToOnline = 0;
  let statusToOffline = 0;
  let groups = 0;

  try {
    // Lê miners desta pool; precisa de worker_name no formato account.worker
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

    // normaliza, exige account.worker
    const miners = minersRaw
      .map(r => {
        const { account, worker } = splitAccountWorker(r);
        return { ...r, account, worker, token: clean(r.api_key || "") };
      })
      .filter(m => m.account && m.worker);

    // agrupa por (account, coin, token) — token pode ser vazio (v1)
    const groupMap = new Map(); // "account|coin|token" -> Miner[]
    for (const m of miners) {
      const key = `${m.account}|${m.coin ?? ""}|${m.token}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(m);
    }
    groups = groupMap.size;

    for (const [k, list] of groupMap.entries()) {
      const [account, coin, token] = k.split("|");
      try {
        // map sufixo normalizado -> [ids]; e recolhe todos ids
        const suffixToIds = new Map();
        const allIds = [];
        for (const m of list) {
          allIds.push(m.id);
          const sfxNorm = workerKey(m.worker);
          if (!sfxNorm) continue;
          if (!suffixToIds.has(sfxNorm)) suffixToIds.set(sfxNorm, []);
          suffixToIds.get(sfxNorm).push(m.id);
        }

        console.log("[uptime:f2pool] GROUP START", {
          account, coin, miners: list.length, wantWorkers: Array.from(suffixToIds.keys()),
          auth: token ? "v2-token" : "v1-public"
        });

        // chama API (não marca offline se a API falhar)
        const { ok, status, workers, used, endpoint } = await fetchF2PoolWorkers(account, coin, token || undefined);
        if (!ok) {
          console.warn("[uptime:f2pool] GROUP SKIPPED", { account, coin, httpStatus: status, auth: token ? "v2-token" : "v1-public" });
          continue;
        }

        // classifica por sufixo (API pode devolver "account.worker")
        const onlineIdsRaw = [];
        for (const w of workers) {
          const sufNorm = workerKey(tail(w.name) || w.name);
          if (!suffixToIds.has(sufNorm)) continue;
          if (w.online) onlineIdsRaw.push(...(suffixToIds.get(sufNorm) || []));
        }

        // offline = todos do grupo que não ficaram online
        const onlineSet = new Set(onlineIdsRaw);
        const offlineIdsRaw = allIds.filter(id => !onlineSet.has(id));

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
          account, coin, auth: used || (token ? "v2-token" : "v1-public"),
          endpoint, onlineAPI: onlineIdsRaw.length, offlineAPI: offlineIdsRaw.length, inc: onlineIdsForHours.length
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
