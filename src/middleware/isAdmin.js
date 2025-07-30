// middleware/isAdmin.js
import { ADMINS } from "../config/adminList.js";

export const verificarAdmin = (req, res, next) => {
  const email = req.headers["x-user-email"]; // Esperamos que o frontend envie o email autenticado no header

  if (!email) {
    return res.status(401).json({ error: "Email do utilizador não fornecido." });
  }

  if (ADMINS.includes(email)) {
    req.isAdmin = true;
    next();
  } else {
    return res.status(403).json({ error: "Acesso negado. Apenas admins autorizados." });
  }
};
