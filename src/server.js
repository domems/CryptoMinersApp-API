// server.js
import express from "express";
import dotenv from "dotenv";
import { sql } from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";
import minerRoutes from "./routes/miners.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMiners.js";
import { startAllJobs } from "./jobs/index.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes from "./routes/payments.js";
import minersAdminRoutes from "./routes/minersAdminRoutes.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const app = express();

// ❗ raw body só para o webhook do NOWPayments (antes do express.json)
app.use("/api/payments/webhook/nowpayments", express.raw({ type: "*/*" }));

// middleware
app.use(rateLimiter);
app.use(express.json());

// monta as rotas
app.use("/api/clerk", clerkRoutes);
app.use("/api/miners", minerRoutes);
app.use("/api", statusRoutes);
app.use("/api/store-miners", storeMinersRoutes);
app.use("/api", invoicesRoutes);
app.use("/api", paymentsRoutes);
app.use("/api/admin", minersAdminRoutes);

// raiz
app.get("/", (_req, res) => {
  res.send("Its working");
});

console.log("my port:", process.env.PORT);

// Cria/atualiza tabelas
async function initDB() {
  try {
    // Tabela base (se não existir)
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
