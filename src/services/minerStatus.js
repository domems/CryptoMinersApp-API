import fetch from "node-fetch";

// devolve boolean: se a miner está online
export async function isMinerOnline(miner) {
  const { api_key, coin, pool, worker_name } = miner;

  if (pool === "ViaBTC") {
    const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
    const resp = await fetch(url, { headers: { "X-API-KEY": api_key } });
    const data = await resp.json();
    if (!data || data.code !== 0) return false;

    const workers = data.data?.data || [];
    const my = workers.find((w) => w.worker_name === worker_name);
    return !!my && my.worker_status === "active"; // ajusta se necessário
  }

  if (pool === "LiteCoinPool") {
    const url = `https://www.litecoinpool.org/api?api_key=${api_key}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data || !data.workers) return false;

    const info = data.workers?.[worker_name];
    return !!info && !!info.connected; // online se connected === true
  }

  return false;
}
