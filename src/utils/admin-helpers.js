// backend/utils/admin-helpers.js
import { sql } from "../config/db.js";
import { isAdminEmail } from "./isAdmin.js"; // o mesmo que usas no app

export async function assertAdminFromHeader(req) {
  const headerEmail = String(req.headers["x-user-email"] || "").toLowerCase();
  if (!headerEmail || !isAdminEmail(headerEmail)) {
    const err = new Error("Não autorizado");
    err.status = 403;
    throw err;
  }
}

export async function resolveUserIdByEmail(email) {
  // Implementa conforme a tua BD.
  // Exemplo 1: se tens tabela "app_users" com (email, clerk_user_id)
  const found = await sql/*sql*/`
    SELECT clerk_user_id AS user_id
    FROM app_users
    WHERE LOWER(email) = ${email}
    LIMIT 1
  `;
  if (found.length) return String(found[0].user_id);

  // Exemplo 2 (fallback): tenta descobrir pela tabela miners
  const byMiner = await sql/*sql*/`
    SELECT user_id
    FROM miners
    WHERE LOWER(owner_email) = ${email}
    LIMIT 1
  `;
  if (byMiner.length) return String(byMiner[0].user_id);

  return null;
}
