import axios from "axios";
import cheerio from "cheerio";

export const obterStatusViaWatcher = async (req, res) => {
  const { workerName, coin, watcherKey } = req.params;

  if (!workerName || !coin || !watcherKey) {
    return res.status(400).json({ error: "Parâmetros em falta." });
  }

  const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;

  try {
    console.log("🌐 Scraping URL:", url);

    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0", // Evita bloqueios por bot detection
      },
    });

    const $ = cheerio.load(html);

    // Encontrar a linha com o nome do worker
    const workerRow = $(`.ant-table-row`).filter((_, el) => {
      return $(el).text().includes(workerName);
    });

    if (workerRow.length === 0) {
      return res.json({ status: "Desconhecido" });
    }

    // Exemplo: a 4ª célula da linha tem o status
    const statusCell = workerRow.find("td").eq(3);
    const status = statusCell.text().trim();

    console.log("✅ Status encontrado:", status);

    return res.json({ status: status || "Desconhecido" });
  } catch (err) {
    console.error("❌ Erro ao fazer scraping:", err.message);
    return res.status(500).json({ error: "Erro ao obter status via scraping." });
  }
};
