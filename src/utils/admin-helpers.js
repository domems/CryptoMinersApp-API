// utils/admin-helpers.js
import { isAdminEmail } from "./isAdmin.js";
import { resolveUserIdByEmail as resolveUserIdByEmailFromService } from "../services/clerkUserService.js";

export async function assertAdminFromHeader(req) {
  const headerEmail = String(req.headers["x-user-email"] || "").trim().toLowerCase();
  if (!headerEmail || !isAdminEmail(headerEmail)) {
    const err = new Error("Não autorizado");
    err.status = 403;
    throw err;
  }
}

// Reexport para manter o mesmo nome noutros ficheiros
export async function resolveUserIdByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return null;
  try {
    return await resolveUserIdByEmailFromService(norm);
  } catch (e) {
    // Se o service lançar 404, devolvemos null (frontend mostra “sem resultados”)
    if (e && (e.status === 404 || e.statusCode === 404)) return null;
    // Outros erros (auth, rede, etc.) sobem para o handler
    throw e;
  }
}
