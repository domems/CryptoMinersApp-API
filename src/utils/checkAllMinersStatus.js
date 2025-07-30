import { sql } from "../config/db.js";
import verificarStatusViaBTC from "./verificarStatusViaBTC.js";

export const verificarTodosStatus = async () => {
  try {
    const miners = await sql`
      SELECT id, worker_name, api_key, pool_name
      FROM miners
      WHERE worker_name IS NOT NULL AND api_key IS NOT NULL AND pool_name = 'viabtc';
    `;

    for (const miner of miners) {
      const status = await verificarStatusViaBTC(miner.worker_name, miner.api_key);

      await sql`
        UPDATE miners SET status = ${status} WHERE id = ${miner.id};
      `;

      console.log(`Mineradora ${miner.id} atualizada para ${status}`);
    }

  } catch (err) {
    console.error("Erro ao verificar todos os status:", err.message);
  }
};
