// middleware/adminOnly.js
import { clerkClient, requireAuth } from "@clerk/express";

/**
 * Garante sessão válida (requireAuth) e role 'admin' na publicMetadata.
 * Usa a API do Clerk para ler metadata (não depende de token custom).
 */
export const adminOnly = [
  requireAuth(),
  async (req, res, next) => {
    try {
      const { userId } = req.auth || {};
      if (!userId) return res.status(401).json({ error: "unauthorized" });

      const user = await clerkClient.users.getUser(userId);
      const role = (user.publicMetadata || {}).role;

      if (role !== "admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      next();
    } catch (err) {
      console.error("[adminOnly] error:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  },
];
