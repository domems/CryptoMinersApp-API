// src/controllers/notificationsController.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function getUserId(req) {
  // adapta isto ao teu auth — Clerk normalmente mete req.auth.userId
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
             COALESCE( (SELECT MAX(r.delivered_at_utc) FROM notification_receipts r WHERE r.outbox_id = o.id),
                       o.send_after_utc ) AS delivered_at_utc
      FROM notification_outbox o
      WHERE o.audience_kind='user' AND o.audience_ref=${userId}
        AND o.channel='inapp'
        AND o.status IN ('sent','pending')  -- mostra pendente também, se quiseres só 'sent', troca aqui
      ORDER BY o.id DESC
      LIMIT ${limit}
    `);

    res.json({ items: rows });
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    res.status(code).json({ error: String(e.message || e) });
  }
}
