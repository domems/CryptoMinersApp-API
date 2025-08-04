const { getWorkerStatus } = require('../utils/viaBTC');

exports.getStatus = async (req, res) => {
  const { workerName, coin, watcherCode } = req.params;
  try {
    const status = await getWorkerStatus(watcherCode, coin, workerName);
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
