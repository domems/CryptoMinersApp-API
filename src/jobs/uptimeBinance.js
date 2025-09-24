// src/jobs/uptimeBinance.js
import crypto from "crypto";
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

/* ===== Bases possíveis (rota automaticamente) ===== */
const CANDIDATE_BASES = [
  process.env.BINANCE_BASE,
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
].filter(Boolean);

/* ===== time slot (15 min, UTC) ===== */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

/* ===== helpers ===== */
const norm = (s) => String(s ?? "").trim();
function clean(s) {
  return String(s ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}
function mask(s, keep = 6) {
  const t = String(s ?? "");
  if (!t) return "";
  if (t.length <= keep + 2) return `${t.slice(0, 2)}***`;
  return t.slice(0, keep) + "***" + t.slice(-2);
}
function mapAlgo(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "sha256";
  if (c === "LTC") return "scrypt";
  if (c === "KAS" || c === "KASPA") return "kHeavyHash";
  return "";
}
/** Extrai MiningAccount e Worker de "MiningAccount.Worker" (descarta se faltar o ponto). */
function splitAccountWorker(row) {
  const wn = clean(row.worker_name);
  const i = wn.indexOf(".");
  if (i <= 0) return { account: "", worker: "" };
  return { account: wn.slice(0, i), worker: wn.slice(i + 1) };
}
/** chave de comparação para worker: lowercase + sem zeros à esquerda (001 ≡ 1; preserva "0") */
const workerKey = (w) => {
  const s = clean(w).toLowerCase();
  const k = s.replace(/^0+/, "");
  return k === "" ? "0" : k;
};

/* ===== Binance signed fetch ===== */
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
    // geoblock / auth / overload: tenta mais um pouco e devolve
    if ([451, 403, 401, 429].includes(resp.status) || resp.status >= 500) {
      if (attempt > retries) return resp;
      const ra = Number(resp.headers.get("retry-after")) || (350 * attempt);
      await new Promise(r => setTimeout(r, ra + Math.random() * 300));
      continue;
    }
    return resp;
  }
}

/** IP de saída do host (para debug de geoblock) */
async function egressIP() {
  try {
    const r = await fetchWithRetry("https://api.ipify.org?format=text", { timeout: 6000 }, 0);
    if (!r.ok) return "?";
    return (await r.text()).trim();
  } catch { return "?"; }
}

/** Escolhe a primeira base que responda 200 (não 451) */
async function pickBinanceBase() {
  for (const base of CANDIDATE_BASES) {
    try {
      const resp = await fetchWithRetry(`${base}/api/v3/exchangeInfo`, { timeout: 7000 }, 1);
      if (resp.ok) return { base, status: resp.status };
      if (resp.status === 451) {
        console.warn("[uptime:binance] base geoblocked:", base);
        continue;
      }
    } catch {}
  }
  return { base: null, status: 0 };
}

/** Lista todos os workers (pagina) usando a base escolhida */
async function binanceListWorkers({ base, apiKey, secretKey, algo, userName }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const pageSize = 200;
  let page = 1;
  const all = [];

  while (true) {
    const params = { algo, userName, pageIndex: page, sort: 0, timestamp: Date.now(), recvWindow: 10_000 };
    const url = `${base}/sapi/v1/mining/worker/list?${signQuery(secretKey, params)}`;
    const resp = await fetchWithRetry(url, { headers }, 2);

    console.log("[binance:api:list]", { account: userName, algo, page, httpStatus: resp.status, ok: resp.ok, apiKey: mask(apiKey), base });

    if (resp.status === 451) return { ok: false, status: 451, reason: "geoblocked", workers: [] };
    if (resp.status === 403 || resp.status === 401) return { ok: false, status: resp.status, reason: "auth", workers: [] };
    if (!resp.ok) return { ok: false, status: resp.status, reason: "http", workers: [] };

    const data = await resp.json().catch(() => null);
    const arr = data?.data?.workerDatas || [];

    all.push(...arr);
    const pageSizeResp = Number(data?.data?.pageSize || 0);
    if (!arr.length || arr.length < (pageSizeResp || pageSize)) break;
    page += 1;
  }

  const workers = all.map(w => ({
    workerName: clean(w?.workerName),
    status: Number(w?.status ?? 0),        // 1 valid, 2 invalid, 3 no longer valid
    hashRate: Number(w?.hashRate ?? 0),
    lastShareTime: Number(w?.lastShareTime ?? 0),
  }));

  return { ok: true, status: 200, workers };
}

/** Detalhe de um worker (diagnóstico) */
async function binanceWorkerDetail({ base, apiKey, secretKey, algo, userName, workerName }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const params = { algo, userName, workerName, timestamp: Date.now(), recvWindow: 10_000 };
  const url = `${base}/sapi/v1/mining/worker/detail?` + signQuery(secretKey, params);
  const resp = await fetchWithRetry(url, { headers }, 2);
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const d = data?.data;
  if (!d) return null;
  return {
    workerName: clean(d.workerName ?? workerName),
    status: Number(d.status ?? 0),
    hashRate: Number(d.hashRate ?? 0),
    lastShareTime: Number(d.lastShareTime ?? 0),
  };
}

/** Online se hashRate > 0 OU status==1 */
function isOnlineBinance(w) {
  if (Number.isFinite(w.hashRate) && w.hashRate > 0) return true;
  return Number(w.status) === 1;
}

/* ===== slot dedupe (in-process) ===== */
let lastSlot = null;
const updatedInSlot = new Set();
function beginSlot(s) { if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); } }
function dedupeForHours(ids) {
  const out = [];
  for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); }
  return out;
}

/* ===== Job principal ===== */
export async function runUptimeBinanceOnce() {
  const sISO = slotISO();
  beginSlot(sISO);

  // Lock distribuído (20 min para cobrir desvios)
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
    // Escolhe base alcançável
    const picked = await pickBinanceBase();
    if (!picked.base) {
      const ip = await egressIP();
      console.warn("[uptime:binance] Todas as bases geoblocked ou indisponíveis (provável 451).", { egressIP: ip });
      return { ok: true, skipped: true, reason: "geoblocked_all" };
    }
    const BASE = picked.base;
    console.log("[uptime:binance] BASE escolhida:", BASE);

    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, api_key, secret_key, coin, status
      FROM miners
      WHERE pool = 'Binance'
        AND api_key IS NOT NULL AND secret_key IS NOT NULL
        AND worker_name IS NOT NULL
    `;
    if (!minersRaw.length) return { ok: true, updated: 0, statusChanged: 0 };

    // Normaliza e valida (exige account.worker e algo válido)
    const miners = minersRaw
      .map(r => {
        const { account, worker } = splitAccountWorker(r);
        const algo = mapAlgo(r.coin);
        return { ...r, account: clean(account), worker: clean(worker), algo };
      })
      .filter(m => m.account && m.worker && m.algo);

    const discarded = minersRaw.filter(r => {
      const { account, worker } = splitAccountWorker(r);
      return !(account && worker && mapAlgo(r.coin));
    });
    if (discarded.length) {
      console.warn("[uptime:binance] DESCARTADOS:", discarded.map(x => ({
        id: x.id, worker_name: x.worker_name, coin: x.coin
      })));
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

      // mapa key(worker) -> [ids]
      const want = new Map();
      for (const m of list) {
        const wk = workerKey(m.worker);
        if (!wk) continue;
        if (!want.has(wk)) want.set(wk, []);
        want.get(wk).push(m.id);
      }

      console.log("[uptime:binance] GROUP START", {
        account: userName, algo, miners: list.length,
        apiKey: mask(apiKey), secretKey: mask(secretKey),
        wantWorkers: Array.from(want.keys()),
        base: BASE,
      });

      const { ok, status, reason, workers } = await binanceListWorkers({ base: BASE, apiKey, secretKey, algo, userName });
      apiCalls += 1;

      if (!ok) {
        // geoblock / auth / http -> não marcar offline
        const ip = await egressIP();
        console.warn("[uptime:binance] GROUP SKIPPED", { account: userName, algo, reason, httpStatus: status, egressIP: ip, base: BASE });
        return;
      }

      // classificar
      let onlineIdsRaw = [];
      let offlineIdsRaw = [];
      let offlineExplicit = 0;
      let offlineMissing  = 0;

      // 1) workers devolvidos
      for (const w of workers) {
        const k = workerKey(w.workerName);
        if (!want.has(k)) continue;
        const ids = want.get(k);
        if (isOnlineBinance(w)) onlineIdsRaw.push(...ids);
        else { offlineIdsRaw.push(...ids); offlineExplicit += ids.length; }
      }

      // 2) os que pedimos e NÃO vieram → tenta detail; só depois marca offline
      const seen = new Set([...onlineIdsRaw, ...offlineIdsRaw]);
      for (const [wk, ids] of want.entries()) {
        const touched = ids.some(id => seen.has(id));
        if (touched) continue;

        // tenta detail para confirmar
        const detail = await binanceWorkerDetail({ base: BASE, apiKey, secretKey, algo, userName, workerName: wk }).catch(() => null);
        if (detail && isOnlineBinance(detail)) {
          onlineIdsRaw.push(...ids); // estava ativo mas não veio na list (latência/paginado)
        } else {
          offlineIdsRaw.push(...ids);
          offlineMissing += ids.length;
        }
      }

      // 3) aplica na BD (dedupe horas por slot)
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

      console.log("[uptime:binance] GROUP RESULT", {
        account: userName,
        algo,
        miners: list.length,
        onlineAPI: onlineIdsRaw.length,
        offlineAPI: offlineIdsRaw.length,
        offlineExplicit,
        offlineMissing,
        inc: incCount,
        statusOn: onCount,
        statusOff: offCount,
      });
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
