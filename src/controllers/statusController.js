// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";

// cache inclui o tail para não contaminar quando mudas o worker_name
const statusCache = new Map(); // key: `${minerId}:${expectedTail}` -> { data, timestamp }
const CACHE_TTL_MS = 60 * 1000;

/* ========= helpers ========= */
function toLower(s) {
  return String(s ?? "").toLowerCase();
}
function normalizeStatus(v) {
  if (typeof v === "boolean") return v ? "online" : "offline";
  const s = toLower(v);
  if (["true","1","yes","online","alive","active","up","ok","running","ativo","ativa","ligado"].some(x => s.includes(x))) return "online";
  if (["false","0","no","offline","dead","down","inactive","parado","desligado","inativa","unactive"].some(x => s.includes(x))) return "offline";
  return "offline";
}

/** devolve o sufixo depois do último "." (ou o próprio nome, se não houver ".") — mantém zeros à esquerda */
function tail(name) {
  const s = toLower(String(name ?? "").trim());
  if (!s) return "";
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** compara só pelos sufixos (sem mexer em zeros à esquerda) */
function matchWorkerName(candidate, wanted) {
  return tail(candidate) === tail(wanted);
}

/* ========= controller ========= */
export async function getMinerStatus(req, res) {
  try {
    // suporta /miners/:id/status e /miners/:minerId/status
    const minerId = String(req.params.id ?? req.params.minerId ?? "").trim();
    if (!minerId) return res.status(400).json({ error: "ID da miner inválido." });

    // BD: buscar credenciais mínimas + worker alvo
    const rows = await sql`
      SELECT id, api_key, coin, pool, worker_name
      FROM miners
      WHERE id::text = ${minerId}
      LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: "Miner não encontrado." });

    const { api_key, coin, pool } = rows[0];
    const worker_name_db = rows[0].worker_name ?? "";
    const expectedTail = tail(worker_name_db); // <= normaliza ANTES de qualquer pedido

    if (!expectedTail) {
      return res.status(400).json({ error: "Miner sem worker_name válido." });
    }

    const cacheKey = `${minerId}:${expectedTail}`;
    const wantRefresh =
      String(req.query.refresh ?? "") === "1" ||
      String(req.headers["x-refresh"] ?? "") === "1";

    // cache
    const cached = !wantRefresh && statusCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({ id: minerId, ...cached.data, cache: "hit" });
    }

    let workers = [];
    let source = null;

    if (pool === "ViaBTC") {
      source = "ViaBTC";
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${encodeURIComponent(coin)}`;
      const response = await fetch(url, { headers: { "X-API-KEY": api_key } });
      const data = await response.json().catch(() => ({}));

      if (!data || data.code !== 0) {
        return res.status(502).json({
          error: "Erro na API da ViaBTC",
          detalhe: data?.message || "Erro desconhecido",
        });
      }

      // { data: { data: [ { worker_name, worker_status, hashrate_10min } ] } }
      const list = Array.isArray(data?.data?.data) ? data.data.data : [];
      workers = list.map((w) => ({
        worker_name: String(w.worker_name ?? "").trim(), // ViaBTC costuma devolver "001"
        worker_status: w.worker_status,                  // "active" | "unactive" | ...
        hashrate_10min: Number(w.hashrate_10min ?? 0),
      }));
    } else if (pool === "LiteCoinPool") {
      source = "LiteCoinPool";
      const url = `https://www.litecoinpool.org/api?api_key=${encodeURIComponent(api_key)}`;
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));

      if (!data || !data.workers) {
        return res.status(502).json({
          error: "Erro na API da LitecoinPool",
          detalhe: data?.error || "Erro desconhecido",
        });
      }
      // data.workers = { "username.worker": { connected, hash_rate, ... } }
      workers = Object.entries(data.workers).map(([name, info]) => ({
        worker_name: String(name ?? "").trim(),          // ex.: "domingoss98.1"
        worker_status: info.connected ? "active" : "unactive",
        hashrate_10min: Number((info.hash_rate ?? 0) * 1000), // kH/s -> H/s
      }));
    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

    // Encontrar o worker da miner alvo — compara SEMPRE pelo tail
    const my = workers.find((w) => tail(w.worker_name) === expectedTail) || null;

    // Regras de online:
    let resolved = "offline";
    if (my) {
      if (typeof my.hashrate_10min === "number" && my.hashrate_10min > 0) {
        resolved = "online";
      } else if (typeof my.worker_status !== "undefined") {
        resolved = normalizeStatus(my.worker_status);
      }
    }

    const responseData = {
      status: resolved,                 // ✅ o que o frontend usa
      source,
      total: workers.length,
      active: workers.filter((w) => normalizeStatus(w.worker_status) === "online").length,
      unactive: workers.filter((w) => normalizeStatus(w.worker_status) === "offline").length,
      workers,

      // debug útil
      worker_found: !!my,
      worker_name_expected_raw: worker_name_db,
      worker_tail_expected: expectedTail,
      workers_tails: workers.slice(0, 50).map((w) => tail(w.worker_name)),
    };

    statusCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
    return res.json({ id: minerId, ...responseData, cache: wantRefresh ? "bypass" : "miss" });
  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
