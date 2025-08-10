import { sql } from "../config/db.js";

// calcula horas online por miner no intervalo
async function hoursOnlineByMiner(fromIso, toIso) {
  return sql/*sql*/`
    WITH params AS (
      SELECT ${fromIso}::timestamptz AS from_ts, ${toIso}::timestamptz AS to_ts
    ),
    start_event AS (
      SELECT m.id AS miner_id, p.from_ts AS at,
        COALESCE((
          SELECT status FROM miner_status_logs
          WHERE miner_id = m.id AND at < p.from_ts
          ORDER BY at DESC LIMIT 1
        ), false) AS status
      FROM miners m, params p
    ),
    events AS (
      SELECT miner_id, at, status FROM start_event
      UNION ALL
      SELECT l.miner_id, l.at, l.status
      FROM miner_status_logs l, params p
      WHERE l.at >= p.from_ts AND l.at < p.to_ts
    ),
    ordered AS (
      SELECT miner_id, at, status,
             lead(at) OVER (PARTITION BY miner_id ORDER BY at) AS next_at
      FROM events
    ),
    clamped AS (
      SELECT miner_id,
             GREATEST(at, (SELECT from_ts FROM params)) AS start_at,
             LEAST(COALESCE(next_at, (SELECT to_ts FROM params)), (SELECT to_ts FROM params)) AS end_at,
             status
      FROM ordered
    )
    SELECT
      miner_id,
      COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0) FILTER (WHERE status = true), 0) AS hours_online
    FROM clamped
    GROUP BY miner_id
  `;
}

function monthBoundsFromParams({ year, month }) {
  if (year && month) {
    const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const to   = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    return { year, month, fromIso: from.toISOString(), toIso: to.toISOString() };
  }
  // mês anterior por omissão
  const now = new Date();
  const prevMonth = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const from = new Date(Date.UTC(y, prevMonth - 1, 1, 0, 0, 0));
  const to   = new Date(Date.UTC(y, prevMonth, 1, 0, 0, 0));
  return { year: y, month: prevMonth, fromIso: from.toISOString(), toIso: to.toISOString() };
}

export async function runInvoices({ year, month } = {}) {
  const b = monthBoundsFromParams({ year, month });

  const hoursRows = await hoursOnlineByMiner(b.fromIso, b.toIso);
  const hoursMap = new Map(hoursRows.map(r => [Number(r.miner_id), Number(r.hours_online)]));

  const miners = await sql/*sql*/`
    SELECT id, user_id, nome, preco_kw, consumo_kw_hora
    FROM miners
  `;

  // agrupar por utilizador
  const byUser = new Map();
  for (const m of miners) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m);
  }

  for (const [userId, list] of byUser.entries()) {
    // header idempotente
    const [inv] = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_eur, status)
      VALUES (${userId}, ${b.year}, ${b.month}, 0, 'pendente')
      ON CONFLICT (user_id, year, month)
      DO UPDATE SET updated_at = now()
      RETURNING id
    `;

    let subtotal = 0;

    for (const m of list) {
      const hours = hoursMap.get(Number(m.id)) ?? 0;
      const kwh   = +(hours * Number(m.consumo_kw_hora || 0)).toFixed(3);
      const line  = +(kwh * Number(m.preco_kw || 0)).toFixed(2);
      subtotal   += line;

      await sql/*sql*/`
        INSERT INTO energy_invoice_items
          (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
        VALUES
          (${inv.id}, ${m.id}, ${m.nome || `Miner#${m.id}`}, ${hours}, ${kwh},
           ${m.preco_kw || 0}, ${m.consumo_kw_hora || 0}, ${line})
        ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
          miner_nome       = EXCLUDED.miner_nome,
          hours_online     = EXCLUDED.hours_online,
          kwh_used         = EXCLUDED.kwh_used,
          preco_kw         = EXCLUDED.preco_kw,
          consumo_kw_hora  = EXCLUDED.consumo_kw_hora,
          amount_eur       = EXCLUDED.amount_eur
      `;
    }

    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_eur = ${+subtotal.toFixed(2)}, status = 'pendente'
      WHERE id = ${inv.id}
    `;
  }
}
