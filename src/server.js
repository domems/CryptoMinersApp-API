// server.js
import express from "express";
import dotenv from "dotenv";
import { sql } from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";
import minerRoutes from "./routes/miners.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMinersRoutes.js";
import { startAllJobs } from "./jobs/index.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes from "./routes/payments.js";
import minersAdminRoutes from "./routes/minersAdminRoutes.js";
import adminInvoicesRouter from "./routes/adminInvoicesRouter.js";

// ⬇️ NOVOS imports
import { clerkMiddleware } from "@clerk/express";
import authRouter from "./routes/auth.js";
import { adminOnly } from "./middleware/adminOnly.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const app = express();

app.use(clerkMiddleware());
// ❗ raw body só para o webhook do NOWPayments (antes do express.json)
app.use("/api/payments/webhook/nowpayments", express.raw({ type: "*/*" }));

// Clerk middleware (popula req.auth) — NÃO exige login por si só


// middleware gerais
app.use(rateLimiter);
app.use(express.json());

// ---- rotas públicas/gerais ----
app.use("/api/clerk", clerkRoutes);
app.use("/api/miners", minerRoutes);
app.use("/api", statusRoutes);
app.use("/api", storeMinersRoutes);
app.use("/api", invoicesRoutes);
app.use("/api", paymentsRoutes);
app.use("/api", adminInvoicesRouter);

// ⬇️ rota para bootstrap de roles (usada pelo app após login/signup)
app.use("/api/auth", authRouter);

// ---- rotas ADMIN (protegidas por role) ----
app.use("/api", ...adminOnly, minersAdminRoutes);

// raiz
app.get("/", (_req, res) => {
  res.send("Its working");
});

console.log("my port:", process.env.PORT);

// Cria/atualiza tabelas
async function initDB() {
  try {
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS miners (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        nome TEXT NOT NULL,
        modelo TEXT,
        hash_rate TEXT,
        status TEXT DEFAULT 'online',
        data_registo TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("✅ DB pronta (tabelas e colunas verificadas).");
  } catch (err) {
    console.error("❌ Erro ao preparar a DB:", err);
    process.exit(1);
  }
}

// arranque
initDB().then(() => {
  app.listen(PORT, () => {
    startAllJobs();
    console.log("Server is up and running at port", PORT);
  });
});
