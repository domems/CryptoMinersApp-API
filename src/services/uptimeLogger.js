import { sql } from "../config/db.js";
import { isMinerOnline } from "./minerStatus.js";

// só insere log quando o estado mudar
export async function logMinerIfChanged(miner) {
  const online = await isMinerOnline(miner);

  const last = await sql`
    SELECT status FROM miner_status_logs
    WHERE miner_id = ${miner.id}
    ORDER BY at DESC
    LIMIT 1
  `;
  const lastStatus = last[0]?.status;

  if (lastStatus === undefined || lastStatus !== online) {
    await sql`
      INSERT INTO miner_status_logs (miner_id, status, source, extra)
      VALUES (${miner.id}, ${online}, ${miner.pool}, '{}'::jsonb)
    `;
  }
}
