// controllers/statusController.js
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const statusCache = new Map(); // key: minerId -> { data, timestamp }
const CACHE_TTL_MS = 60 * 1000;

/* ===================== Helpers ===================== */

/** Normaliza estado em "online" | "offline" */
function normalizeStatus(v) {
  if (typeof v === "boolean") return v ? "online" : "offline";
  const s = String(v ?? "").toLowerCase();
  if (["true","1","yes","online","alive","active","up","ok","running","ativo","ativa","ligado"].some(x => s.includes(x))) return "online";
  if (["false","0","no","offline","dead","down","inactive","parado","desligado","inativa","unactive"].some(x => s.includes(x))) return "offline";
  return "offline";
}

/** Devolve sempre o sufixo do worker (tudo a seguir ao último ".") */
function workerTail(name) {
  const s = String(name ?? "").trim().toLowerCase();
  if (!s) return "";
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Compara dois nomes de worker olhando só ao sufixo (depois do ".") */
function sameWorker(a, b) {
  return workerTail(a) === workerTail(b);
}

/* ===================== Controller ===================== */

export async function getMinerStatus(req, res) {
  try {
    // suporta /miners/:id/status e /miners/:minerId/status
    const minerId = String(req.params.id ?? req.params.minerId ?? "").trim();
    if (!minerId) return res.status(400).json({ error: "ID da miner inválido." });

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
    if (!worker_name) {
      return res.status(400).json({ error: "Miner sem worker_name definido." });
    }

    const expectedTail = workerTail(worker_name);

    let workers = [];
    let source = null;

    if (pool === "ViaBTC") {
      source = "ViaBTC";
      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${encodeURIComponent(
        coin || ""
      )}`;

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
        worker_name: w.worker_name,                // ViaBTC normalmente devolve só o sufixo (ex.: "001")
        worker_status: w.worker_status,            // "active" | "unactive" | ...
        hashrate_10min: Number(w.hashrate_10min ?? 0),
      }));
    } else if (pool === "LiteCoinPool") {
      source = "LiteCoinPool";
      // A API devolve um objeto com .workers: { "username.worker": { connected, hash_rate, ... } }
      const url = `https://www.litecoinpool.org/api?api_key=${encodeURIComponent(api_key)}`;
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));

      if (!data || !data.workers) {
        return res.status(502).json({
          error: "Erro na API da LitecoinPool",
          detalhe: data?.error || "Erro desconhecido",
        });
      }

      workers = Object.entries(data.workers).map(([name, info]) => {
        const connected = !!info.connected;
        // hash_rate costuma vir em kH/s; convertemos para H/s para manter comparável
        const hashH = Number((info.hash_rate ?? 0) * 1000);
        return {
          worker_name: name,                        // aqui costuma vir "username.worker" (ex.: "domingoss98.1")
          worker_status: connected ? "active" : "unactive",
          hashrate_10min: hashH,
        };
      });
    } else {
      return res.status(400).json({ error: "Pool não suportada." });
    }

    // Encontrar o worker desta miner (comparando SEMPRE pelo sufixo após o ".")
    const my = workers.find((w) => sameWorker(w.worker_name, expectedTail)) || null;

    // Regras de online:
    // - Se hashrate_10min > 0 → online
    // - Caso contrário, tentamos inferir pelo worker_status
    let resolved = "offline";
    if (my) {
      if (typeof my.hashrate_10min === "number" && my.hashrate_10min > 0) {
        resolved = "online";
      } else if (typeof my.worker_status !== "undefined") {
        resolved = normalizeStatus(my.worker_status);
      }
    }

    // Estatísticas rápidas (opcionais)
    const onlineCount = workers.filter((w) => {
      if (Number(w.hashrate_10min ?? 0) > 0) return true;
      return normalizeStatus(w.worker_status) === "online";
    }).length;

    const responseData = {
      status: resolved,                 // ✅ campo principal que o frontend espera
      source,                           // para debug
      total: workers.length,
      online: onlineCount,
      offline: Math.max(0, workers.length - onlineCount),
      workers,

      // Debug de matching:
      worker_found: !!my,
      worker_name_expected_raw: worker_name,  // o que está no DB
      worker_name_expected: expectedTail,     // o sufixo usado no matching
    };

    statusCache.set(minerId, { data: responseData, timestamp: Date.now() });
    return res.json({ id: minerId, ...responseData });
  } catch (err) {
    console.error("❌ Erro no controller getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao chamar a API." });
  }
}
