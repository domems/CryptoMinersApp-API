// server.js
import express from "express";
import dotenv from "dotenv";
import { sql } from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";
import minerRoutes from "./routes/miners.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMiners.js";
import taskRoutes from "./routes/tasks.js";

// NOVO: rotas de faturas
import invoicesRoutes from "./routes/invoices.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const app = express();

// middleware
app.use(rateLimiter);
app.use(express.json());

// monta as rotas
app.use("/api/clerk", clerkRoutes);
app.use("/api/miners", minerRoutes);
app.use("/api", statusRoutes);
app.use("/api/store-miners", storeMinersRoutes);
// NOVO
app.use("/api/invoices", invoicesRoutes);
app.use("/api/_tasks", taskRoutes);

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

    // Estender miners com campos de faturação/API (só se faltarem)
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS preco_kw NUMERIC(12,6);`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS consumo_kw_hora NUMERIC(12,6);`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS worker_name TEXT;`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS api_key TEXT;`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS secret_key TEXT;`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS coin TEXT;`;
    await sql/*sql*/`ALTER TABLE miners ADD COLUMN IF NOT EXISTS pool TEXT;`;

    // Logs de estado (para calcular horas online)
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS miner_status_logs (
        id BIGSERIAL PRIMARY KEY,
        miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
        status BOOLEAN NOT NULL,                 -- true=online, false=offline
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source TEXT NOT NULL,
        extra JSONB DEFAULT '{}'::jsonb
      );
    `;
    await sql/*sql*/`CREATE INDEX IF NOT EXISTS idx_msl_miner_time ON miner_status_logs(miner_id, at DESC);`;

    // Cabeçalho da fatura (1 por user/mês)
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS energy_invoices (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        year INT NOT NULL,
        month INT NOT NULL,
        subtotal_eur NUMERIC(12,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ
      );
    `;
    await sql/*sql*/`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_user_month
      ON energy_invoices(user_id, year, month);
    `;

    // Linhas por miner na fatura
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS energy_invoice_items (
        id BIGSERIAL PRIMARY KEY,
        invoice_id BIGINT NOT NULL REFERENCES energy_invoices(id) ON DELETE CASCADE,
        miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
        miner_nome TEXT NOT NULL,
        hours_online NUMERIC(12,3) NOT NULL,
        kwh_used NUMERIC(12,3) NOT NULL,
        preco_kw NUMERIC(12,6) NOT NULL,
        consumo_kw_hora NUMERIC(12,6) NOT NULL,
        amount_eur NUMERIC(12,2) NOT NULL
      );
    `;
    await sql/*sql*/`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_item
      ON energy_invoice_items(invoice_id, miner_id);
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
    console.log("Server is up and running at port", PORT);
  });
});
