// src/scripts/initNotificationPrefs.js
import { sql } from "../config/db.js";

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id               TEXT PRIMARY KEY,
      channels              JSONB NOT NULL DEFAULT '["push","inapp"]'::jsonb,
      bundling              BOOLEAN NOT NULL DEFAULT TRUE,
      bundle_window_sec     INT NOT NULL DEFAULT 180, -- 3 min
      quiet_hours           JSONB,                    -- {"start":"22:00","end":"07:00","tz":"Europe/Lisbon"}
      resend_cooldown_min   INT NOT NULL DEFAULT 120  -- para alertas persistentes (usaremos depois)
    );
  `;
  // Semeia prefs para todos os user_id que já existem em miners e ainda não têm prefs
  await sql`
    INSERT INTO user_notification_prefs (user_id, quiet_hours)
    SELECT DISTINCT m.user_id, jsonb_build_object('start','22:00','end','07:00','tz','Europe/Lisbon')
    FROM miners m
    LEFT JOIN user_notification_prefs p ON p.user_id = m.user_id
    WHERE p.user_id IS NULL
  `;
  console.log("[initNotificationPrefs] OK");
  process.exit(0);
}

main().catch((e) => { console.error("[initNotificationPrefs] ERRO:", e); process.exit(1); });
