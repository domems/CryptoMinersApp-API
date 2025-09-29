// src/controllers/prefsController.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function getUserId(req) {
  const uid = req.auth?.userId || req.user?.id || req.headers["x-user-id"];
  if (!uid) throw new Error("unauthorized");
  return uid;
}

const DEFAULT_PREFS = Object.freeze({
  channels: ["push", "inapp"],
  bundling: true,
  bundle_window_sec: 180,
  quiet_hours: { start: "22:00", end: "07:00", tz: "Europe/Lisbon" },
  resend_cooldown_min: 120,
});

function validateHHMM(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

function normalizePrefs(input) {
  const out = {};
  if ("channels" in input) {
    if (!Array.isArray(input.channels)) throw new Error("channels must be array");
    const allowed = new Set(["push", "inapp"]);
    const arr = input.channels.filter((c) => allowed.has(String(c)));
    if (arr.length === 0) throw new Error("channels cannot be empty");
    out.channels = arr;
  }
  if ("bundling" in input) {
    out.bundling = Boolean(input.bundling);
  }
  if ("bundle_window_sec" in input) {
    const v = Number(input.bundle_window_sec);
    if (!Number.isFinite(v) || v < 30 || v > 3600) throw new Error("bundle_window_sec must be 30..3600");
    out.bundle_window_sec = Math.floor(v);
  }
  if ("resend_cooldown_min" in input) {
    const v = Number(input.resend_cooldown_min);
    if (!Number.isFinite(v) || v < 0 || v > 1440) throw new Error("resend_cooldown_min must be 0..1440");
    out.resend_cooldown_min = Math.floor(v);
  }
  if ("quiet_hours" in input) {
    if (input.quiet_hours == null) {
      out.quiet_hours = null; // desativado
    } else {
      const q = input.quiet_hours || {};
      const start = q.start, end = q.end, tz = q.tz;
      if (!validateHHMM(start) || !validateHHMM(end) || typeof tz !== "string" || !tz) {
        throw new Error("quiet_hours must be {start:'HH:MM', end:'HH:MM', tz:'Area/City'} or null");
      }
      out.quiet_hours = { start, end, tz };
    }
  }
  return out;
}

export async function getMyPrefs(req, res) {
  try {
    const userId = getUserId(req);
    const row = asRows(await sql`
      SELECT user_id, channels, bundling, bundle_window_sec, quiet_hours, resend_cooldown_min
      FROM user_notification_prefs
      WHERE user_id=${userId}
    `)[0];

    if (!row) {
      const d = DEFAULT_PREFS;
      await sql`
        INSERT INTO user_notification_prefs
          (user_id, channels, bundling, bundle_window_sec, quiet_hours, resend_cooldown_min)
        VALUES
          (${userId}, ${JSON.stringify(d.channels)}::jsonb, ${d.bundling}, ${d.bundle_window_sec},
           ${JSON.stringify(d.quiet_hours)}::jsonb, ${d.resend_cooldown_min})
        ON CONFLICT (user_id) DO NOTHING
      `;
      return res.json({ user_id: userId, ...d });
    }

    return res.json(row);
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    res.status(code).json({ error: String(e.message || e) });
  }
}

export async function patchMyPrefs(req, res) {
  try {
    const userId = getUserId(req);
    const patch = normalizePrefs(req.body ?? {});
    // fetch current or defaults
    const cur = asRows(await sql`
      SELECT channels, bundling, bundle_window_sec, quiet_hours, resend_cooldown_min
      FROM user_notification_prefs WHERE user_id=${userId}
    `)[0] || { ...DEFAULT_PREFS };

    const next = { ...cur, ...patch };

    await sql`
      INSERT INTO user_notification_prefs
        (user_id, channels, bundling, bundle_window_sec, quiet_hours, resend_cooldown_min)
      VALUES
        (${userId}, ${JSON.stringify(next.channels)}::jsonb, ${next.bundling}, ${next.bundle_window_sec},
         ${next.quiet_hours ? JSON.stringify(next.quiet_hours) : null}::jsonb, ${next.resend_cooldown_min})
      ON CONFLICT (user_id) DO UPDATE
      SET channels=${JSON.stringify(next.channels)}::jsonb,
          bundling=${next.bundling},
          bundle_window_sec=${next.bundle_window_sec},
          quiet_hours=${next.quiet_hours ? JSON.stringify(next.quiet_hours) : null}::jsonb,
          resend_cooldown_min=${next.resend_cooldown_min}
    `;

    res.status(204).end();
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 400;
    res.status(code).json({ error: String(e.message || e) });
  }
}
