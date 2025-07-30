import fetch from "node-fetch";
import * as cheerio from "cheerio";

export const obterStatusViaWatcher = async (req, res) => {
  const { watcherKey, workerName } = req.params;
  const coin = req.query.coin || "LTC";

  console.log("🌐 Verificando status do worker...");
  console.log("🔑 Watcher Key:", watcherKey);
  console.log("👷 Worker Name:", workerName);
  console.log("🪙 Coin:", coin);

  try {
    const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;
    console.log("🔗 URL ViaBTC:", url);

    const response = await fetch(url);
    const html = await response.text();

    const $ = cheerio.load(html);
    let status = null;

    $("table tbody tr").each((_, el) => {
      const nome = $(el).find("td").eq(0).text().trim().toLowerCase();
      const estado = $(el).find("td").eq(6).text().trim();

      console.log("🔍 Encontrado na tabela:", nome, "| Status:", estado);

      if (nome === workerName.trim().toLowerCase()) {
        status = estado;
      }
    });

    if (!status) {
      console.warn("⚠️ Worker não encontrado.");
      return res.status(404).json({ status: "Desconhecido" });
    }

    console.log("✅ Status encontrado:", status);
    return res.json({ status });
  } catch (err) {
    console.error("❌ Erro ao verificar status:", err);
    res.status(500).json({ error: "Erro ao obter status do worker." });
  }
};
