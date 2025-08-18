// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const statusCache = new Map(); // key: minerId -> { data, timestamp }
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

/** devolve o sufixo depois do último "." (ou o próprio nome, se não houver ".") */
function tail(name) {
  const s = toLower(String(name ?? "").trim());
  if (!s) return "";
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** normaliza dígitos para ignorar zeros à esquerda: "001" -> "1" */
function normDigits(s) {
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

/** compara só pelos sufixos; também tenta igualar números ignorando zeros à esquerda */
function matchWorkerName(candidate, wanted) {
  const tc = tail(candidate);
  const tw = tail(wanted);
  if (tc === tw) return true;
  return normDigits(tc) === normDigits(tw);
}

/* ========= controller ========= */
export async function getMinerStatus(req, res) {
  try {
    // suporta /miners/:id/status e /miners/:minerId/status
    const minerId = String(req.params.id ?? req.params.minerId);

    // cache
    const cached = statusCache.get(minerId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({ id: minerId, ...cached.data });
    }

    // DB: buscar credenciais mínimas + worker alvo
    const rows = await sql`
      SELECT id, api_key, coin, pool, worker_name
      FROM miners
      WHERE id::text = ${minerId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Miner não encontrado." });
    }
    const { api_key, coin, pool, worker_name } = rows[0];

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

      // estrutura típica: { data: { data: [ { worker_name, worker_status, hashrate_10min } ] } }
      const list = Array.isArray(data?.data?.data) ? data.data.data : [];
      workers = list.map((w) => ({
        worker_name: w.worker_name,          // ViaBTC costuma devolver só o sufixo (ex.: "001")
        worker_status: w.worker_status,      // "active" | "unactive" | ...
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
      // data.workers = { "username.worker": { connected: bool, hash_rate: number, ... } }
      workers = Object.entries(data.workers).map(([name, info]) => ({
        worker_name: name,                    // aqui vem "username.worker" (ex.: "domingoss98.1")
        worker_status: info.connected ? "active" : "unactive",
        hashrate_10min: Number((info.hash_rate ?? 0) * 1000), // kH/s -> H/s
      }));
    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

    // Encontrar o worker da miner alvo (comparando só pelo sufixo)
    const my =
      workers.find((w) => matchWorkerName(w.worker_name, worker_name)) ||
      null;

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
      status: resolved,          // ✅ campo que o frontend espera
      source,                    // opcional (debug)
      total: workers.length,
      active: workers.filter((w) => normalizeStatus(w.worker_status) === "online").length,
      unactive: workers.filter((w) => normalizeStatus(w.worker_status) === "offline").length,
      workers,
      worker_found: !!my,        // para diagnóstico rápido
      worker_name_expected: worker_name,
      worker_tail_expected: tail(worker_name), // útil para ver o sufixo usado
    };

    statusCache.set(minerId, { data: responseData, timestamp: Date.now() });
    return res.json({ id: minerId, ...responseData });
  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
