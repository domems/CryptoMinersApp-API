// src/controllers/notificationsController.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function getUserId(req) {
  const uid = req.auth?.userId || req.user?.id || req.headers["x-user-id"];
  if (!uid) throw new Error("unauthorized");
  return uid;
}

export async function listMyNotifications(req, res) {
  try {
    const userId = getUserId(req);
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);

    const rows = asRows(await sql`
      SELECT o.id,
             o.template,
             o.payload_json,
             o.status,
             o.send_after_utc,
             COALESCE( (SELECT MAX(r.delivered_at_utc)
                        FROM notification_receipts r
                        WHERE r.outbox_id = o.id),
                       o.send_after_utc) AS delivered_at_utc,
             EXISTS (
               SELECT 1 FROM notification_user_reads ur
               WHERE ur.outbox_id = o.id AND ur.user_id = ${userId}
             ) AS is_read
      FROM notification_outbox o
      WHERE o.audience_kind='user'
        AND o.audience_ref=${userId}
        AND o.channel='inapp'
        AND o.status IN ('sent','pending')
      ORDER BY o.id DESC
      LIMIT ${limit}
    `);

    res.json({ items: rows });
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    res.status(code).json({ error: String(e.message || e) });
  }
}

export async function markMyNotificationRead(req, res) {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    // garante que a notificação pertence a este user e é inapp
    const row = asRows(await sql`
      SELECT id FROM notification_outbox
      WHERE id=${id} AND audience_kind='user' AND audience_ref=${userId} AND channel='inapp'
      LIMIT 1
    `)[0];
    if (!row) return res.status(404).json({ error: "not_found" });

    await sql`
      INSERT INTO notification_user_reads (outbox_id, user_id)
      VALUES (${id}, ${userId})
      ON CONFLICT (outbox_id, user_id) DO NOTHING
    `;

    return res.status(204).end();
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    res.status(code).json({ error: String(e.message || e) });
  }
}
