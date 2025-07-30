import fetch from "node-fetch";
import * as cheerio from "cheerio";

export const obterStatusViaWatcher = async (req, res) => {
  const { watcherKey, workerName } = req.params;
  const coin = req.query.coin || "LTC";

  try {
    const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;
    const response = await fetch(url);
    const html = await response.text();

    const $ = cheerio.load(html);
    let status = null;

    $("table tbody tr").each((_, el) => {
      const nome = $(el).find("td").eq(0).text().trim();
      const estado = $(el).find("td").eq(6).text().trim(); // 7ª coluna = Status

      if (nome === workerName) {
        status = estado;
      }
    });

    if (!status) {
      return res.status(404).json({ status: "Desconhecido" });
    }

    return res.json({ status });
  } catch (err) {
    console.error("Erro ao verificar status:", err);
    res.status(500).json({ error: "Erro ao obter status do worker." });
  }
};
