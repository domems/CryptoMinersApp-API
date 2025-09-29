// src/scripts/initInappReads.js
import { sql } from "../config/db.js";

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS notification_user_reads (
      outbox_id  BIGINT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
      user_id    TEXT   NOT NULL,
      read_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (outbox_id, user_id)
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_reads_user_time ON notification_user_reads (user_id, read_at_utc DESC);`;
  console.log("[initInappReads] OK");
  process.exit(0);
}

main().catch(e => { console.error("[initInappReads] ERRO:", e); process.exit(1); });
