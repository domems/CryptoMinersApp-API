// src/controllers/workerController.js
const { getWorkerStatus } = require('../utils/viaBTC');

/**
 * Controlador para responder com o estado do worker.
 * Espera query parameters: accessKey, coin, workerName.
 */
exports.getStatus = async (req, res) => {
  const { accessKey, coin, workerName } = req.query;
  if (!accessKey || !coin || !workerName) {
    return res.status(400).json({ error: 'Parâmetros accessKey, coin e workerName são obrigatórios.' });
  }
  try {
    const status = await getWorkerStatus(accessKey, coin, workerName);
    if (status) {
      return res.json({ status });
    } else {
      return res.status(404).json({ error: 'Worker não encontrado.' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao obter estado.' });
  }
};
