// src/jobs/uptimeBinance.js
import crypto from "crypto";
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/** === time slot (15 min, UTC) === */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/** === helpers === */
const norm = (s) => String(s ?? "").trim();
const low  = (s) => norm(s).toLowerCase();

function mapAlgo(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "sha256";
  if (c === "LTC") return "scrypt";
  if (c === "KAS" || c === "KASPA") return "kHeavyHash";
  return ""; // força validação a falhar → skip
}

/** Extrai MiningAccount e Worker a partir de "MiningAccount.Worker".
 * Se não houver ".", tenta usar coluna `binance_user_name` (se vier na row). */
function splitAccountWorker(row) {
  const wn = norm(row.worker_name);
  const dot = wn.indexOf(".");
  if (dot > 0) return { account: wn.slice(0, dot), worker: wn.slice(dot + 1) };
  const account = norm(row.binance_user_name || "");
  const worker  = wn;
  return { account, worker };
}

/** === Binance signed fetch === */
const BINANCE_BASE = "https://api.binance.com";

function signQuery(secret, params) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

async function fetchWithRetry(url, opts = {}, retries = 2) {
  let attempt = 0;
  while (true) {
    attempt++;
    let resp;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), opts.timeout ?? 10_000);
      resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(to);
    } catch (e) {
      if (attempt > retries) throw e;
      await new Promise(r => setTimeout(r, 300 * attempt + Math.random() * 300));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt > retries) return resp;
      const ra = Number(resp.headers.get("retry-after")) || (300 * attempt);
      await new Promise(r => setTimeout(r, ra + Math.random() * 300));
      continue;
    }
    return resp;
  }
}

/** Lista TODOS os workers de uma conta (pagina até esgotar). */
async function binanceListWorkers({ apiKey, secretKey, algo, userName }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const pageSize = 200; // max razoável (doc default=20). Ajusta se precisares.
  let page = 1;
  const all = [];
  for (;;) {
    const params = {
      algo,
      userName,
      pageIndex: page,
      sort: 0,
      timestamp: Date.now(),
      recvWindow: 10_000,
    };
    const signed = signQuery(secretKey, params);
    const url = `${BINANCE_BASE}/sapi/v1/mining/worker/list?${signed}`;
    const resp = await fetchWithRetry(url, { headers }, 2);
    if (!resp.ok) break;
    const data = await resp.json().catch(() => null);
    const arr = data?.data?.workerDatas || [];
    all.push(...arr);
    const pageSizeResp = Number(data?.data?.pageSize || 0);
    if (!arr.length || arr.length < (pageSizeResp || pageSize)) break;
    page += 1;
  }
  return all.map(w => ({
    workerName: String(w?.workerName ?? ""),
    status: Number(w?.status ?? 0),        // 1 valid, 2 invalid, 3 no longer valid
    hashRate: Number(w?.hashRate ?? 0),    // realtime
    lastShareTime: Number(w?.lastShareTime ?? 0),
  }));
}

/** Online se hashRate > 0 OU status==1 (valid) — cf. docs. */
function isOnlineBinance(w) {
  if (Number.isFinite(w.hashRate) && w.hashRate > 0) return true;
  return Number(w.status) === 1;
}

/** === slot dedupe (in-process) === */
let lastSlot = null;
const updatedInSlot = new Set();
function beginSlot(s) { if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); } }
function dedupeForHours(ids) {
  const out = [];
  for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); }
  return out;
}

/** ===== Job principal ===== */
export async function runUptimeBinanceOnce() {
  const sISO = slotISO();
  beginSlot(sISO);

  // Lock distribuído (Redis) + backup lock PG
  const lockKey = `uptime:${sISO}:binance`;
  const gotRedis = await redis.set(lockKey, "1", { nx: true, ex: 20 * 60 });
  const lockHigh = 0x42494E5A; // 'BINZ'
  const lockLow  = Math.floor(new Date(sISO).getTime() / (15 * 60 * 1000));
  let gotPG = false;
  if (!gotRedis) {
    try {
      const r = await sql/*sql*/`SELECT pg_try_advisory_lock(${lockHigh}, ${lockLow}) AS ok`;
      gotPG = !!r?.[0]?.ok;
    } catch {}
    if (!gotPG) {
      console.log(`[uptime:binance] lock ativo (${sISO}) – skip`);
      return { ok: true, skipped: true };
    }
  }

  let hoursUpdated = 0;
  let statusToOnline = 0;
  let statusToOffline = 0;
  let groupsCount = 0;
  let apiCalls = 0;

  try {
    // Carrega miners da Binance
    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, api_key, secret_key, coin,
             NULLIF(binance_user_name, '') AS binance_user_name
      FROM miners
      WHERE pool = 'Binance'
        AND api_key IS NOT NULL AND secret_key IS NOT NULL
        AND worker_name IS NOT NULL
    `;

    if (!minersRaw.length) return { ok: true, updated: 0, statusChanged: 0 };

    // Normaliza (conta, worker, algo)
    const miners = minersRaw
      .map(r => {
        const { account, worker } = splitAccountWorker(r);
        const algo = mapAlgo(r.coin);
        return { ...r, account, worker, algo };
      })
      .filter(m => m.account && m.worker && m.algo);

    // Agrupa por credenciais + account + algo
    const groups = new Map(); // key -> Miner[]
    for (const m of miners) {
      const k = `${m.api_key}|${m.secret_key}|${m.account}|${m.algo}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    groupsCount = groups.size;

    // Concurrency simples (3 grupos em paralelo)
    const CONC = 3;
    const running = new Set();

    async function processGroup(key, list) {
      const [apiKey, secretKey, userName, algo] = key.split("|");
      // mapa worker -> [ids]
      const want = new Map();
      for (const m of list) {
        const w = norm(m.worker);
        if (!w) continue;
        if (!want.has(w)) want.set(w, []);
        want.get(w).push(m.id);
      }

      const workers = await binanceListWorkers({ apiKey, secretKey, algo, userName });
      apiCalls += 1;

      let onlineIdsRaw = [];
      let offlineIdsRaw = [];
      for (const w of workers) {
        const name = norm(w.workerName);
        if (!want.has(name)) continue; // ignora outros workers da conta
        const ids = want.get(name);
        if (isOnlineBinance(w)) onlineIdsRaw.push(...ids);
        else offlineIdsRaw.push(...ids);
      }
      // workers da lista que NÃO vieram na API → offline
      for (const [wName, ids] of want.entries()) {
        // se nenhum registo da API foi visto com esse nome, marca offline
        // (evita “fantasmas” não reportados)
        const seenOnline = onlineIdsRaw.some(id => ids.includes(id));
        const seenOffline = offlineIdsRaw.some(id => ids.includes(id));
        if (!seenOnline && !seenOffline) offlineIdsRaw.push(...ids);
      }

      // === Batch único via CTE ===
      const onlineIdsForHours = dedupeForHours(onlineIdsRaw);
      const r = await sql/*sql*/`
        WITH
        inc AS (
          UPDATE miners
          SET total_horas_online = COALESCE(total_horas_online, 0) + 0.25
          WHERE id = ANY(${onlineIdsForHours})
          RETURNING id
        ),
        onl AS (
          UPDATE miners
          SET status = 'online'
          WHERE id = ANY(${onlineIdsRaw})
            AND status IS DISTINCT FROM 'online'
          RETURNING id
        ),
        off AS (
          UPDATE miners
          SET status = 'offline'
          WHERE id = ANY(${offlineIdsRaw})
            AND status IS DISTINCT FROM 'offline'
          RETURNING id
        )
        SELECT
          (SELECT COUNT(*) FROM inc)  AS inc_count,
          (SELECT COUNT(*) FROM onl)  AS on_count,
          (SELECT COUNT(*) FROM off)  AS off_count
      `;
      hoursUpdated   += Number(r?.[0]?.inc_count || 0);
      statusToOnline += Number(r?.[0]?.on_count  || 0);
      statusToOffline+= Number(r?.[0]?.off_count || 0);

      const coverage = list.length ? (onlineIdsRaw.length / list.length) : 0;
      console.log(`[uptime:binance] account=${userName} algo=${algo} miners=${list.length} onlineAPI=${onlineIdsRaw.length} offlineAPI=${offlineIdsRaw.length} cover=${(coverage*100).toFixed(1)}%`);
    }

    for (const [key, list] of groups.entries()) {
      const p = processGroup(key, list).finally(() => running.delete(p));
      running.add(p);
      if (running.size >= CONC) await Promise.race(running);
    }
    await Promise.allSettled(Array.from(running));

    console.log(`[uptime:binance] slot=${sISO} groups=${groupsCount} miners=${miners.length} api=${apiCalls} +hrs=${hoursUpdated} statusOn=${statusToOnline} statusOff=${statusToOffline}`);
    return { ok: true, groups: groupsCount, updated: hoursUpdated, statusChanged: statusToOnline + statusToOffline };
  } catch (e) {
    console.error("⛔ uptime:binance", e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    try { await sql/*sql*/`SELECT pg_advisory_unlock(${lockHigh}, ${lockLow})`; } catch {}
  }
}

export function startUptimeBinance() {
  cron.schedule(
    "*/15 * * * *",
    async () => { try { await runUptimeBinanceOnce(); } catch (e) { console.error("⛔ binance cron:", e); } },
    { timezone: "Europe/Lisbon" } // mantém igual aos outros jobs
  );
  console.log("[jobs] Binance (*/15) agendado.");
}
