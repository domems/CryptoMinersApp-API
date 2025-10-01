// jobs/index.js (ESM)

const startedState = { started: false, stops: [] };

/** Parse simples de listas em env (JOBS_ONLY, JOBS_SKIP) */
function parseList(envVar) {
  return new Set(
    String(process.env[envVar] || "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.toLowerCase())
  );
}

const ONLY = parseList("JOBS_ONLY"); // ex: "viabtc,binance"
const SKIP = parseList("JOBS_SKIP"); // ex: "f2pool"

/** Decide se um job está ativo via env flags */
function enabled(name) {
  const key = name.toLowerCase();
  if (ONLY.size) return ONLY.has(key);
  return !SKIP.has(key);
}

/** Import dinâmico seguro que não rebenta se o ficheiro não existir */
async function tryImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.warn(`[jobs] ficheiro opcional ausente ou erro ao importar: ${path} -> ${err?.message || err}`);
    return null;
  }
}

/**
 * Regista e executa o start do job.
 * - Aceita startFns que devolvem um stop() opcional.
 * - Isola crash por job.
 */
async function bootJob({ name, path, startExport }) {
  if (!enabled(name)) {
    console.log(`[jobs] ${name}: ignorado (desativado por flags).`);
    return;
  }

  const mod = await tryImport(path);
  if (!mod || typeof mod[startExport] !== "function") {
    console.warn(`[jobs] ${name}: start "${startExport}" não encontrado em ${path}.`);
    return;
  }

  try {
    const stop = await Promise.resolve(mod[startExport]());
    if (typeof stop === "function") {
      startedState.stops.push({ name, stop });
    }
    console.log(`[jobs] ${name}: iniciado.`);
  } catch (err) {
    console.error(`[jobs] ${name}: falhou ao iniciar -> ${err?.stack || err}`);
  }
}

/** Tabela de jobs suportados (fácil adicionar/remover) */
const JOBS = [
  { name: "viabtc",       path: "./uptimeViaBTC.js",       startExport: "startUptimeViaBTC" },
  { name: "litecoinpool", path: "./uptimeLiteCoinPool.js", startExport: "startUptimeLTCPool" },
  { name: "binance",      path: "./uptimeBinance.js",      startExport: "startUptimeBinance" },
  { name: "f2pool",       path: "./uptimeF2Pool.js",       startExport: "startUptimeF2Pool" },
  { name: "miningdutch",  path: "./uptimeMiningDutch.js",  startExport: "startUptimeMiningDutch" },
  // opcionais
  { name: "monthlyclose", path: "./monthlyClose.js",       startExport: "startMonthlyClose" },
  { name: "detectstate",  path: "./detectState.js",        startExport: "startDetectState" },        // se existir
  { name: "deliverpush",  path: "./deliverPush.js",        startExport: "startDeliverPush" },        // se existir
  { name: "deliverinapp", path: "./deliverInapp.js",       startExport: "startDeliverInapp" },       // se existir
  { name: "offlineremind",path: "./offlineReminder.js",    startExport: "startOfflineReminder" },    // se existir
];

/**
 * Inicia todos os jobs (idempotente).
 * Env flags úteis:
 *   JOBS_ONLY: lista de nomes para executar (ex: "viabtc,binance")
 *   JOBS_SKIP: lista de nomes para saltar (ex: "f2pool")
 */
export async function startAllJobs() {
  if (startedState.started) {
    console.log("[jobs] já iniciado – a ignorar nova chamada.");
    return;
  }
  startedState.started = true;

  console.log("[jobs] a iniciar…");
  await Promise.all(JOBS.map(bootJob));
  console.log("[jobs] done.");
}

/** Para todos os jobs que expuseram stop() */
export async function stopAllJobs() {
  const stops = startedState.stops.splice(0);
  for (const { name, stop } of stops) {
    try {
      await Promise.resolve(stop());
      console.log(`[jobs] ${name}: parado.`);
    } catch (err) {
      console.error(`[jobs] ${name}: erro ao parar -> ${err?.stack || err}`);
    }
  }
  startedState.started = false;
}

/* Opcional: parar graciosamente em SIGTERM/SIGINT */
if (process.env.JOBS_HANDLE_SIGNALS === "1") {
  const shutdown = async (sig) => {
    console.log(`[jobs] sinal ${sig} recebido – a parar jobs…`);
    await stopAllJobs();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}
