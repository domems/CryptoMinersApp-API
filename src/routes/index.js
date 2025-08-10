import express from "express";
import { getMinerStatus } from "../controllers/statusController.js";
import { listInvoices, listInvoiceItems, recalcInvoices } from "../controllers/invoicesController.js";

const router = express.Router();

// status das miners
router.get("/miners/:minerId/status", getMinerStatus);

// faturação
router.get("/invoices", listInvoices);
router.get("/invoices/:id/items", listInvoiceItems);
router.post("/invoices/recalc", recalcInvoices);

export default router;
