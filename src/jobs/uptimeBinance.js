// src/jobs/uptimeBinance.js
import crypto from "crypto";
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/* ====== Config Debug ====== */
const BINANCE_DEBUG = process.env.BINANCE_DEBUG === "1";
const DEBUG_ACCOUNTS = new Set((process.env.BINANCE_DEBUG_ACCOUNTS || "toplessEI")
  .split(",").map(s => s.trim()).filter(Boolean));

/** === time slot (15 min, UTC) === */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/** === helpers === */
const norm = (s) => String(s ?? "").trim();
/** remove zero-width, normaliza NFKC e trim */
function clean(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}
function mask(s, keep = 6) {
  const t = String(s ?? "");
  if (!t) return "";
  return t.slice(0, keep) + "***" + t.slice(-2);
}
function mapAlgo(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "sha256";
  if (c === "LTC") return "scrypt";
  if (c === "KAS" || c === "KASPA") return "kHeavyHash";
  return "";
}

/** Extrai MiningAccount e Worker a partir de "MiningAccount.Worker". */
function splitAccountWorker(row) {
  const wn = clean(row.worker_name);
  const dot = wn.indexOf(".");
  if (dot <= 0) return { account: "", worker: "" }; // inválido
  return { account: wn.slice(0, dot), worker: wn.slice(dot + 1) };
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

/** Lista todos os workers de uma conta (pagina até esgotar) + DEBUG */
async function binanceListWorkers({ apiKey, secretKey, algo, userName }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const pageSize = 200;
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
    if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
      console.log("[binance:debug] list",
        { userName, algo, page, status: resp.status, ok: resp.ok, apiKey: mask(apiKey) }
      );
    }
    if (!resp.ok) break;
    const data = await resp.json().catch(() => null);
    const arr = data?.data?.workerDatas || [];
    all.push(...arr);
    const pageSizeResp = Number(data?.data?.pageSize || 0);
    if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
      const sample = arr.slice(0, 10).map(w => ({
        workerName: w?.workerName,
        status: w?.status,
        hashRate: w?.hashRate,
        lastShareTime: w?.lastShareTime
      }));
      console.log("[binance:debug] page sample", sample);
    }
    if (!arr.length || arr.length < (pageSizeResp || pageSize)) break;
    page += 1;
  }
  return all.map(w => ({
    workerName: clean(w?.workerName),
    status: Number(w?.status ?? 0),        // 1 valid, 2 invalid, 3 no longer valid
    hashRate: Number(w?.hashRate ?? 0),
    lastShareTime: Number(w?.lastShareTime ?? 0),
  }));
}

/** Detalhe de um worker (diagnóstico extra) */
async function binanceWorkerDetail({ apiKey, secretKey, algo, userName, workerName }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const params = { algo, userName, workerName, timestamp: Date.now(), recvWindow: 10_000 };
  const url = `${BINANCE_BASE}/sapi/v1/mining/worker/detail?` + signQuery(secretKey, params);
  const resp = await fetchWithRetry(url, { headers }, 2);
  if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
    console.log("[binance:debug] detail",
      { userName, workerName, algo, status: resp.status, ok: resp.ok, apiKey: mask(apiKey) });
  }
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data;
}

/** Online se hashRate > 0 OU status==1 */
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

  // Lock distribuído
  const lockKey = `uptime:${sISO}:binance`;
  const gotRedis = await redis.set(lockKey, "1", { nx: true, ex: 20 * 60 });
  if (!gotRedis) {
    console.log(`[uptime:binance] lock ativo (${sISO}) – skip`);
    return { ok: true, skipped: true };
  }

  let hoursUpdated = 0;
  let statusToOnline = 0;
  let statusToOffline = 0;
  let groupsCount = 0;
  let apiCalls = 0;

  try {
    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, api_key, secret_key, coin, status
      FROM miners
      WHERE pool = 'Binance'
        AND api_key IS NOT NULL AND secret_key IS NOT NULL
        AND worker_name IS NOT NULL
    `;
    if (!minersRaw.length) return { ok: true, updated: 0, statusChanged: 0 };

    const miners = minersRaw
      .map(r => {
        const { account, worker } = splitAccountWorker(r);
        const algo = mapAlgo(r.coin);
        return { ...r, account: clean(account), worker: clean(worker), algo };
      })
      .filter(m => m.account && m.worker && m.algo);

    // DEBUG: listar entradas inválidas descartadas
    if (BINANCE_DEBUG) {
      const invalid = minersRaw.filter(r => {
        const { account, worker } = splitAccountWorker(r);
        return !(account && worker && mapAlgo(r.coin));
      });
      if (invalid.length) {
        console.warn("[binance:debug] DESCARTADOS (sem ponto ou coin inválida):",
          invalid.map(x => ({ id: x.id, worker_name: x.worker_name, coin: x.coin })));
      }
    }

    // Agrupa por credenciais + account + algo
    const groups = new Map();
    for (const m of miners) {
      const k = `${m.api_key}|${m.secret_key}|${m.account}|${m.algo}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    groupsCount = groups.size;

    const CONC = 3;
    const running = new Set();

    async function processGroup(key, list) {
      const [apiKey, secretKey, userName, algo] = key.split("|");

      // mapa worker -> [ids]
      const want = new Map();
      for (const m of list) {
        const w = clean(m.worker);
        if (!w) continue;
        if (!want.has(w)) want.set(w, []);
        want.get(w).push(m.id);
      }

      if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
        console.log("[binance:debug] GROUP START", {
          account: userName, algo, miners: list.length,
          apiKey: mask(apiKey), secretKey: mask(secretKey)
        });
        console.log("[binance:debug] WANT workers:", Array.from(want.keys()));
      }

      const workers = await binanceListWorkers({ apiKey, secretKey, algo, userName });
      apiCalls += 1;

      // opcional: dump nomes para ver diferenças de casing/whitespace
      if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
        const names = workers.map(w => w.workerName);
        console.log("[binance:debug] API workers names:", names);
      }

      let onlineIdsRaw = [];
      let offlineIdsRaw = [];

      // match exato após clean() dos dois lados
      for (const w of workers) {
        const name = clean(w.workerName);
        if (!want.has(name)) continue;
        const ids = want.get(name);
        if (isOnlineBinance(w)) onlineIdsRaw.push(...ids);
        else offlineIdsRaw.push(...ids);
      }

      // tudo o que pedimos e NÃO veio na API → offline
      for (const [wName, ids] of want.entries()) {
        const seen = onlineIdsRaw.concat(offlineIdsRaw);
        if (!seen.some(id => ids.includes(id))) {
          offlineIdsRaw.push(...ids);
          if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
            console.warn("[binance:debug] NOT IN API, marking OFFLINE", { account: userName, wName });
          }
        }
      }

      // DEBUG extra para um worker específico (ex.: toplessEI.001)
      if (BINANCE_DEBUG && DEBUG_ACCOUNTS.has(userName)) {
        const target = "001"; // sufixo do teu worker
        const wantHas = want.has(target);
        console.log("[binance:debug] target presence", {
          account: userName,
          target,
          wantHas,
          onlineContains: onlineIdsRaw.length ? "yes" : "no",
        });

        if (wantHas) {
          // chama detail para diagnóstico final
          const detail = await binanceWorkerDetail({ apiKey, secretKey, algo, userName, workerName: target });
          console.log("[binance:debug] DETAIL response (sanitized)", {
            account: userName,
            target,
            ok: !!detail,
            data: detail?.data ? {
              status: detail.data.status,
              workerName: detail.data.workerName,
              type: detail.data.type,
              hashRate: detail.data.hashRate,
              dayHashRate: detail.data.dayHashRate,
              lastShareTime: detail.data.lastShareTime
            } : null
          });
        }
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
      const incCount = Number(r?.[0]?.inc_count || 0);
      const onCount  = Number(r?.[0]?.on_count  || 0);
      const offCount = Number(r?.[0]?.off_count || 0);

      hoursUpdated   += incCount;
      statusToOnline += onCount;
      statusToOffline+= offCount;

      const coverage = list.length ? (onlineIdsRaw.length / list.length) : 0;
      console.log(`[uptime:binance] account=${userName} algo=${algo} miners=${list.length} onlineAPI=${onlineIdsRaw.length} offlineAPI=${offlineIdsRaw.length} cover=${(coverage*100).toFixed(1)}% inc=${incCount} on=${onCount} off=${offCount}`);
    }

    for (const [key, list] of groups.entries()) {
      const p = processGroup(key, list).finally(() => running.delete(p));
      running.add(p);
      if (running.size >= CONC) await Promise.race(running);
    }
    await Promise.allSettled(Array.from(running));

    console.log(`[uptime:binance] slot=${sISO} groups=${groupsCount} api=${apiCalls} +hrs=${hoursUpdated} statusOn=${statusToOnline} statusOff=${statusToOffline}`);
    return { ok: true, groups: groupsCount, updated: hoursUpdated, statusChanged: statusToOnline + statusToOffline };
  } catch (e) {
    console.error("⛔ uptime:binance", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeBinance() {
  cron.schedule(
    "*/15 * * * *",
    async () => { try { await runUptimeBinanceOnce(); } catch (e) { console.error("⛔ binance cron:", e); } },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] Binance (*/15) agendado.");
}
