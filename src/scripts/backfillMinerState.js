// scripts/backfillMinerState.js
import { sql } from "../src/config/db.js";

/** ====== config ====== */
const SLOT_MIN = 15;
const OFFLINE_GRACE_MIN = 30; // minutos

function decideState({ lastSeenUtc, hashrate, minHashrate }) {
  const now = new Date();
  const minsSinceSeen = (now - new Date(lastSeenUtc)) / 60000;

  if (!lastSeenUtc) return "STALE"; // nunca vimos dados
  if (minsSinceSeen > SLOT_MIN + 1) return "STALE";
  if (Number(hashrate) <= 0) return "OFFLINE";
  if (minHashrate && Number(hashrate) < Number(minHashrate)) return "DEGRADED";
  return "ONLINE";
}

async function main() {
  console.log("[backfill] start");

  // Tenta descobrir a tabela de slots que tens (preferimos miner_slots).
  const { rows: slotTable } = await sql/*sql*/`
    SELECT to_regclass('public.miner_slots') AS ms, to_regclass('public.uptime_slots') AS us
  `;
  const table =
    slotTable[0]?.ms ? "miner_slots" :
    slotTable[0]?.us ? "uptime_slots" :
    null;

  if (!table) {
    console.error("✗ Não encontrei tabela de slots (esperava miner_slots ou uptime_slots). Cria-a primeiro.");
    process.exit(1);
  }

  // Puxa último slot por miner
  const rows = await sql/*sql*/`
    WITH last_slot AS (
      SELECT s.miner_id,
             s.slot_iso,
             s.hashrate,
             COALESCE(s.seen_at_utc, s.created_at_utc, NOW()) AS seen_at_utc,
             ROW_NUMBER() OVER (PARTITION BY s.miner_id ORDER BY s.slot_iso DESC) AS rn
      FROM ${sql(table)} s
    )
    SELECT m.id               AS miner_id,
           m.user_id,
           m.worker_name,
           COALESCE(p.min_hashrate, 0)  AS min_hashrate,
           COALESCE(p.offline_grace_min, ${OFFLINE_GRACE_MIN}) AS offline_grace_min,
           ls.slot_iso,
           ls.hashrate,
           ls.seen_at_utc
    FROM miners m
    LEFT JOIN last_slot ls ON ls.miner_id = m.id AND ls.rn = 1
    LEFT JOIN user_notification_prefs p ON p.user_id = m.user_id AND p.miner_id = m.id
    ORDER BY m.id
  `;

  let upserts = 0, missing = 0;
  for (const r of rows) {
    if (!r.slot_iso) { missing++; continue; }

    // aplica “graça” para não marcar OFFLINE demasiado cedo
    let next = decideState({
      lastSeenUtc: r.seen_at_utc,
      hashrate: r.hashrate,
      minHashrate: r.min_hashrate
    });

    const now = new Date();
    const minsSinceSeen = (now - new Date(r.seen_at_utc)) / 60000;
    if (next === "OFFLINE" && minsSinceSeen < Number(r.offline_grace_min || OFFLINE_GRACE_MIN)) {
      next = "STALE";
    }

    await sql/*sql*/`
      INSERT INTO miner_state (miner_id, current_state, stable_since_utc, last_change_utc, last_seen_utc, last_hashrate, flap_count)
      VALUES (${r.miner_id}, ${next}, ${r.seen_at_utc}, ${r.seen_at_utc}, ${r.seen_at_utc}, ${r.hashrate || 0}, 0)
      ON CONFLICT (miner_id) DO UPDATE
      SET current_state      = EXCLUDED.current_state,
          last_change_utc    = EXCLUDED.last_change_utc,
          stable_since_utc   = EXCLUDED.stable_since_utc,
          last_seen_utc      = EXCLUDED.last_seen_utc,
          last_hashrate      = EXCLUDED.last_hashrate
    `;
    upserts++;
  }

  console.log(`[backfill] upserts=${upserts}, sem_slots=${missing}, table=${table}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
