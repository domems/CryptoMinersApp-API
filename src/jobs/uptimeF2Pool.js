// src/jobs/uptimeF2Pool.js
import cron from "node-cron";
import fetch from "node-fetch";
import dns from "dns";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/* ===== mata proxies marados e força IPv4-first ===== */
for (const k of ["HTTP_PROXY","http_proxy","HTTPS_PROXY","https_proxy","NO_PROXY","no_proxy"]) {
  if (process.env[k]) { console.warn(`[uptime:f2pool] ignorando ${k}=${process.env[k]}`); delete process.env[k]; }
}
dns.setDefaultResultOrder?.("ipv4first");

/* ===== slot 15m (UTC) ===== */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes(), q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/* ===== helpers ===== */
const clean = (s) => String(s ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
function splitAccountWorker(row) {
  const wn = clean(row.worker_name); const i = wn.indexOf(".");
  if (i <= 0) return { account: "", worker: "" };
  return { account: wn.slice(0, i), worker: wn.slice(i + 1) };
}
function tail(s) { const str = clean(s); const i = str.lastIndexOf("."); return i >= 0 ? str.slice(i + 1) : str; }
const workerKey = (w) => { const s = clean(w).toLowerCase(); const k = s.replace(/^0+/, ""); return k === "" ? "0" : k; };
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

/* ===== fetch util (timeout + retry/backoff) ===== */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(to); }
}
async function tryJSON(url, opts, timeoutMs, expectOK = true) {
  const resp = await fetchWithTimeout(url, opts, timeoutMs);
  const text = await resp.text().catch(() => "");
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (expectOK && !resp.ok) { const err = new Error(`HTTP ${resp.status} ${resp.statusText} – ${text.slice(0,240)}`); err.httpStatus = resp.status; throw err; }
  return { resp, data };
}
async function backoff(fn, tries = 3, base = 700) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, base*(i+1) + Math.random()*200)); }
  }
  throw lastErr;
}

/* ===== heurísticas agressivas de extração ===== */
function guessNameFromObject(w) {
  if (!w || typeof w !== "object") return "";
  const entries = Object.entries(w);
  const candidates = [];
  for (const [k, v] of entries) {
    if (typeof v !== "string") continue;
    const s = clean(v);
    if (!s) continue;
    const lk = k.toLowerCase();
    if (lk.includes("worker") || lk.includes("name") || lk === "id" || lk.endsWith("_id")) {
      candidates.push(s);
    }
  }
  // preferir algo com ".", ou com dígitos no fim (tipo 001), depois o mais longo
  candidates.sort((a, b) =>
    (b.includes(".") - a.includes(".")) ||
    ((/\d+$/.test(b)) - (/\d+$/.test(a))) ||
    (b.length - a.length)
  );
  return candidates[0] || "";
}
function guessHashrateFromObject(w) {
  let best = 0;
  for (const [k, v] of Object.entries(w || {})) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    const lk = k.toLowerCase();
    if (lk.includes("hash") || lk.includes("rate") || lk === "hr" || lk.endsWith("_hr")) {
      if (v > best) best = v;
    }
  }
  return best;
}
function guessLastShareFromObject(w) {
  for (const [k, v] of Object.entries(w || {})) {
    const lk = k.toLowerCase();
    if (!(lk.includes("last") && (lk.includes("share") || lk.includes("submit") || lk.includes("time") || lk.includes("ts")))) continue;
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/* ===== normalizador -> [{ name, online }] ===== */
function normalizeWorkersToOnline(list) {
  const out = [];
  const push = (name, hashrate, lastShare, onlineHint) => {
    const hr = Number(hashrate ?? 0);
    let last = null;
    if (typeof lastShare === "number" && isFinite(lastShare)) {
      last = lastShare > 1e11 ? new Date(lastShare) : new Date(lastShare*1000);
    } else if (typeof lastShare === "string" && lastShare) {
      const t = Date.parse(lastShare); if (!Number.isNaN(t)) last = new Date(t);
    }
    const fresh = last ? (Date.now() - last.getTime() < 90*60*1000) : false; // 90m
    const online = onlineHint === true ? true : (hr > 0 || fresh);
    if (clean(name)) out.push({ name: clean(name), online }); // IGNORA entradas sem nome
  };

  for (const w of list || []) {
    let name = clean(w?.name ?? w?.worker ?? w?.worker_name ?? w?.workerName ?? "");
    if (!name) name = guessNameFromObject(w);

    const hr = w?.hashrate ?? w?.hash_rate ?? w?.hashrate_10min ?? w?.hashrate_10m
            ?? w?.hashrate_1h ?? w?.curr_hashrate ?? w?.h1 ?? w?.h24 ?? w?.hr
            ?? guessHashrateFromObject(w) ?? 0;

    const last = w?.last_share ?? w?.last_share_time ?? w?.lastShare ?? w?.lastShareTime
              ?? w?.last_submit_time ?? w?.last_share_timestamp ?? guessLastShareFromObject(w) ?? null;

    const hint = typeof w?.online === "boolean"
      ? w.online
      : (w?.worker_status && String(w.worker_status).toLowerCase() === "active")
        || (String(w?.status ?? "").toLowerCase() === "active")
        || (Number(w?.status) === 1);

    push(name, hr, last, !!hint);
  }
  return out;
}

/* ===== F2Pool v2 (token em miners.api_key) com paginação + fallback v1 ===== */
async function f2poolV2Workers(account, coin, token) {
  if (!token) return { ok: false, status: 0, workers: [], endpoint: null };
  const headers = { "Content-Type": "application/json", "Accept": "application/json", "F2P-API-SECRET": token };
  const endpoints = [
    "https://api.f2pool.com/v2/hash_rate/worker/list",
    "https://api.f2pool.com/v2/hashrate/worker/list", // alias defensivo
  ];
  const size = 200;

  for (const url of endpoints) {
    const all = [];
    let lastStatus = 0, lastErr = "";
    for (let page = 1; page <= 5; page++) {
      const body = JSON.stringify({ currency: f2slug(coin), mining_user_name: account, page, size });
      try {
        const { data, resp } = await backoff(() => tryJSON(url, { method: "POST", headers, body }, 15000, true), 2, 800);
        lastStatus = resp.status;
        const arr = Array.isArray(data?.workers) ? data.workers
                  : Array.isArray(data?.data?.workers) ? data.data.workers
                  : Array.isArray(data?.data?.list) ? data.data.list
                  : Array.isArray(data?.list) ? data.list
                  : Array.isArray(data?.result?.workers) ? data.result.workers
                  : Array.isArray(data?.result?.list) ? data.result.list
                  : Array.isArray(data?.items) ? data.items
                  : Array.isArray(data) ? data : [];
        all.push(...arr);
        const total = Number(data?.data?.total ?? data?.total ?? 0);
        const hasMore = (arr.length === size) && (!total || page*size < total);
        if (!hasMore) break;
      } catch (e) {
        lastErr = String(e?.message || e); lastStatus = e?.httpStatus || 0; break; // tenta próximo endpoint
      }
    }
    if (all.length) {
      const workers = normalizeWorkersToOnline(all);
      return { ok: true, status: lastStatus || 200, workers, endpoint: url };
    }
    if (lastErr) console.warn("[uptime:f2pool] v2 endpoint falhou", { endpoint: url, lastStatus, lastErr });
  }
  return { ok: false, status: 0, workers: [], endpoint: null, error: "v2 no response" };
}

async function f2poolV1Workers(account, coin) {
  const url = `https://api.f2pool.com/${f2slug(coin)}/${account}`;
  try {
    const { data, resp } = await backoff(
      () => tryJSON(url, { method: "GET", headers: { "Accept": "application/json" } }, 12000, true),
      2, 700
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
      } else arr = data.workers;
    } else if (data?.workers && typeof data.workers === "object") {
      arr = Object.entries(data.workers).map(([name, v]) => (typeof v === "number" ? { name, hashrate: v } : { name, ...v }));
    } else if (Array.isArray(data?.miners)) arr = data.miners;
    const workers = normalizeWorkersToOnline(arr);
    return { ok: true, status: resp.status, workers, endpoint: url };
  } catch (e) {
    return { ok: false, status: e?.httpStatus || 0, workers: [], endpoint: url, error: String(e?.message || e) };
  }
}

async function fetchF2PoolWorkers(account, coin, token) {
  const v2 = await f2poolV2Workers(account, coin, token);
  if (v2.ok) return v2;
  const v1 = await f2poolV1Workers(account, coin);
  return v1.ok ? v1 : { ok: false, status: v1.status || v2.status || 0, workers: [], endpoint: v2.endpoint, error: v1.error || v2.error };
}

/* ===== dedupe horas por slot ===== */
let lastSlot = null;
const updatedInSlot = new Set();
function beginSlot(s) { if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); } }
function dedupeForHours(ids) { const out = []; for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); } return out; }

/* ===== Job principal ===== */
export async function runUptimeF2PoolOnce() {
  const t0 = Date.now(); const sISO = slotISO(); beginSlot(sISO);

  // lock por slot
  const lockKey = `uptime:${sISO}:f2pool`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) { console.log(`[uptime:f2pool] lock ativo (${sISO}) – ignorado.`); return { ok: true, skipped: true }; }

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
      .map(r => { const { account, worker } = splitAccountWorker(r); return { ...r, account, worker, token: clean(r.api_key || "") }; })
      .filter(m => m.account && m.worker);

    // agrupa por (account, coin, token)
    const groupMap = new Map();
    for (const m of miners) { const key = `${m.account}|${m.coin ?? ""}|${m.token}`; if (!groupMap.has(key)) groupMap.set(key, []); groupMap.get(key).push(m); }
    groups = groupMap.size;

    for (const [k, list] of groupMap.entries()) {
      const [account, coin, token] = k.split("|");
      try {
        // sufixo normalizado -> [ids]
        const suffixToIds = new Map(); const allIds = [];
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

        const { ok, status, workers, endpoint, error } = await fetchF2PoolWorkers(account, coin, token || undefined);
        if (!ok) {
          console.warn("[uptime:f2pool] GROUP SKIPPED", { account, coin, httpStatus: status || 0, auth: token ? "v2-token" : "v1-public", endpoint, error });
          continue; // NÃO marca offline quando API falha
        }

        // snapshot (5 primeiros) p/ ver match
        if ((workers?.length ?? 0) > 0) {
          const snap = workers.slice(0, 5).map(w => {
            const name = w.name; const t = tail(name) || name; const k = workerKey(t);
            return `${name} -> tail:${t} -> key:${k} -> online:${w.online ? 1 : 0}`;
          });
          console.log("[uptime:f2pool] API workers snapshot:", snap);
        } else {
          console.log("[uptime:f2pool] API workers EMPTY", { account, coin, endpoint });
        }

        // classificar por SUFIXO
        const onlineIdsRaw = [];
        for (const w of workers) {
          const sufNorm = workerKey(tail(w.name) || w.name);
          if (!suffixToIds.has(sufNorm)) continue;
          if (w.online) onlineIdsRaw.push(...(suffixToIds.get(sufNorm) || []));
        }

        // offline = todos do grupo que não ficaram online
        const onlineSet = new Set(onlineIdsRaw);
        const offlineIdsRaw = allIds.filter(id => !onlineSet.has(id));

        // 1) horas online (dedupe slot)
        const onlineIdsForHours = dedupeForHours(onlineIdsRaw);
        if (onlineIdsForHours.length) {
          const r = await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
            WHERE id = ANY(${onlineIdsForHours})
            RETURNING id
          `;
          hoursUpdated += (Array.isArray(r) ? r.length : (r?.count || 0));
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

        console.log("[uptime:f2pool] GROUP RESULT", {
          account, coin, endpoint,
          apiWorkers: workers.length,
          onlineAPI: onlineIdsRaw.length,
          offlineAPI: offlineIdsRaw.length,
          inc: onlineIdsForHours.length
        });
      } catch (e) {
        const code = e?.code || e?.errno || e?.type || "unknown";
        console.error("[uptime:f2pool] GROUP ERROR", { account, coin, code, err: String(e?.message || e) });
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
