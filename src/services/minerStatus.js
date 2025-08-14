// services/minerStatus.js
import crypto from "crypto";
import fetch from "node-fetch";

/** Helpers */
export function normalizeStatus(value) {
  if (typeof value === "boolean") return value ? "online" : "offline";
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return "offline";
  const on = ["online", "alive", "active", "up", "ok", "running", "ativo", "ativa", "ligado"];
  const off = ["offline", "dead", "down", "inactive", "parado", "desligado", "inativa"];
  if (on.some((w) => s.includes(w))) return "online";
  if (off.some((w) => s.includes(w))) return "offline";
  if (s === "true" || s === "1" || s === "yes") return "online";
  if (s === "false" || s === "0" || s === "no") return "offline";
  return "offline";
}

function md5Upper(str) {
  return crypto.createHash("md5").update(str).digest("hex").toUpperCase();
}

function buildViaBTCAuth({ access_id, secret_key, coin, worker }) {
  const tonce = Date.now();
  const params = { access_id, coin, ...(worker ? { worker } : {}), tonce };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const sign = md5Upper(`${query}&secret_key=${secret_key}`);
  return { query, sign };
}

/** VIA BTC — tenta 1) X-API-KEY (read-only), 2) fallback assinado se tiver secret */
async function viabtcWorkerStatus({ api_key, secret_key, coin, worker_name }) {
  // 1) Tentativa read-only (sem secret): lista todos e filtra
  try {
    const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${encodeURIComponent(
      coin
    )}`;
    const resp = await fetch(url, { headers: { "X-API-KEY": api_key } });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      // Formato típico que estavas a usar: { code:0, data:{ data:[{ worker_name, worker_status, hashrate_10min }] } }
      if (data && (data.code === 0 || typeof data.code === "undefined")) {
        const list =
          (data?.data?.data && Array.isArray(data.data.data) && data.data.data) ||
          (data?.data?.workers && Array.isArray(data.data.workers) && data.data.workers) ||
          (Array.isArray(data?.data) && data.data) ||
          [];

        const my =
          list.find(
            (w) =>
              String(w.worker_name || w.worker || "").toLowerCase() ===
              String(worker_name).toLowerCase()
          ) || null;

        if (my) {
          const raw =
            my.worker_status ??
            my.status ??
            my.alive ??
            my.online ??
            my.hashrate ??
            my.hashrate_10min ??
            my.hash_rate;
          if (typeof raw === "number") return { status: raw > 0 ? "online" : "offline" };
          return { status: normalizeStatus(raw) };
        }
        return { status: "offline", details: "worker-not-found" };
      }
    }
  } catch {
    // ignora e tenta fallback se possível
  }

  // 2) Fallback assinado (se houver secret_key)
  if (secret_key) {
    try {
      const { query, sign } = buildViaBTCAuth({
        access_id: api_key,
        secret_key,
        coin,
        worker: worker_name,
      });

      const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?${query}`;
      const resp = await fetch(url, { headers: { Authorization: sign } });
      if (resp.ok) {
        const json = await resp.json().catch(() => null);
        if (json && (json.code === 0 || typeof json.code === "undefined")) {
          const payload = json?.data ?? json?.result ?? json;
          const raw =
            payload?.status ??
            payload?.state ??
            payload?.online ??
            payload?.alive ??
            payload?.is_active ??
            payload?.hashrate ??
            payload?.hash_rate ??
            payload?.hashrate_10min;
          if (typeof raw === "number") return { status: raw > 0 ? "online" : "offline" };
          return { status: normalizeStatus(raw) };
        }
      }
    } catch {
      // silencioso
    }
  }

  // 3) Falhou
  return { status: "offline", details: "viabtc-unreachable-or-unauthorized" };
}

/** LITECOINPOOL */
async function litecoinPoolWorkerStatus({ api_key, worker_name }) {
  if (!api_key) return { status: "offline", details: "missing-api-key" };
  const resp = await fetch(
    `https://www.litecoinpool.org/api?api_key=${encodeURIComponent(api_key)}`
  );
  if (!resp.ok) return { status: "offline", details: `http-${resp.status}` };

  const json = await resp.json().catch(() => null);
  const workers = json?.workers || json?.data?.workers || {};
  const keys = Object.keys(workers);

  let entry = workers[worker_name];
  if (!entry) {
    const hit = keys.find((k) => k === worker_name || k.endsWith(`.${worker_name}`));
    if (hit) entry = workers[hit];
  }
  if (!entry) return { status: "offline", details: "worker-not-found" };

  const raw =
    entry?.connected ?? entry?.alive ?? entry?.online ?? entry?.status ?? entry?.hash_rate;
  if (typeof raw === "number") return { status: raw > 0 ? "online" : "offline" };
  return { status: normalizeStatus(raw) };
}

/** API pública do serviço */
export async function getWorkerStatus(minerRow) {
  const pool = String(minerRow?.pool || "").toLowerCase();

  if (pool === "viabtc" || pool === "viabtcpool" || pool === "via") {
    return viabtcWorkerStatus({
      api_key: minerRow.api_key,
      secret_key: minerRow.secret_key, // opcional
      coin: minerRow.coin,
      worker_name: minerRow.worker_name,
    });
  }

  if (pool === "litecoinpool" || pool === "ltc" || pool === "ltcpool" || pool === "litecoin") {
    return litecoinPoolWorkerStatus({
      api_key: minerRow.api_key,
      worker_name: minerRow.worker_name,
    });
  }

  return { status: "offline", details: "unknown-pool" };
}

export async function isMinerOnline(minerRow) {
  const { status } = await getWorkerStatus(minerRow);
  return status === "online";
}
