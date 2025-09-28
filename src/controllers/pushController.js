// src/controllers/pushController.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function getUserId(req) {
  const uid = req.auth?.userId || req.user?.id || req.headers["x-user-id"];
  if (!uid) throw new Error("unauthorized");
  return uid;
}

const TOKEN_RX = /^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/;

export async function registerPushToken(req, res) {
  try {
    const userId = getUserId(req);
    const { token, platform } = req.body ?? {};
    if (!token || !TOKEN_RX.test(String(token))) {
      return res.status(400).json({ error: "invalid_expo_token" });
    }
    const pf = (platform || "").toLowerCase();
    await sql`
      INSERT INTO device_push_tokens (token, user_id, platform, last_seen_utc)
      VALUES (${token}, ${userId}, ${pf || null}, NOW())
      ON CONFLICT (token) DO UPDATE
      SET user_id=${userId},
          platform=COALESCE(${pf || null}, device_push_tokens.platform),
          last_seen_utc=NOW()
    `;
    return res.status(204).end();
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: String(e.message || e) });
  }
}

export async function deletePushToken(req, res) {
  try {
    const userId = getUserId(req);
    const { token } = req.body ?? {};
    if (!token) return res.status(400).json({ error: "token_required" });
    await sql`DELETE FROM device_push_tokens WHERE token=${token} AND user_id=${userId}`;
    return res.status(204).end();
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: String(e.message || e) });
  }
}
