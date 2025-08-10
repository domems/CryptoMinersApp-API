import { sql } from "../config/db.js";
import { hoursOnlineByMiner } from "./hoursOnline.js";

// cria/atualiza faturas do mês (1 por user, com N linhas por miner)
export async function createMonthlyInvoices(year, month) {
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
  const to   = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();

  const hoursRows = await hoursOnlineByMiner(from, to);
  const hoursMap = new Map(hoursRows.map(r => [Number(r.miner_id), Number(r.hours_online)]));

  const miners = await sql`
    SELECT id, user_id, nome, preco_kw, consumo_kw_hora
    FROM miners
  `;

  // agrupar miners por utilizador
  const byUser = new Map();
  for (const m of miners) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m);
  }

  for (const [userId, list] of byUser.entries()) {
    const [inv] = await sql`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_eur, status)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente')
      ON CONFLICT (user_id, year, month)
      DO UPDATE SET updated_at = now()
      RETURNING id
    `;

    let subtotal = 0;

    for (const m of list) {
      const hours = hoursMap.get(Number(m.id)) ?? 0;
      const kwh   = +(hours * Number(m.consumo_kw_hora)).toFixed(3);
      const line  = +(kwh * Number(m.preco_kw)).toFixed(2);
      subtotal   += line;

      await sql`
        INSERT INTO energy_invoice_items
        (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
        VALUES
        (${inv.id}, ${m.id}, ${m.nome ?? `Miner#${m.id}`}, ${hours}, ${kwh}, ${m.preco_kw}, ${m.consumo_kw_hora}, ${line})
        ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
          miner_nome = EXCLUDED.miner_nome,
          hours_online = EXCLUDED.hours_online,
          kwh_used = EXCLUDED.kwh_used,
          preco_kw = EXCLUDED.preco_kw,
          consumo_kw_hora = EXCLUDED.consumo_kw_hora,
          amount_eur = EXCLUDED.amount_eur
      `;
    }

    await sql`
      UPDATE energy_invoices
      SET subtotal_eur = ${+subtotal.toFixed(2)}, status = 'pendente'
      WHERE id = ${inv.id}
    `;
  }
}
