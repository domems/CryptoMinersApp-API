// Usa ES modules; importa puppeteer normalmente
import puppeteer from 'puppeteer';

/**
 * Abre a página do Watcher e devolve o estado de um worker pelo nome.
 * @param {string} watcherCode Código do Watcher (access_key)
 * @param {string} coin Moeda, ex.: 'LTC', 'BTC', etc.
 * @param {string} workerName Nome do worker (linha da tabela) a procurar
 * @returns {Promise<string|null>} Estado do worker ou null se não encontrado
 */
export async function getWorkerStatus(watcherCode, coin, workerName) {
  const url = `https://www.viabtc.com/observer/worker?access_key=${watcherCode}&coin=${coin}`;
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: 
        process.env.NODE_ENV === 'production' 
          ? process.env.PUPPETEER_EXECUTABLE_PATH
          : puppeteer.executablePath(), // usa o browser que o puppeteer descarregou
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote'],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr td:nth-child(1) div', { timeout: 20000 });

    const status = await page.evaluate((targetName) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (const row of rows) {
        const nameCell   = row.querySelector('td:nth-child(1) div');
        const statusCell = row.querySelector('td:nth-child(7) div');
        if (!nameCell || !statusCell) continue;
        const n = nameCell.textContent.trim();
        if (n === targetName) {
          return statusCell.textContent.trim();
        }
      }
      return null;
    }, workerName);

    return status;
  } finally {
    if (browser) await browser.close();
  }
}
