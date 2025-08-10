import { sql } from "../config/db.js";

// horas online (float) por miner_id num intervalo [from,to)
export async function hoursOnlineByMiner(fromTs, toTs) {
  return sql/*sql*/`
    WITH params AS (
      SELECT ${fromTs}::timestamptz AS from_ts, ${toTs}::timestamptz AS to_ts
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
