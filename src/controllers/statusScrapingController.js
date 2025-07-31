export const obterStatusViaWatcher = async (req, res) => {
  const { workerName, coin, watcherKey } = req.params;

  if (!workerName || !coin || !watcherKey) {
    return res.status(400).json({ error: "Parâmetros em falta." });
  }

  const url = `https://www.viabtc.com/observer/worker?access_key=${watcherKey}&coin=${coin}`;

  try {
    const { data } = await axios.get(url);

    // DEBUG: Enviar o HTML da página (temporário)
    return res.send(data); // <-- coloca isto só para verificar

  } catch (err) {
    console.error("Erro ao aceder à página da ViaBTC:", err.message);
    return res.status(500).json({ error: "Erro ao aceder à página da ViaBTC." });
  }
};
