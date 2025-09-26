// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";
import crypto from "crypto";

/* ========= cache ========= */
const statusCache = new Map(); // `${minerId}:${expectedTail}`
const CACHE_TTL_MS = 60 * 1000;

/* ========= helpers ========= */
const toLower = (s) => String(s ?? "").toLowerCase();
/** tail depois do último "." (mantém zeros, case-insensitive) */
function tail(name) {
  const s = String(name ?? "").trim().toLowerCase();
  if (!s) return "";
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : s;
}
/** chave de comparação: tail sem zeros à esquerda (001 -> 1), mas preserva "0" */
function tailKey(name) {
  const t = tail(name);
  const k = t.replace(/^0+/, "");
  return k === "" ? "0" : k;
}
/** normaliza estado textual sem falsos positivos */
function normalizeStatus(v) {
  const s = String(v ?? "").trim().toLowerCase();
  const NEG = new Set(["unactive","inactive","offline","down","dead","parado","desligado","inativa"]);
  if (NEG.has(s)) return "offline";
  const POS = new Set(["active","online","alive","running","up","ok","ativo","ligado","ativa"]);
  if (POS.has(s)) return "online";
  return "offline";
}
function clean(s) {
  return String(s ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}
function splitAccountWorker(name) {
  const wn = clean(name);
  const i = wn.indexOf(".");
  if (i <= 0) return { account: "", worker: "" };
  return { account: wn.slice(0, i), worker: wn.slice(i + 1) };
}
function mapAlgo(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "sha256";
  if (c === "LTC") return "scrypt";
  if (c === "KAS" || c === "KASPA") return "kHeavyHash";
  return "";
}
/** slug da F2Pool para currency */
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

/* ===== Mining-Dutch helpers ===== */
function mdSlug(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "bitcoin";
  if (c === "LTC") return "litecoin";
  if (c === "DOGE") return "dogecoin";
  return "";
}
function mdAlgo(coin) {
  const c = String(coin ?? "").trim().toUpperCase();
  if (c === "BTC") return "sha256";
  if (c === "LTC" || c === "DOGE") return "scrypt";
  return "";
}
function buildMDUrls({ coin, account_id, api_key }) {
  const base = "https://www.mining-dutch.nl";
  const algo = mdAlgo(coin);
  const slug = mdSlug(coin);
  const mk = (name) =>
    `${base}/pools/${name}.php?page=api&action=getuserworkers&id=${encodeURIComponent(account_id)}&api_key=${encodeURIComponent(api_key)}`;

  const urls = [];
  if (algo) urls.push(mk(algo));     // sha256.php / scrypt.php
  if (slug) urls.push(mk(slug));     // bitcoin.php / litecoin.php / dogecoin.php
  // fallback cruzado (algoritmo inverso)
  if (algo === "sha256") urls.push(mk("scrypt"));
  if (algo === "scrypt") urls.push(mk("sha256"));
  // último recurso
  if (!algo && !slug) { urls.push(mk("sha256")); urls.push(mk("scrypt")); }
  return urls;
}
/** parser robusto para getuserworkers da Mining-Dutch */
function parseMDWorkersPayload(data) {
  if (!data || typeof data !== "object") return [];
  // formato típico no topo: { getuserworkers: { data: { miners: [...] } } }
  const top = data.getuserworkers;
  if (top && top.data) {
    const miners = top.data.miners ?? top.data.workers ?? [];
    if (Array.isArray(miners)) {
      return miners.map((v, i) => ({
        username: clean(v?.username ?? v?.worker ?? v?.name ?? String(i)),
        alive: Number(v?.alive ?? 0),
        hashrate: Number(v?.hashrate ?? v?.hash ?? 0),
        status: clean(v?.status ?? ""),
        minerGroup: clean(v?.minerGroup ?? ""),
      }));
    }
    if (miners && typeof miners === "object") {
      return Object.entries(miners).map(([k, v]) => ({
        username: clean(v?.username ?? v?.worker ?? v?.name ?? k),
        alive: Number(v?.alive ?? 0),
        hashrate: Number(v?.hashrate ?? v?.hash ?? 0),
        status: clean(v?.status ?? ""),
        minerGroup: clean(v?.minerGroup ?? ""),
      }));
    }
  }
  // fallback muito genérico (não esperado mas seguro)
  const node = data?.data?.workers ?? data?.workers ?? data?.data ?? null;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    return Object.entries(node).map(([k, v]) => ({
      username: clean(v?.username ?? v?.worker ?? v?.name ?? k),
      alive: Number(v?.alive ?? 0),
      hashrate: Number(v?.hashrate ?? v?.hash ?? 0),
      status: clean(v?.status ?? ""),
      minerGroup: clean(v?.minerGroup ?? ""),
    }));
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => ({
      username: clean(v?.username ?? v?.worker ?? v?.name ?? String(i)),
      alive: Number(v?.alive ?? 0),
      hashrate: Number(v?.hashrate ?? v?.hash ?? 0),
      status: clean(v?.status ?? ""),
      minerGroup: clean(v?.minerGroup ?? ""),
    }));
  }
  return [];
}

/* ========= HTTP util ========= */
async function fetchJSON(url, opts = {}, retries = 1) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), opts.timeout ?? 10_000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(to);
      let text = "";
      try { text = await res.text(); } catch {}
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { res, json, raw: text };
    } catch (e) {
      if (attempt > retries) throw e;
      await new Promise(r => setTimeout(r, 300 * attempt + Math.random() * 300));
    }
  }
}

/* ========= Binance ========= */
const BINANCE_BASES = [
  process.env.BINANCE_BASE || "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];
function signQuery(secret, params) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}
async function pickBinanceBase() {
  for (const base of BINANCE_BASES) {
    const ping = await fetchJSON(`${base}/api/v3/exchangeInfo`, { timeout: 7000 }, 1);
    if (ping.res?.ok) return base;
    if (ping.res && ping.res.status === 451) continue;
  }
  return null;
}
async function getServerTime(base) {
  const r = await fetchJSON(`${base}/api/v3/time`, { timeout: 7000 }, 1);
  if (!r.res?.ok) return null;
  const t = Number(r?.json?.serverTime);
  return Number.isFinite(t) ? t : null;
}
async function signedGET({ base, path, apiKey, secretKey, params, skewMs = 0 }) {
  const headers = { "X-MBX-APIKEY": apiKey };
  const p = { ...params, timestamp: Date.now() + skewMs, recvWindow: 30_000 };
  const url = `${base}${path}?` + signQuery(secretKey, p);
  return fetchJSON(url, { headers }, 1);
}

/* ========= Controller ========= */
export async function getMinerStatus(req, res) {
  try {
    const minerId = String(req.params.id ?? req.params.minerId ?? "").trim();
    if (!minerId) return res.status(400).json({ error: "ID da miner inválido." });

    const rows = await sql/*sql*/`
      SELECT id, api_key, secret_key, coin, pool, worker_name
      FROM miners
      WHERE id::text = ${minerId}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrado." });

    const { api_key, secret_key, coin, pool } = rows[0];
    const worker_name_db = rows[0].worker_name ?? "";
    const expectedTail = tail(worker_name_db);
    const expectedKey  = tailKey(worker_name_db);
    if (!expectedTail) return res.status(400).json({ error: "Miner sem worker_name válido." });

    const cacheKey = `${minerId}:${expectedTail}`;
    const wantRefresh =
      String(req.query.refresh ?? "") === "1" ||
      String(req.headers["x-refresh"] ?? "") === "1";

    const cached = !wantRefresh && statusCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({ id: minerId, ...cached.data, cache: "hit" });
    }

    let workers = [];
    let source = null;

    if (pool === "ViaBTC") {
      source = "ViaBTC";
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${encodeURIComponent(coin)}`;
      const { res: r, json: data } = await fetchJSON(url, { headers: { "X-API-KEY": api_key } }, 1);
      if (!r.ok || !data || data.code !== 0) {
        return res.status(502).json({ error: "Erro na API da ViaBTC", detalhe: data?.message || `HTTP ${r.status}` });
      }
      const list = Array.isArray(data?.data?.data) ? data.data.data : [];
      workers = list.map((w) => ({
        worker_name: String(w.worker_name ?? "").trim(),
        worker_status: w.worker_status,
        hashrate_10min: Number(w.hashrate_10min ?? 0),
      }));

    } else if (pool === "LiteCoinPool") {
      source = "LiteCoinPool";
      const url = `https://www.litecoinpool.org/api?api_key=${encodeURIComponent(api_key)}`;
      const { res: r, json: data } = await fetchJSON(url, {}, 1);
      if (!r.ok || !data || !data.workers) {
        return res.status(502).json({ error: "Erro na API da LitecoinPool", detalhe: data?.error || `HTTP ${r.status}` });
      }
      workers = Object.entries(data.workers).map(([name, info]) => ({
        worker_name: String(name ?? "").trim(),
        worker_status: info.connected ? "active" : "unactive",
        hashrate_10min: Number((info.hash_rate ?? 0) * 1000), // kH/s -> H/s
      }));

    } else if (pool === "Binance") {
      source = "Binance";
      if (!secret_key) return res.status(400).json({ error: "Miner Binance sem secret_key." });
      const { account } = splitAccountWorker(worker_name_db);
      if (!account) return res.status(400).json({ error: "Binance requer worker_name no formato 'Conta.Worker'." });
      const algo = mapAlgo(coin);
      if (!algo) return res.status(400).json({ error: `Coin não suportada na Binance: ${coin}` });

      const base = await pickBinanceBase();
      if (!base) return res.status(503).json({ error: "Binance geoblocked/indisponível (451/erro de rede)." });

      // lista
      let L = await signedGET({
        base, path: "/sapi/v1/mining/worker/list",
        apiKey: api_key, secretKey: secret_key,
        params: { algo, userName: account, pageIndex: 1, pageSize: 200, sort: 0 },
      });
      if (!L.res.ok && L.json?.code === -1021) {
        const serverTime = await getServerTime(base);
        if (serverTime) {
          const skewMs = serverTime - Date.now();
          L = await signedGET({
            base, path: "/sapi/v1/mining/worker/list",
            apiKey: api_key, secretKey: secret_key,
            params: { algo, userName: account, pageIndex: 1, pageSize: 200, sort: 0 }, skewMs
          });
        }
      }
      if (L.res.status === 451) return res.status(503).json({ error: "Binance geoblocked (451)." });
      if (!L.res.ok) {
        return res.status(502).json({ error: "Erro na API da Binance (worker/list)", detalhe: L.json?.msg || `HTTP ${L.res.status}`, code: L.json?.code });
      }

      const listArr = Array.isArray(L.json?.data?.workerDatas) ? L.json.data.workerDatas : [];
      workers = listArr.map((w) => ({
        worker_name: String(w?.workerName ?? "").trim(), // ex.: "001" ou "1"
        worker_status: Number(w?.status ?? 0) === 1 ? "active" : "unactive",
        hashrate_10min: Number(w?.hashRate ?? 0),
      }));

      // fallback: se o nosso tail não veio, tenta detail com o tail original
      const seen = workers.some(w => tail(w.worker_name) === expectedTail || tailKey(w.worker_name) === expectedKey);
      if (!seen) {
        let D = await signedGET({
          base, path: "/sapi/v1/mining/worker/detail",
          apiKey: api_key, secretKey: secret_key,
          params: { algo, userName: account, workerName: expectedTail },
        });
        if (!D.res.ok && D.json?.code === -1021) {
          const serverTime = await getServerTime(base);
          if (serverTime) {
            const skewMs = serverTime - Date.now();
            D = await signedGET({
              base, path: "/sapi/v1/mining/worker/detail",
              apiKey: api_key, secretKey: secret_key,
              params: { algo, userName: account, workerName: expectedTail }, skewMs
            });
          }
        }
        if (D.res.ok && D.json?.data) {
          const d = D.json.data;
          workers.push({
            worker_name: String(d?.workerName ?? expectedTail),
            worker_status: Number(d?.status ?? 0) === 1 ? "active" : "unactive",
            hashrate_10min: Number(d?.hashRate ?? 0),
          });
        }
      }

    } else if (pool === "F2Pool") {
      // **** v2 com token em api_key; BTC => "bitcoin"
      source = "F2Pool";
      const { account } = splitAccountWorker(worker_name_db);
      if (!account) return res.status(400).json({ error: "F2Pool requer worker_name no formato 'Conta.Worker'." });
      const currency = f2slug(coin || "BTC"); // BTC -> "bitcoin", etc.

      const url = "https://api.f2pool.com/v2/hash_rate/worker/list";
      const headers = {
        "Content-Type": "application/json",
        "F2P-API-SECRET": api_key, // token guardado em miners.api_key
      };
      const body = JSON.stringify({ currency, mining_user_name: account, page: 1, size: 200 });

      const { res: r, json: data } = await fetchJSON(url, { method: "POST", headers, body, timeout: 15000 }, 1);
      if (!r.ok) {
        return res.status(502).json({ error: "Erro HTTP na API da F2Pool (v2)", detalhe: `HTTP ${r.status}` });
      }
      if (data && typeof data.code === "number" && data.code !== 0) {
        return res.status(502).json({ error: "Erro lógico na API da F2Pool (v2)", code: data.code, msg: data.msg });
      }

      // Shape: { workers: [ { hash_rate_info:{ name, hash_rate }, last_share_at, ... } ] }
      const arr = Array.isArray(data?.workers) ? data.workers
                : Array.isArray(data?.data?.workers) ? data.data.workers
                : Array.isArray(data?.data?.list) ? data.data.list
                : Array.isArray(data?.list) ? data.list
                : [];

      workers = arr.map((item) => {
        const hri = item?.hash_rate_info || item?.hashrate_info || item?.hashRateInfo || {};
        const name = clean(hri?.name ?? item?.name ?? item?.worker ?? "");
        const hr = Number(hri?.hash_rate ?? item?.hash_rate ?? item?.hashrate ?? 0);
        const last = Number(item?.last_share_at ?? item?.last_share ?? item?.last_share_time ?? 0);
        const lastMs = Number.isFinite(last) ? (last > 1e11 ? last : last * 1000) : 0;
        const fresh = lastMs > 0 && (Date.now() - lastMs < 90 * 60 * 1000); // 90 minutos
        const online = hr > 0 || fresh;
        return {
          worker_name: name,                         // "001"
          worker_status: online ? "active" : "unactive",
          hashrate_10min: hr,                        // usa hash_rate como proxy
        };
      });

    } else if (pool === "MiningDutch") {
      source = "MiningDutch";
      const { account } = splitAccountWorker(worker_name_db);
      if (!account) return res.status(400).json({ error: "MiningDutch requer worker_name no formato 'AccountId.Worker'." });

      const urls = buildMDUrls({ coin, account_id: account, api_key });
      let parsed = null;
      let lastErr = null;

      for (const url of urls) {
        const { res: r, json, raw } = await fetchJSON(url, { timeout: 12000 }, 1);
        if (!r.ok) {
          lastErr = `HTTP ${r.status}`;
          continue;
        }
        const list = parseMDWorkersPayload(json);
        if (Array.isArray(list) && list.length >= 0) {
          parsed = list;
          break;
        } else {
          lastErr = `schema inesperado`;
          // continua a tentar próximo URL
        }
      }

      if (!parsed) {
        return res.status(502).json({ error: "Erro na API da MiningDutch", detalhe: lastErr || "sem dados" });
      }

      workers = parsed.map((w, i) => ({
        worker_name: String(w?.username ?? `w${i}`),
        worker_status: (Number(w?.alive ?? 0) > 0 || Number(w?.hashrate ?? 0) > 0) ? "active" : "unactive",
        hashrate_10min: Number(w?.hashrate ?? 0),
      }));

    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

    // --- MATCH TOLERANTE: exact tail OU tailKey (sem zeros à esquerda) ---
    const my =
      workers.find(w => tail(w.worker_name) === expectedTail) ||
      workers.find(w => tailKey(w.worker_name) === expectedKey) ||
      null;

    // estado do alvo
    let resolved = "offline";
    let my_status_raw = null;
    let my_hashrate_10min = null;
    if (my) {
      my_status_raw = my.worker_status ?? null;
      my_hashrate_10min = typeof my.hashrate_10min === "number" ? my.hashrate_10min : null;
      if (typeof my.hashrate_10min === "number" && my.hashrate_10min > 0) resolved = "online";
      else if (typeof my.worker_status !== "undefined") resolved = normalizeStatus(my.worker_status);
    }

    const responseData = {
      status: resolved,
      source,
      total: workers.length,
      active: workers.filter((w) => normalizeStatus(w.worker_status) === "online").length,
      unactive: workers.filter((w) => normalizeStatus(w.worker_status) === "offline").length,
      workers,
      selected_worker: my || null, // ✅ o worker certo para o frontend

      // debug útil
      worker_found: !!my,
      worker_name_expected_raw: rows[0].worker_name ?? "",
      worker_tail_expected: expectedTail,
      worker_tail_key_expected: expectedKey,
      workers_tails: workers.slice(0, 50).map((w) => tail(w.worker_name)),
      workers_tailKeys: workers.slice(0, 50).map((w) => tailKey(w.worker_name)),
      my_status_raw,
      my_hashrate_10min,
    };

    statusCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
    return res.json({ id: minerId, ...responseData, cache: wantRefresh ? "bypass" : "miss" });
  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
