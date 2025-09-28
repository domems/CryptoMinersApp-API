// src/scripts/backfillMinerState.js
import { sql } from "../config/db.js";

const asRows = (res) => (Array.isArray(res) ? res : (res?.rows ?? []));

const SLOT_MIN = 15;
const OFFLINE_GRACE_MIN = 30;

function decideState({ lastSeenUtc, hashrate, minHashrate = 0 }) {
  const now = new Date();
  const seen = lastSeenUtc ? new Date(lastSeenUtc) : null;
  const minsSinceSeen = seen ? (now - seen) / 60000 : Infinity;

  if (!seen) return "STALE";
  if (minsSinceSeen > SLOT_MIN + 1) return "STALE";
  if (Number(hashrate) <= 0) return "OFFLINE";
  if (minHashrate && Number(hashrate) < Number(minHashrate)) return "DEGRADED";
  return "ONLINE";
}

async function detectSlotTable() {
  const candidates = ["miner_slots", "uptime_slots", "uptimeviabtc", "uptime_binance", "uptime_f2pool"];
  for (const t of candidates) {
    const r = asRows(await sql`SELECT to_regclass(${`public.${t}`}) AS t`);
    if (r[0]?.t) return t;
  }
  const f = asRows(await sql`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND column_name IN ('miner_id','slot_iso','hashrate')
    GROUP BY table_name
    HAVING COUNT(DISTINCT column_name) >= 3
    ORDER BY table_name
    LIMIT 1
  `);
  return f[0]?.table_name ?? null;
}

async function main() {
  console.log("[backfill] start");

  const table = await detectSlotTable();
  if (!table) {
    console.error("✗ Não encontrei tabela de slots (preciso de miner_id, slot_iso, hashrate).");
    process.exit(1);
  }
  console.log(`[backfill] usando tabela: ${table}`);

  // ⚠️ Identificadores (nome da tabela) não podem ser parametrizados na tag => usa sql.query com string construída.
  const q = `
    WITH last_slot AS (
      SELECT s.miner_id, s.slot_iso, s.hashrate,
             COALESCE(s.seen_at_utc, s.created_at_utc, s.created_at, NOW()) AS seen_at_utc,
             ROW_NUMBER() OVER (PARTITION BY s.miner_id ORDER BY s.slot_iso DESC) AS rn
      FROM ${table} s
    )
    SELECT m.id AS miner_id, ls.slot_iso, ls.hashrate, ls.seen_at_utc
    FROM miners m
    LEFT JOIN last_slot ls ON ls.miner_id = m.id AND ls.rn = 1
    ORDER BY m.id
  `;
  const rows = asRows(await sql.query(q));

  let upserts = 0, missing = 0;
  for (const r of rows) {
    if (!r?.slot_iso) { missing++; continue; }

    let next = decideState({ lastSeenUtc: r.seen_at_utc, hashrate: r.hashrate });
    const now = new Date();
    const minsSinceSeen = (now - new Date(r.seen_at_utc)) / 60000;
    if (next === "OFFLINE" && minsSinceSeen < OFFLINE_GRACE_MIN) next = "STALE";

    await sql`
      INSERT INTO miner_state (miner_id, current_state, stable_since_utc, last_change_utc, last_seen_utc, last_hashrate, flap_count)
      VALUES (${r.miner_id}, ${next}, ${r.seen_at_utc}, ${r.seen_at_utc}, ${r.seen_at_utc}, ${r.hashrate || 0}, 0)
      ON CONFLICT (miner_id) DO UPDATE
      SET current_state    = EXCLUDED.current_state,
          last_change_utc  = EXCLUDED.last_change_utc,
          stable_since_utc = EXCLUDED.stable_since_utc,
          last_seen_utc    = EXCLUDED.last_seen_utc,
          last_hashrate    = EXCLUDED.last_hashrate
    `;
    upserts++;
  }

  console.log(`[backfill] upserts=${upserts}, sem_slots=${missing}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
