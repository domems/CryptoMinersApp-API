// src/scripts/initPushTables.js
import { sql } from "../config/db.js";

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      token          TEXT PRIMARY KEY,                -- ExponentPushToken[...] | ExpoPushToken[...]
      user_id        TEXT NOT NULL,                   -- Clerk user id
      platform       TEXT,                            -- ios | android | web
      last_seen_utc  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_tokens_user ON device_push_tokens (user_id);`;
  console.log("[initPushTables] OK");
  process.exit(0);
}

main().catch((e) => { console.error("[initPushTables] ERRO:", e); process.exit(1); });
