// controllers/minersAdmin.js
import { sql } from "../config/db.js";
import { resolveUserIdByEmail } from "../services/clerkUserService.js";

// mantém a tua lista de admins como já tens
const adminEmails = ["domems@gmail.com", "admin2@email.com"];

export async function listarMinersPorEmail(req, res) {
  try {
    // Verificação de admin — usa o que já tens no frontend (x-user-email) OU token Clerk (se já tiveres middleware)
    const requesterEmail = (req.header("x-user-email") || "").toLowerCase();
    if (!adminEmails.includes(requesterEmail)) {
      return res.status(403).json({ error: "Acesso negado. Apenas admins." });
    }

    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Parâmetro 'email' é obrigatório." });

    // 1) Resolve email → Clerk user_id
    const userId = await resolveUserIdByEmail(email);

    // 2) Vai buscar as mineradoras desse utilizador
    const miners = await sql`
      SELECT *
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;

    return res.json(miners);
  } catch (err) {
    console.error("listarMinersPorEmail:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || "Erro ao listar miners por email." });
  }
}
