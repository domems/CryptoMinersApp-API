import axios from "axios";
import * as cheerio from "cheerio";

export const obterStatusViaWatcher = async (req, res) => {
  const { key, worker } = req.params;

  const url = `https://www.viabtc.com/observer/worker?access_key=${key}&coin=LTC`;

  console.log("🔗 URL ScrapingBee:", url);
  console.log("👷 Worker:", worker);

  try {
    const { data: html } = await axios.get("https://app.scrapingbee.com/api/v1", {
      params: {
        api_key: "AQUI_VAI_A_TUA_API_KEY", // substitui pela tua
        url,
        render_js: false,
      },
    });

    const $ = cheerio.load(html);

    let status = "Desconhecido";

    $("table tr").each((i, el) => {
      const nome = $(el).find("td").eq(0).text().trim();
      const estado = $(el).find("td").eq(6).text().trim();

      if (nome === worker) {
        status = estado;
      }
    });

    console.log("✅ Status encontrado:", status);
    res.json({ status });
  } catch (err) {
    console.error("❌ Erro ao fazer scraping:", err.message);
    res.status(500).json({ error: "Erro ao verificar status" });
  }
};
