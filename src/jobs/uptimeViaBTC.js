import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

// helpers de matching
const norm = (s) => String(s ?? "").trim();
const low = (s) => norm(s).toLowerCase();
const lastToken = (s) => {
  const p = norm(s).split(/[._-]/).filter(Boolean);
  return p.length ? p[p.length - 1] : norm(s);
};
function matchWorkerName(apiName, dbName) {
  const a = norm(apiName); const b = norm(dbName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (low(a) === low(b)) return true;
  if (a.endsWith(`.${b}`)) return true;
  if (low(a).endsWith(`.${low(b)}`)) return true;
  if (low(lastToken(a)) === low(b)) return true;
  return false;
}

async function fetchViaBTCList(apiKey, coinRaw) {
  const coin = String(coinRaw ?? "");
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) return [];
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name),
    worker_status: String(w.worker_status || ""),
    hashrate_10min: Number(w.hashrate_10min || 0),
  }));
}

let lastSlot = null;
const updatedInSlot = new Set();

function beginSlot(s) {
  if (s !== lastSlot) { lastSlot = s; updatedInSlot.clear(); }
}
function dedupe(ids) {
  const out = [];
  for (const id of ids) if (!updatedInSlot.has(id)) { updatedInSlot.add(id); out.push(id); }
  return out;
}

export async function runUptimeViaBTCOnce() {
  const sISO = slotISO();
  beginSlot(sISO);

  // lock específico da ViaBTC
  const lockKey = `uptime:${sISO}:viabtc`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) {
    console.log(`[uptime:viabtc] lock ativo (${sISO}) – ignorado nesta instância.`);
    return { ok: true, skipped: true };
  }

  let updated = 0;

  try {
    // agrupa por (api_key, coin)
    const miners = await sql/*sql*/`
      SELECT id, worker_name, api_key, coin
      FROM miners
      WHERE pool = 'ViaBTC' AND api_key IS NOT NULL AND worker_name IS NOT NULL
    `;
    if (!miners.length) return { ok: true, updated: 0 };

    const groups = new Map(); // `${api_key}|${coin}` -> Miner[]
    for (const m of miners) {
      const k = `${m.api_key}|${m.coin ?? ""}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }

    for (const [k, list] of groups) {
      const [apiKey, coin] = k.split("|");
      let ids = [];
      try {
        const workers = await fetchViaBTCList(apiKey, coin);
        for (const m of list) {
          const w = workers.find(x => matchWorkerName(x.worker_name, m.worker_name));
          if (w && (w.worker_status === "active" || w.hashrate_10min > 0)) ids.push(m.id);
        }
      } catch (e) {
        console.error("[uptime:viabtc] erro grupo", k, e);
      }
      ids = dedupe(ids);
      if (ids.length) {
        await sql/*sql*/`UPDATE miners SET total_horas_online = COALESCE(total_horas_online,0) + 0.25 WHERE id = ANY(${ids})`;
        updated += ids.length;
      }
      console.log(`[uptime:viabtc] grupo coin=${coin || "-"} – workers: ${list.length}, online únicos: ${ids.length}`);
    }

    console.log(`[uptime:viabtc] ${sISO} – miners atualizadas: ${updated}`);
    return { ok: true, updated };
  } catch (e) {
    console.error("⛔ uptime:viabtc", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeViaBTC() {
  cron.schedule("*/15 * * * *", async () => {
    try { await runUptimeViaBTCOnce(); } catch (e) { console.error("⛔ viabtc cron:", e); }
  }, { timezone: "Europe/Lisbon" });
  console.log("[jobs] ViaBTC (*/15) agendado.");
}
