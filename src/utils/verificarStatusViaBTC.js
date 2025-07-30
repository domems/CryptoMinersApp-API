import fetch from "node-fetch";
import { sql } from "../config/db.js";

const verificarStatusViaBTC = async (workerName, apiKey) => {
  const baseURL = `https://www.viabtc.com/api/v1`;

  try {
    const response = await fetch(`${baseURL}/mining/workers`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!Array.isArray(data?.data)) {
      throw new Error("Resposta inesperada da API da ViaBTC");
    }

    const minerData = data.data.find(worker => worker.worker === workerName);

    return minerData?.status === "alive" ? "online" : "offline";
  } catch (err) {
    console.error("Erro ao verificar status na ViaBTC:", err.message);
    return "offline"; // se der erro, assume-se offline
  }
};
