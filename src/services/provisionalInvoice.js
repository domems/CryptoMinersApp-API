// services/provisionalInvoice.js
import { sql } from "../config/db.js";

// horas online por miner num intervalo
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

export async function computeProvisionalInvoiceForUser(userId) {
  const now = new Date();
  // mês atual: [1º dia 00:00 .. agora] em UTC (ajusta TZ se quiseres Lisbon)
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const to   = now;

  const [miners, hoursRows] = await Promise.all([
    sql/*sql*/`SELECT id, nome, preco_kw, consumo_kw_hora FROM miners WHERE user_id = ${userId}`,
    hoursOnlineByMiner(from.toISOString(), to.toISOString()),
  ]);

  const hoursMap = new Map(hoursRows.map(r => [Number(r.miner_id), Number(r.hours_online)]));
  const items = [];
  let subtotal = 0;

  for (const m of miners) {
    const hours = hoursMap.get(Number(m.id)) ?? 0;
    const kwh   = +(hours * Number(m.consumo_kw_hora || 0)).toFixed(3);
    const line  = +(kwh * Number(m.preco_kw || 0)).toFixed(2);
    subtotal   += line;

    items.push({
      miner_id: m.id,
      miner_nome: m.nome || `Miner#${m.id}`,
      hours_online: hours,
      kwh_used: kwh,
      preco_kw: Number(m.preco_kw || 0),
      consumo_kw_hora: Number(m.consumo_kw_hora || 0),
      amount_eur: line,
    });
  }

  return {
    header: {
      id: null,                                 // não existe ainda
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      subtotal_eur: +subtotal.toFixed(2),
      status: "em_curso",
    },
    items,
  };
}
