import puppeteer from "puppeteer";

export const obterStatusViaWatcher = async (req, res) => {
  const { watcherKey, workerName } = req.params;
  const coin = req.query.coin || "LTC";

  console.log("🌐 Iniciando Puppeteer...");
  console.log("🔑 Watcher Key:", watcherKey);
  console.log("👷 Worker Name:", workerName);
  console.log("🪙 Coin:", coin);

  const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;
  console.log("🔗 Acessando URL:", url);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  const result = await page.evaluate(({ workerName }) => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    for (const row of rows) {
      const tds = row.querySelectorAll("td");
      const nome = tds[0]?.textContent?.trim().toLowerCase();
      const estado = tds[6]?.textContent?.trim();
      console.log("🧾 Encontrado:", nome, estado);
      if (nome === workerName.trim().toLowerCase()) {
        return estado;
      }
    }
    return null;
  }, { workerName });

  await browser.close();

  if (!result) {
    console.warn("⚠️ Worker não encontrado.");
    return res.status(404).json({ status: "Desconhecido" });
  }

  console.log("✅ Status encontrado:", result);
  return res.json({ status: result });
};
