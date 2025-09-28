// src/workers/inappWorker.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

/**
 * Puxa até 50 itens 'inapp' pendentes e marca como 'sent'.
 * Sem transação para simplificar. Idempotente o suficiente para 1 processo.
 */
export async function deliverInappOnce() {
  const rows = asRows(await sql`
    UPDATE notification_outbox o
    SET status = 'sent', attempts = o.attempts + 1
    WHERE o.id IN (
      SELECT id FROM notification_outbox
      WHERE status='pending' AND channel='inapp' AND send_after_utc <= NOW()
      ORDER BY id
      LIMIT 50
    )
    RETURNING o.id
         , o.template
         , o.audience_kind
         , o.audience_ref
         , o.payload_json
  `);

  for (const n of rows) {
    await sql`
      INSERT INTO notification_receipts(outbox_id, success)
      VALUES (${n.id}, true)
    `;
  }
  return { delivered: rows.length };
}
