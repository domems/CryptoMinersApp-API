// middleware/requireAdmin.js
import { isEmailAdminByClerk } from "../services/clerkUserService.js";

// ⚠️ Opcional: fallback para compatibilidade (mantém os teus e-mails antigos)
const allowlist = (process.env.ADMIN_EMAILS || "domems@gmail.com,admin2@email.com")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Middleware que valida se o requester é admin:
 * 1) tenta Clerk (public_metadata.role === "admin")
 * 2) fallback allowlist (compat)
 * Requer que o cliente envie `x-user-email`.
 */
export async function requireAdmin(req, res, next) {
  try {
    const email = String(req.header("x-user-email") || "").toLowerCase();
    if (!email) {
      return res.status(401).json({ error: "Cabeçalho x-user-email em falta." });
    }

    // 1) Clerk
    try {
      const ok = await isEmailAdminByClerk(email);
      if (ok) {
        req.adminEmail = email;
        return next();
      }
    } catch (e) {
      // não bloqueia; tenta fallback
      console.warn("[requireAdmin] Clerk lookup falhou:", e?.message || e);
    }

    // 2) Fallback allowlist
    if (allowlist.includes(email)) {
      req.adminEmail = email;
      return next();
    }

    return res.status(403).json({ error: "Acesso negado. Apenas admins." });
  } catch (err) {
    console.error("[requireAdmin] erro:", err);
    return res.status(500).json({ error: "Falha a validar permissões." });
  }
}
