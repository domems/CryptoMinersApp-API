// src/jobs/uptimeViaBTC.js
import cron from "node-cron";
import fetch from "node-fetch";
import { sql } from "../config/db.js";

function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

// helpers
const norm = (s) => String(s ?? "").trim();
const low  = (s) => norm(s).toLowerCase();
/** usa só o sufixo depois do último "." (mantém zeros à esquerda) */
const tail = (s) => {
  const str = norm(s);
  const i = str.lastIndexOf(".");
  return i >= 0 ? str.slice(i + 1) : str;
};
/** compara tails (case-insensitive, preserva zeros à esquerda) */
const sameTail = (a, b) => low(tail(a)) === low(tail(b));

async function fetchViaBTCList(apiKey, coinRaw) {
  const coin = String(coinRaw ?? "");
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const resp = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0 || !Array.isArray(data.data?.data)) return [];
  return data.data.data.map((w) => ({
    worker_name: String(w.worker_name ?? ""),
    worker_status: String(w.worker_status ?? ""),
    hashrate_10min: Number(w.hashrate_10min ?? 0),
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
  const t0 = Date.now();
  const sISO = slotISO();
  beginSlot(sISO);

  let updated = 0;
  let totalMiners = 0;
  let totalGroups = 0;
  let totalWorkersFetched = 0;
  let groupErrors = 0;

  try {
    // agrupar por (api_key, coin)
    const miners = await sql/*sql*/`
      SELECT id, worker_name, api_key, coin
      FROM miners
      WHERE pool = 'ViaBTC' AND api_key IS NOT NULL AND worker_name IS NOT NULL
    `;
    totalMiners = miners.length;
    if (!totalMiners) {
      console.log(`[uptime:viabtc] ${sISO} groups=0 miners=0 workers=0 online=0 errs=0 dur=${Date.now() - t0}ms`);
      return { ok: true, updated: 0 };
    }

    const groups = new Map(); // `${api_key}|${coin}` -> Miner[]
    for (const m of miners) {
      const k = `${m.api_key}|${m.coin ?? ""}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    totalGroups = groups.size;

    for (const [k, list] of groups) {
      const [apiKey, coin] = k.split("|");
      try {
        // 1) construir mapa de interesse: tail -> [ids]
        const tailToIds = new Map();
        for (const m of list) {
          const t = tail(m.worker_name);
          if (!t) continue;
          if (!tailToIds.has(t)) tailToIds.set(t, []);
          tailToIds.get(t).push(m.id);
        }
        const tailsWanted = new Set(tailToIds.keys());

        // 2) fetch único para o grupo
        const workers = await fetchViaBTCList(apiKey, coin);
        totalWorkersFetched += workers.length;

        // 3) filtrar apenas workers cujo tail interessa ao grupo
        const idsOnline = [];
        for (const w of workers) {
          const tw = tail(w.worker_name);
          if (!tailsWanted.has(tw)) continue; // ignora tudo o resto da conta
          const online = w.hashrate_10min > 0 || low(w.worker_status).includes("active");
          if (!online) continue;
          // pode haver (raramente) múltiplos miners com o mesmo tail na BD
          const ids = tailToIds.get(tw) || [];
          idsOnline.push(...ids);
        }

        const ids = dedupe(idsOnline);
        if (ids.length) {
          await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online,0) + 0.25
            WHERE id = ANY(${ids})
          `;
          updated += ids.length;
        }
      } catch {
        groupErrors += 1;
      }
    }

    console.log(
      `[uptime:viabtc] ${sISO} groups=${totalGroups} miners=${totalMiners} workers=${totalWorkersFetched} online=${updated} errs=${groupErrors} dur=${Date.now() - t0}ms`
    );
    return { ok: true, updated, groups: totalGroups, miners: totalMiners, workers: totalWorkersFetched, errs: groupErrors };
  } catch (e) {
    console.error(`[uptime:viabtc] ${sISO} ERROR: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function startUptimeViaBTC() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try { await runUptimeViaBTCOnce(); } catch {}
    },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] ViaBTC (*/15) agendado.");
}
