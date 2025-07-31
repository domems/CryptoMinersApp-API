import crypto from "crypto";
import axios from "axios";

function gerarAssinatura(secretKey, params) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secretKey).update(paramString).digest("hex");
}

export const obterStatusViaBTC = async (req, res) => {
  const { workerName, coin, apiKey, secretKey } = req.params;

  if (!apiKey || !secretKey || !coin || !workerName) {
    return res.status(400).json({ error: "Dados incompletos." });
  }

  try {
    const tonce = Date.now();

    const params = {
      access_key: apiKey,
      coin: coin.toLowerCase(),
      worker: workerName,
      tonce,
    };

    const signature = gerarAssinatura(secretKey, params);

    const config = {
      headers: {
        "Content-Type": "application/json",
      },
    };

    const body = {
      ...params,
      signature,
    };

    const { data } = await axios.post("https://www.viabtc.com/api/v1/private/worker/status", body, config);

    const status = data?.data?.status || "Desconhecido";

    res.json({ status });
  } catch (err) {
    console.error("❌ Erro ao consultar API ViaBTC:", err?.response?.data || err.message);
    res.status(500).json({ error: "Erro ao obter status da mineradora." });
  }
};
