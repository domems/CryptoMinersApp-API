// src/scripts/debugDb.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

async function main() {
  const meta = asRows(await sql`
    SELECT current_database() AS db, current_schema() AS schema, now() AT TIME ZONE 'UTC' AS now_utc
  `)[0];

  const minersCount = asRows(await sql`SELECT COUNT(*)::int AS n FROM miners`)[0]?.n ?? 0;
  const minersList  = asRows(await sql`SELECT id, status FROM miners ORDER BY id`);
  const stateCount  = asRows(await sql`SELECT COUNT(*)::int AS n FROM miner_state`)[0]?.n ?? 0;
  const joinCheck   = asRows(await sql`
    SELECT m.id AS miner_id, (ms.miner_id IS NOT NULL) AS has_state
    FROM miners m
    LEFT JOIN miner_state ms ON ms.miner_id = m.id
    ORDER BY m.id
  `);

  console.log("DB META:", meta);
  console.log("miners COUNT:", minersCount);
  console.log("miner_state COUNT:", stateCount);
  console.log("miners IDs+status:", minersList);
  console.log("miner -> has_state:", joinCheck);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
