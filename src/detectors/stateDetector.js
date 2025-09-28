// src/detectors/stateDetector.js
import { sql } from "../config/db.js";
const asRows = (res) => (Array.isArray(res) ? res : (res?.rows ?? []));

/** Canonical: ONLINE | OFFLINE | STALE */
function canonicalStateFromStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const ONLINE  = ["online","on","active","ativo","ativa","working","running","normal","ok","up","alive","mining","hashing"];
  const OFFLINE = ["offline","off","inactive","inativo","inactiva","down","dead","stopped","error","erro","disabled","paused","fail","ko"];
  if (ONLINE.some(k => s.includes(k))) return "ONLINE";
  if (OFFLINE.some(k => s.includes(k))) return "OFFLINE";
  return "STALE";
}

/** slot ISO (15m) p/ agrupar eventos */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes(), q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

async function getCurrentState(minerId) {
  const r = asRows(await sql`
    SELECT current_state, stable_since_utc, last_seen_utc, last_hashrate
    FROM miner_state
    WHERE miner_id = ${minerId}
  `);
  return r[0] || null;
}

export async function processMiner(minerId) {
  // busca status + dono + worker
  const minerRows = asRows(await sql`
    SELECT id, status, user_id, worker_name
    FROM miners
    WHERE id = ${minerId}
  `);
  const miner = minerRows[0];
  if (!miner) return { changed: false, reason: "miner_not_found" };

  const next = canonicalStateFromStatus(miner.status);
  const prevRow = await getCurrentState(minerId);
  const prev = prevRow?.current_state || null;
  const now = new Date();
  const sISO = slotISO(now);

  // primeira vez: sem evento; só semear
  if (!prev) {
    await sql`
      INSERT INTO miner_state (miner_id, current_state, stable_since_utc, last_change_utc, last_seen_utc, last_hashrate, flap_count)
      VALUES (${minerId}, ${next}, ${now}, ${now}, ${now}, 0, 0)
      ON CONFLICT (miner_id) DO UPDATE
      SET current_state    = EXCLUDED.current_state,
          last_change_utc  = EXCLUDED.last_change_utc,
          stable_since_utc = EXCLUDED.stable_since_utc,
          last_seen_utc    = EXCLUDED.last_seen_utc
    `;
    return { changed: false, from: null, to: next };
  }

  if (prev === next) {
    await sql`UPDATE miner_state SET last_seen_utc = ${now} WHERE miner_id = ${minerId}`;
    return { changed: false, from: prev, to: next };
  }

  // mudou → 1) evento  2) atualizar estado  3) outbox (inapp)
  const shouldNotify =
    (prev !== "OFFLINE" && next === "OFFLINE") ||
    (prev !== "ONLINE"  && next === "ONLINE");

  // 1) evento (idempotente)
  await sql`
    INSERT INTO miner_state_events (miner_id, from_state, to_state, slot_iso, reason)
    VALUES (${minerId}, ${prev}, ${next}, ${sISO}, ${prev}||'→'||${next})
    ON CONFLICT DO NOTHING
  `;

  // 2) atualizar estado atual
  await sql`
    UPDATE miner_state
    SET current_state    = ${next},
        last_change_utc  = ${now},
        stable_since_utc = CASE WHEN current_state <> ${next} THEN ${now} ELSE stable_since_utc END,
        last_seen_utc    = ${now}
    WHERE miner_id = ${minerId}
  `;

  // 3) enfileirar notificação (idempotente por dedupe_key)
  if (shouldNotify) {
    const template = next === "OFFLINE" ? "miner_offline" : "miner_recovered";
    const dedupeKey = `miner:${minerId}:${prev}->${next}:${sISO}`;
    const payload = {
      minerId,
      worker: miner.worker_name || null,
      from: prev,
      to: next,
      slot: sISO,
      atUtc: now.toISOString()
    };
    await sql`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${dedupeKey}, 'user', ${miner.user_id}, 'inapp', ${template}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
  }

  return { changed: true, from: prev, to: next };
}

export async function detectAllOnce() {
  const miners = asRows(await sql`SELECT id FROM miners ORDER BY id`);
  let changed = 0, total = 0;
  for (const m of miners) {
    total++;
    const res = await processMiner(m.id);
    if (res.changed) changed++;
  }
  return { total, changed };
}
