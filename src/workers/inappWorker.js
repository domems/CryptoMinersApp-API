// src/workers/inappWorker.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

/**
 * Entrega "inapp" apenas se o user tiver o canal ativo nas prefs.
 * Para roles, ignoramos prefs (operacional).
 */
export async function deliverInappOnce() {
  // Buscar até 100 pendentes
  const rows = asRows(await sql`
    SELECT id, audience_kind, audience_ref, template, payload_json
    FROM notification_outbox
    WHERE status='pending' AND channel='inapp' AND send_after_utc <= NOW()
    ORDER BY id
    LIMIT 100
  `);
  if (!rows.length) return { delivered: 0, picked: 0 };

  let delivered = 0;

  // Agrupa por audiência
  const groups = new Map();
  for (const n of rows) {
    const key = `${n.audience_kind}:${n.audience_ref}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  for (const [audKey, items] of groups.entries()) {
    const [kind, ref] = audKey.split(":");

    if (kind === "user") {
      // verifica se 'inapp' está ativo
      const p = asRows(await sql`
        SELECT channels FROM user_notification_prefs WHERE user_id=${ref}
      `)[0];
      const channels = Array.isArray(p?.channels) ? p.channels : ["push","inapp"];
      const inappEnabled = channels.includes("inapp");

      if (!inappEnabled) {
        const ids = items.map(i => i.id);
        await sql`UPDATE notification_outbox SET status='dead', attempts=attempts+1 WHERE id = ANY(${ids})`;
        for (const it of items) {
          await sql`INSERT INTO notification_receipts(outbox_id, success, error) VALUES (${it.id}, false, 'channel_disabled_inapp')`;
        }
        continue;
      }
    }

    // Marca como 'sent' e cria recibos (in-app é apenas “disponível na lista”)
    const ids = items.map(i => i.id);
    await sql`
      UPDATE notification_outbox
      SET status='sent', attempts=attempts+1
      WHERE id = ANY(${ids})
    `;
    for (const it of items) {
      await sql`INSERT INTO notification_receipts(outbox_id, success) VALUES (${it.id}, true)`;
      delivered++;
    }
  }

  return { delivered, picked: rows.length };
}
