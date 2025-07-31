import axios from "axios";
import * as cheerio from "cheerio";

export const obterStatusViaWatcher = async (req, res) => {
  const { workerName, coin, watcherKey } = req.params;

  if (!workerName || !coin || !watcherKey) {
    return res.status(400).json({ error: "Dados incompletos." });
  }

  try {
    const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;
    
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const html = response.data;
    const $ = cheerio.load(html);

    let statusEncontrado = null;

    $("table.el-table__body tbody tr").each((i, el) => {
      const tds = $(el).find("td");
      const nomeWorker = $(tds[0]).text().trim();

      if (nomeWorker === workerName) {
        const status = $(tds[6]).text().trim(); // coluna de status
        statusEncontrado = status;
        return false;
      }
    });

    if (!statusEncontrado) {
      return res.status(404).json({ error: "Worker não encontrado." });
    }

    res.json({ status: statusEncontrado });
  } catch (err) {
    console.error("❌ Erro ao fazer scraping da ViaBTC:", err.message);
    res.status(500).json({ error: "Erro ao obter status da mineradora." });
  }
};
