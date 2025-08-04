// src/utils/viaBTC.js
const puppeteer = require('puppeteer');

/**
 * Obtém o estado de um worker na ViaBTC pelo nome.
 * @param {string} accessKey Chave de acesso do Watcher
 * @param {string} coin Ex.: 'LTC', 'BTC', ...
 * @param {string} workerName Nome do worker a procurar
 * @returns {Promise<string|null>} Estado do worker ou null se não encontrado
 */
async function getWorkerStatus(accessKey, coin, workerName) {
  const url = `https://www.viabtc.com/observer/worker?access_key=${accessKey}&coin=${coin}`;
  let browser;

  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr td:nth-child(1) div', { timeout: 20000 });

    const result = await page.evaluate((name) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (const row of rows) {
        const nameCell   = row.querySelector('td:nth-child(1) div');
        const statusCell = row.querySelector('td:nth-child(7) div');
        if (!nameCell || !statusCell) continue;
        const n  = nameCell.textContent.trim();
        const st = statusCell.textContent.trim();
        if (n === name) {
          return st;
        }
      }
      return null;
    }, workerName);

    return result;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { getWorkerStatus };
