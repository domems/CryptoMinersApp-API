// controllers/statusController.js
import { sql } from "../config/db.js";
import { getWorkerStatus, normalizeStatus } from "../services/minerStatus.js";

const statusCache = new Map(); // id -> { data, timestamp }
const CACHE_TTL_MS = 60 * 1000;

/** GET /api/miners/:id/status  → { id, status, details? } */
export async function getMinerStatus(req, res) {
  try {
    const { id } = req.params;

    const cached = statusCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({ id, ...cached.data });
    }

    const rows = await sql`
      SELECT id, api_key, secret_key, coin, pool, worker_name
      FROM miners
      WHERE id::text = ${String(id)}
      LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: "Miner não encontrado." });

    const statusObj = await getWorkerStatus(rows[0]);
    const payload = {
      status: normalizeStatus(statusObj?.status),
      ...(statusObj?.details ? { details: statusObj.details } : {}),
    };

    statusCache.set(id, { data: payload, timestamp: Date.now() });
    return res.json({ id, ...payload });
  } catch (err) {
    console.error("❌ getMinerStatus:", err);
    return res.status(500).json({ error: "Erro interno ao obter status." });
  }
}

/** GET /api/miners/status?ids=1,2,3  →  [{ id, status, details? }, ...] */
export async function getMinersStatusBatch(req, res) {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: "Parâmetro 'ids' é obrigatório." });

    const results = [];
    const missing = [];

    // cache
    for (const id of ids) {
      const cached = statusCache.get(id);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        results.push({ id, ...cached.data });
      } else {
        missing.push(id);
      }
    }

    if (missing.length) {
      const rows = await sql`
        SELECT id, api_key, secret_key, coin, pool, worker_name
        FROM miners
        WHERE id::text = ANY(${sql.array(missing, "text")})
      `;

      const map = new Map(rows.map((r) => [String(r.id), r]));
      const q = [...missing];
      const limit = 5;
      const batch = [];

      async function worker() {
        while (q.length) {
          const id = q.shift();
          const row = map.get(String(id));
          if (!row) {
            const payload = { status: "offline", details: "not-found" };
            statusCache.set(id, { data: payload, timestamp: Date.now() });
            batch.push({ id, ...payload });
            continue;
          }
          try {
            const st = await getWorkerStatus(row);
            const payload = {
              status: normalizeStatus(st?.status),
              ...(st?.details ? { details: st.details } : {}),
            };
            statusCache.set(id, { data: payload, timestamp: Date.now() });
            batch.push({ id, ...payload });
          } catch {
            const payload = { status: "offline", details: "error" };
            statusCache.set(id, { data: payload, timestamp: Date.now() });
            batch.push({ id, ...payload });
          }
        }
      }

      await Promise.all(Array.from({ length: limit }, () => worker()));
      const m = new Map(batch.map((r) => [String(r.id), r]));
      for (const id of missing) results.push(m.get(String(id)));
    }

    // mesma ordem do pedido
    const ordered = ids.map(
      (id) => results.find((r) => String(r.id) === String(id)) || { id, status: "offline" }
    );
    return res.json(ordered);
  } catch (err) {
    console.error("❌ getMinersStatusBatch:", err);
    return res.status(500).json({ error: "Erro interno ao obter status em lote." });
  }
}
