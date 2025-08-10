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

async function fetchLitecoinPoolWorkers(apiKey) {
  const url = `https://www.litecoinpool.org/api?api_key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  return data && data.workers ? data.workers : {};
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

export async function runUptimeLTCPoolOnce() {
  const sISO = slotISO();
  beginSlot(sISO);

  // lock específico da LiteCoinPool
  const lockKey = `uptime:${sISO}:ltcpool`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 14 * 60 });
  if (!gotLock) {
    console.log(`[uptime:ltcpool] lock ativo (${sISO}) – ignorado nesta instância.`);
    return { ok: true, skipped: true };
  }

  let updated = 0;

  try {
    // agrupa por api_key
    const miners = await sql/*sql*/`
      SELECT id, worker_name, api_key
      FROM miners
      WHERE pool = 'LiteCoinPool' AND api_key IS NOT NULL AND worker_name IS NOT NULL
    `;
    if (!miners.length) return { ok: true, updated: 0 };

    const groups = new Map(); // api_key -> Miner[]
    for (const m of miners) {
      const k = m.api_key;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }

    for (const [apiKey, list] of groups) {
      let ids = [];
      try {
        const workers = await fetchLitecoinPoolWorkers(apiKey);
        for (const m of list) {
          const info = workers?.[m.worker_name]; // match exato
          if (info && info.connected === true) ids.push(m.id);
        }
      } catch (e) {
        console.error("[uptime:ltcpool] erro grupo", apiKey, e);
      }
      ids = dedupe(ids);
      if (ids.length) {
        await sql/*sql*/`UPDATE miners SET total_horas_online = COALESCE(total_horas_online,0) + 0.25 WHERE id = ANY(${ids})`;
        updated += ids.length;
      }
      console.log(`[uptime:ltcpool] grupo apiKey=*** – workers: ${list.length}, online únicos: ${ids.length}`);
    }

    console.log(`[uptime:ltcpool] ${sISO} – miners atualizadas: ${updated}`);
    return { ok: true, updated };
  } catch (e) {
    console.error("⛔ uptime:ltcpool", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeLTCPool() {
  cron.schedule("*/15 * * * *", async () => {
    try { await runUptimeLTCPoolOnce(); } catch (e) { console.error("⛔ ltcpool cron:", e); }
  }, { timezone: "Europe/Lisbon" });
  console.log("[jobs] LiteCoinPool (*/15) agendado.");
}
