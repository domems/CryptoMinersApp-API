import express from "express";
import { pollUptimeOnce } from "../services/pollGrouped.js";
import { runInvoices } from "../services/runInvoices.js";

const router = express.Router();

// Chama isto a cada 5 min (ou 1-2 min se precisares + precisão)
router.post("/poll-uptime", async (_req, res) => {
  await pollUptimeOnce();
  res.json({ ok: true });
});

// Fecha faturas. Se não passares year/month, usa mês anterior automaticamente.
router.post("/invoices/run", async (req, res) => {
  const { year, month } = req.body || {};
  await runInvoices({ year, month });
  res.json({ ok: true });
});

export default router;
