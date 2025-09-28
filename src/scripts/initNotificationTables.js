// src/scripts/initNotificationTables.js
import { sql } from "../config/db.js";

async function main() {
  // Mensagens a enviar (duráveis, com dedupe e backoff)
  await sql`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id             BIGSERIAL PRIMARY KEY,
      dedupe_key     TEXT NOT NULL UNIQUE,
      audience_kind  TEXT NOT NULL CHECK (audience_kind IN ('user','role')),
      audience_ref   TEXT NOT NULL,                              -- user_id do Clerk OU 'admin'/'support'
      channel        TEXT NOT NULL CHECK (channel IN ('push','email','inapp','telegram','slack')),
      template       TEXT NOT NULL,                              -- ex.: 'miner_offline' | 'miner_recovered'
      payload_json   JSONB NOT NULL,
      send_after_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts       INT NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'pending'             -- pending | sending | sent | dead
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_status_time ON notification_outbox (status, send_after_utc);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_audience ON notification_outbox (audience_kind, audience_ref);`;

  // Registo de entregas (para debug/auditoria)
  await sql`
    CREATE TABLE IF NOT EXISTS notification_receipts (
      id               BIGSERIAL PRIMARY KEY,
      outbox_id        BIGINT REFERENCES notification_outbox(id) ON DELETE SET NULL,
      channel_msg_id   TEXT,
      delivered_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      success          BOOLEAN NOT NULL,
      error            TEXT
    );
  `;

  console.log("[initNotificationTables] OK");
  process.exit(0);
}

main().catch((e) => { console.error("[initNotificationTables] ERRO:", e); process.exit(1); });
