// middleware/adminOnly.js
import { requireAuth } from "@clerk/express";

export const adminOnly = [
  requireAuth(), // popula req.auth + valida o token
  (req, res, next) => {
    // 👇 vem do Session Token personalizado
    const role = req.auth?.sessionClaims?.metadata?.role;

    if (role !== "admin") {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  },
];
