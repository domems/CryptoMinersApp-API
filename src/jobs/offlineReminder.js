// src/jobs/offlineReminder.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function floorWindowISO(now, minutes) {
  const ms = minutes * 60000;
  const w = new Date(Math.floor(now.getTime() / ms) * ms);
  return w.toISOString();
}

export async function runOfflineReminderOnce() {
  const now = new Date();

  // OFFLINE atuais + prefs do dono
  const rows = asRows(await sql`
    SELECT ms.miner_id,
           m.user_id,
           m.worker_name,
           ms.stable_since_utc,
           COALESCE(p.resend_cooldown_min, 120) AS cooldown_min
    FROM miner_state ms
    JOIN miners m ON m.id = ms.miner_id
    LEFT JOIN user_notification_prefs p ON p.user_id = m.user_id
    WHERE ms.current_state = 'OFFLINE'
  `);

  let enqueued = 0;

  for (const r of rows) {
    const cooldown = Number(r.cooldown_min || 120);
    if (cooldown <= 0) continue;

    const minutesOffline = (now - new Date(r.stable_since_utc)) / 60000;
    if (minutesOffline < cooldown) continue; // ainda dentro do 1º período

    // se já houve reminder nos últimos <cooldown> minutos, salta
    const exists = asRows(await sql`
      SELECT 1
      FROM notification_outbox
      WHERE channel='push'
        AND template='miner_offline_reminder'
        AND status IN ('pending','sent')
        AND (payload_json->>'minerId')::bigint = ${r.miner_id}
        AND send_after_utc > NOW() - (${cooldown}::int || ' minutes')::interval
      LIMIT 1
    `)[0];
    if (exists) continue;

    const dedupeKey = `miner:${r.miner_id}:offline_reminder:${floorWindowISO(now, cooldown)}`;
    const payload = {
      minerId: r.miner_id,
      worker: r.worker_name || null,
      sinceUtc: new Date(r.stable_since_utc).toISOString(),
      atUtc: now.toISOString()
    };

    await sql`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${dedupeKey}, 'user', ${r.user_id}, 'push', 'miner_offline_reminder', ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    enqueued++;
  }

  return { scanned: rows.length, enqueued };
}

// CLI runner
if (import.meta.url === `file://${process.argv[1]}`) {
  runOfflineReminderOnce()
    .then((r) => { console.log(`[offlineReminder] scanned=${r.scanned} enqueued=${r.enqueued}`); process.exit(0); })
    .catch((e) => { console.error("[offlineReminder] ERRO:", e); process.exit(1); });
}
