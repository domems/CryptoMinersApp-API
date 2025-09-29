// src/workers/pushWorker.js
import { sql } from "../config/db.js";

const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));
const TOKEN_RX = /^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/;

/* ================= utils ================= */
function chunk(arr, size = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function minsToHhMm(mins) {
  const m = Math.max(0, Math.floor(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}h${String(r).padStart(2, "0")}m` : `${r}m`;
}

function buildSingleContent({ template, payload }) {
  const worker = payload?.worker || `#${payload?.minerId}`;
  const at = new Date(payload?.atUtc || payload?.slot || Date.now());
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");

  if (template === "miner_offline") {
    return { title: "⚠️ Miner OFFLINE", body: `${worker} ficou OFFLINE às ${hh}:${mm}.` };
  }
  if (template === "miner_recovered") {
    return { title: "✅ Miner ONLINE", body: `${worker} ficou ONLINE às ${hh}:${mm}.` };
  }
  if (template === "miner_offline_reminder") {
    const since = payload?.sinceUtc ? new Date(payload.sinceUtc) : null;
    const durMin = since ? ((Date.now() - since.getTime()) / 60000) : 0;
    return { title: "⏰ Continua OFFLINE", body: `${worker} está em baixo há ${minsToHhMm(durMin)}.` };
  }
  return { title: "🔔 Atualização", body: `${worker}: ${template}` };
}

function buildBundledContent(group) {
  // group: array de outbox rows p/ MESMA audiência
  const names = [];
  let off = 0, on = 0, rem = 0;
  for (const n of group) {
    const w = n.payload_json?.worker || `#${n.payload_json?.minerId}`;
    if (names.length < 3) names.push(w);
    if (n.template === "miner_offline") off++;
    else if (n.template === "miner_recovered") on++;
    else if (n.template === "miner_offline_reminder") rem++;
  }
  const sample = names.join(", ") + (group.length > 3 ? " + outros" : "");
  if (off && !on && !rem) return { title: `⚠️ ${off} miner(s) OFFLINE`, body: sample };
  if (on && !off && !rem)  return { title: `✅ ${on} miner(s) ONLINE`, body: sample };
  if (rem && !off && !on)  return { title: `⏰ ${rem} lembrete(s) OFFLINE`, body: sample };
  return { title: `⛓️ Atualizações (${group.length})`, body: sample };
}

function parseQuiet(quiet_hours) {
  if (!quiet_hours) return null;
  const start = String(quiet_hours.start || "");
  const end = String(quiet_hours.end || "");
  const tz = String(quiet_hours.tz || "");
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || !tz) return null;
  return { start, end, tz };
}

/** devolve Date do próximo fim de quiet se estamos dentro; senão null */
function nextQuietEndIfInside(quiet) {
  if (!quiet) return null;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const curMin = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const [sh, sm] = quiet.start.split(":").map(Number);
  const [eh, em] = quiet.end.split(":").map(Number);
  const sMin = sh * 60 + sm, eMin = eh * 60 + em;

  let inside = false, delta;
  if (sMin <= eMin) {
    inside = curMin >= sMin && curMin < eMin;
    delta = inside ? (eMin - curMin) : 0;
  } else {
    // janela cruza meia-noite
    inside = curMin >= sMin || curMin < eMin;
    if (inside) delta = curMin < eMin ? (eMin - curMin) : (24 * 60 - curMin + eMin);
    else delta = 0;
  }
  if (!inside) return null;
  return new Date(now.getTime() + delta * 60000);
}

/* =============== Expo HTTP =============== */
async function sendBatch(messages) {
  const resp = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messages),
  });
  if (!resp.ok) throw new Error(`expo_http_${resp.status}:${await resp.text().catch(()=> "")}`);
  const json = await resp.json().catch(() => ({}));
  return json?.data || [];
}

async function dropBadTokens(badTokens = []) {
  if (!badTokens.length) return;
  // Neon-friendly: ANY($1)
  await sql`DELETE FROM device_push_tokens WHERE token = ANY(${badTokens})`;
}

/* =============== Worker principal =============== */
export async function deliverPushOnce() {
  // 1) Buscar até 200 tarefas PUSH pendentes (user + role)
  const rows = asRows(await sql`
    SELECT id, audience_kind, audience_ref, template, payload_json, send_after_utc
    FROM notification_outbox
    WHERE status='pending' AND channel='push' AND send_after_utc <= NOW()
    ORDER BY id
    LIMIT 200
  `);
  if (!rows.length) return { picked: 0, delivered: 0 };

  // 2) Agrupar por audiência (user:xyz ou role:admin)
  const groupsByAudience = new Map();
  for (const n of rows) {
    const key = `${n.audience_kind}:${n.audience_ref}`;
    if (!groupsByAudience.has(key)) groupsByAudience.set(key, []);
    groupsByAudience.get(key).push(n);
  }

  let delivered = 0;

  // 3) Processar cada audiência
  for (const [audKey, items] of groupsByAudience.entries()) {
    const [kind, ref] = audKey.split(":");

    // PREFS (apenas para user; roles ignoram prefs)
    let bundling = true, bundle_window_sec = 180, quiet = null;
    let pushEnabled = true; // respeitar channels
    if (kind === "user") {
      const p = asRows(await sql`
        SELECT channels, bundling, bundle_window_sec, quiet_hours
        FROM user_notification_prefs WHERE user_id=${ref}
      `)[0];
      const channels = Array.isArray(p?.channels) ? p.channels : ["push","inapp"];
      pushEnabled = channels.includes("push");
      bundling = p?.bundling ?? true;
      bundle_window_sec = Number(p?.bundle_window_sec ?? 180);
      quiet = parseQuiet(p?.quiet_hours);
    }

    // Se user desativou PUSH → mata estes itens
    if (kind === "user" && !pushEnabled) {
      const ids = items.map(i => i.id);
      await sql`UPDATE notification_outbox SET status='dead', attempts=attempts+1 WHERE id = ANY(${ids})`;
      for (const it of items) {
        await sql`INSERT INTO notification_receipts(outbox_id, success, error) VALUES (${it.id}, false, 'channel_disabled_push')`;
      }
      continue;
    }

    // Quiet hours (só user)
    const quietEnd = kind === "user" ? nextQuietEndIfInside(quiet) : null;
    if (quietEnd) {
      await sql`
        UPDATE notification_outbox
        SET send_after_utc = ${quietEnd}
        WHERE status='pending' AND channel='push' AND audience_kind=${kind} AND audience_ref=${ref}
      `;
      continue;
    }

    // 4) Recolher tokens
    let tokens = [];
    if (kind === "user") {
      tokens = asRows(await sql`SELECT token FROM device_push_tokens WHERE user_id=${ref} ORDER BY last_seen_utc DESC`)
        .map(r => r.token)
        .filter(t => TOKEN_RX.test(String(t)));
    } else if (kind === "role") {
      const userIds = asRows(await sql`SELECT user_id FROM role_recipients WHERE role=${ref}`).map(r => r.user_id);
      if (userIds.length) {
        tokens = asRows(await sql`SELECT token FROM device_push_tokens WHERE user_id = ANY(${userIds}) ORDER BY last_seen_utc DESC`)
          .map(r => r.token)
          .filter(t => TOKEN_RX.test(String(t)));
      }
    }

    if (!tokens.length) {
      // Nada a quem enviar → marca dead + recibos
      const ids = items.map(i => i.id);
      await sql`UPDATE notification_outbox SET status='dead', attempts=attempts+1 WHERE id = ANY(${ids})`;
      for (const it of items) {
        await sql`INSERT INTO notification_receipts(outbox_id, success, error) VALUES (${it.id}, false, 'no_tokens')`;
      }
      continue;
    }

    // 5) Bundling por janela
    items.sort((a, b) => new Date(a.send_after_utc) - new Date(b.send_after_utc));
    const groups = [];
    if (bundling && items.length > 1) {
      let cur = [items[0]];
      for (let i = 1; i < items.length; i++) {
        const first = new Date(cur[0].send_after_utc).getTime();
        const next = new Date(items[i].send_after_utc).getTime();
        if ((next - first) / 1000 <= bundle_window_sec) cur.push(items[i]);
        else { groups.push(cur); cur = [items[i]]; }
      }
      if (cur.length) groups.push(cur);
    } else {
      for (const it of items) groups.push([it]);
    }

    // 6) Enviar um push por grupo
    const badTokens = new Set();
    for (const group of groups) {
      const msg = group.length === 1
        ? buildSingleContent({ template: group[0].template, payload: group[0].payload_json })
        : buildBundledContent(group);

      const messages = tokens.map((to) => ({
        to,
        sound: "default",
        title: msg.title,
        body: msg.body,
        data: { type: "miner_alert", audience: audKey, grouped: group.length, items: group.map(g => g.payload_json) },
        priority: "high",
      }));

      let ok = false;
      try {
        for (const part of chunk(messages, 90)) {
          const tickets = await sendBatch(part);
          for (let i = 0; i < part.length; i++) {
            const tk = tickets[i];
            const token = part[i].to;
            if (tk?.status === "ok") ok = true;
            else {
              const code = (tk?.details?.error || tk?.error || "").toString();
              if (/DeviceNotRegistered|InvalidCredentials|InvalidToken/i.test(code)) badTokens.add(token);
            }
          }
        }
      } catch {
        // erro de rede: cai no backoff abaixo
      }

      if (badTokens.size) await dropBadTokens([...badTokens]);

      const ids = group.map(g => g.id);
      if (ok) {
        delivered++;
        await sql`UPDATE notification_outbox SET status='sent', attempts=attempts+1 WHERE id = ANY(${ids})`;
        for (const g of group) {
          await sql`INSERT INTO notification_receipts(outbox_id, success) VALUES (${g.id}, true)`;
        }
      } else {
        await sql`
          UPDATE notification_outbox
          SET attempts=attempts+1,
              status = CASE WHEN attempts >= 5 THEN 'dead' ELSE 'pending' END,
              send_after_utc = CASE 
                WHEN attempts >= 5 THEN send_after_utc
                ELSE NOW() + (INTERVAL '5 minutes' * LEAST(attempts+1, 6))
              END
          WHERE id = ANY(${ids})
        `;
        for (const g of group) {
          await sql`INSERT INTO notification_receipts(outbox_id, success, error) VALUES (${g.id}, false, 'send_failed_or_network')`;
        }
      }
    }
  }

  return { picked: rows.length, delivered };
}
