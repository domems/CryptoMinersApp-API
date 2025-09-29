// src/scripts/initRoles.js
import { sql } from "../config/db.js";

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS role_recipients (
      role    TEXT NOT NULL CHECK (role IN ('admin','support')),
      user_id TEXT NOT NULL,
      PRIMARY KEY (role, user_id)
    );
  `;
  console.log("[initRoles] OK");
  process.exit(0);
}

main().catch((e) => { console.error("[initRoles] ERRO:", e); process.exit(1); });
