// backend/middleware/adminLimiter.js
import rateLimit from "express-rate-limit";

export default rateLimit({
  windowMs: 60_000, // 1 minuto
  limit: 300,       // mais folgado para backoffice
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers["x-user-email"]?.toString().toLowerCase()) ||
    req.ip ||
    "anon",
});
