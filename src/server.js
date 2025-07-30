import express from "express";
import dotenv from "dotenv";
import {sql} from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";
import minerRoutes from "./routes/miners.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRouter from "./routes/status.js";

dotenv.config();




const PORT = process.env.PORT || 5001;

const app = express();


//middleware
app.use(rateLimiter);
app.use(express.json());


app.use("/api/clerk", clerkRoutes);
app.use("/api/miners", minerRoutes);
app.use("/api/status", statusRouter);

async function initDB() {
    try {
    await sql`
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
    console.log("Tabela mineradas criada com sucesso.");
  } catch (err) {
    console.error("Erro ao criar tabela:", err);
    process.exit(1);
  }
}

app.get("/", (req,res) => {
    res.send("Its working");
});

console.log("my port:", process.env.PORT);

initDB().then(() => {
    app.listen(PORT, () => {
        console.log("Server is up and running at port", PORT);
    });
})