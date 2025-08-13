// utils/isAdmin.js
import { ADMINS } from "../config/adminList.js";

/**
 * Garante que estamos a comparar tudo em lowercase.
 * Recomendo ter os emails em ADMINS já em lowercase.
 */
export function isAdminEmail(email) {
  if (!email || typeof email !== "string") return false;
  const norm = email.trim().toLowerCase();
  return ADMINS.some((a) => String(a).trim().toLowerCase() === norm);
}

/**
 * Middleware Express para proteger rotas admin.
 * Lê o email do header "x-user-email" (enviado pelo frontend).
 */
export function verificarAdmin(req, res, next) {
  const email = String(req.headers["x-user-email"] || "");
  if (!email) {
    return res.status(401).json({ error: "Email do utilizador não fornecido." });
  }
  if (!isAdminEmail(email)) {
    return res.status(403).json({ error: "Acesso negado. Apenas admins autorizados." });
  }
  req.isAdmin = true;
  next();
}
