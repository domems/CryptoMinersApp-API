// src/routes/payments.js
import express from "express";
import { sql } from "../config/db.js";
import fetch from "node-fetch";
import crypto from "crypto";

const router = express.Router();

const NOW_API = "https://api.nowpayments.io/v1";

function mapCurrency(ui) {
  // USDT por TRC20 (podes trocar para USDTERC20)
  if (ui === "USDT") return "USDTTRC20";
  if (ui === "BTC") return "BTC";
  return "LTC";
}

async function nowCreatePayment({ price_amount, price_currency, pay_currency, order_id, ipn_callback_url }) {
  const res = await fetch(`${NOW_API}/payment`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ price_amount, price_currency, pay_currency, order_id, ipn_callback_url }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`NOWPayments ${res.status}: ${t}`);
  }
  return res.json();
}

function verifyNowSig(rawBody, headerSig, secret) {
  const h = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return h.toLowerCase() === String(headerSig || "").toLowerCase();
}

/**
 * POST /api/payments/create-intent
 * body: { invoiceId: number, currency: "USDT" | "BTC" | "LTC" }
 */
router.post("/payments/create-intent", async (req, res) => {
  try {
    const { invoiceId, currency } = req.body || {};
    if (!invoiceId || !currency) {
      return res.status(400).json({ ok: false, error: "invoiceId e currency são obrigatórios" });
    }

    // Carrega fatura
    const [inv] = await sql/*sql*/`
      SELECT id, user_id, subtotal_amount, status, COALESCE(currency_code,'EUR') AS currency_code
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ ok: false, error: "Fatura não encontrada" });
    if (!["pendente", "aguarda_pagamento"].includes(inv.status)) {
      return res.status(400).json({ ok: false, error: "Estado da fatura não permite pagamento" });
    }

    const price_amount = Number(inv.subtotal_amount);
    const price_currency = String(inv.currency_code || "EUR").toUpperCase(); // "EUR" ou "USD"
    const provider_currency = mapCurrency(currency);
    const order_id = `invoice-${invoiceId}-${Date.now()}`;
    const ipn_callback_url = `${process.env.APP_BASE_URL}/api/payments/webhook/nowpayments`;

    const resp = await nowCreatePayment({
      price_amount,
      price_currency,
      pay_currency: provider_currency,
      order_id,
      ipn_callback_url,
    });
    // resp: { payment_id, pay_address, pay_amount, pay_currency, invoice_url, payment_status, ... }

    const upsert = await sql/*sql*/`
      INSERT INTO payment_intents
        (invoice_id, provider, currency, provider_currency, amount_fiat, amount_crypto,
         payment_address, pay_url, provider_invoice_id, status)
      VALUES
        (${invoiceId}, 'nowpayments', ${currency}, ${provider_currency}, ${price_amount},
         ${resp.pay_amount || null}, ${resp.pay_address || null}, ${resp.invoice_url || null},
         ${String(resp.payment_id)}, 'pending')
      ON CONFLICT (invoice_id) DO UPDATE SET
        currency = EXCLUDED.currency,
        provider_currency = EXCLUDED.provider_currency,
        amount_fiat = EXCLUDED.amount_fiat,
        amount_crypto = EXCLUDED.amount_crypto,
        payment_address = EXCLUDED.payment_address,
        pay_url = EXCLUDED.pay_url,
        provider_invoice_id = EXCLUDED.provider_invoice_id,
        status = 'pending',
        updated_at = now()
      RETURNING *
    `;

    await sql/*sql*/`UPDATE energy_invoices SET status = 'aguarda_pagamento' WHERE id = ${invoiceId}`;

    res.json({ ok: true, intent: upsert[0] });
  } catch (e) {
    console.error("POST /payments/create-intent:", e);
    res.status(500).json({ ok: false, error: "Erro ao criar intent de pagamento" });
  }
});

/**
 * GET /api/payments/:id
 * (para polling do app)
 */
router.get("/payments/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "id inválido" });
  const rows = await sql/*sql*/`SELECT * FROM payment_intents WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return res.status(404).json({ ok: false, error: "Intent não encontrada" });
  res.json({ ok: true, intent: rows[0] });
});

/**
 * Webhook NOWPayments (IPN)
 * POST /api/payments/webhook/nowpayments
 */
router.post("/payments/webhook/nowpayments", async (req, res) => {
  try {
    const rawBody = req.rawBody?.toString() || JSON.stringify(req.body);
    const sig = req.header("x-nowpayments-sig");
    const ok = verifyNowSig(rawBody, sig, process.env.NOWPAYMENTS_IPN_SECRET);
    if (!ok) return res.status(401).end();

    const payload = JSON.parse(rawBody);
    const providerPaymentId = String(payload.payment_id);
    const statusStr = String(payload.payment_status || "").toLowerCase();

    let newStatus = "pending";
    if (statusStr === "finished" || statusStr === "confirmed") newStatus = "confirmed";
    else if (statusStr === "expired") newStatus = "expired";
    else if (["failed", "refunded", "chargeback"].includes(statusStr)) newStatus = "canceled";

    const rows = await sql/*sql*/`
      SELECT * FROM payment_intents
      WHERE provider='nowpayments' AND provider_invoice_id = ${providerPaymentId}
      LIMIT 1
    `;
    if (rows.length === 0) return res.status(200).end(); // idempotente

    const intent = rows[0];

    await sql/*sql*/`
      UPDATE payment_intents
      SET status = ${newStatus}, updated_at = now()
      WHERE id = ${intent.id}
    `;

    if (newStatus === "confirmed") {
      await sql/*sql*/`
        UPDATE energy_invoices
        SET status = 'pago', updated_at = now()
        WHERE id = ${intent.invoice_id}
      `;
    }

    return res.status(200).end();
  } catch (e) {
    console.error("NOWPayments webhook error:", e);
    return res.status(500).end();
  }
});

/**
 * (Opcional) GET /api/payments/status?invoiceId=...
 * Mantive por compatibilidade
 */
router.get("/payments/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT id, user_id, subtotal_amount, status, COALESCE(currency_code,'EUR') AS currency_code
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const [intent] = await sql/*sql*/`
      SELECT * FROM payment_intents WHERE invoice_id = ${invoiceId} LIMIT 1
    `;

    res.json({ ok: true, invoice: inv, intent: intent || null });
  } catch (e) {
    console.error("GET /payments/status:", e);
    res.status(500).json({ error: "Erro ao consultar estado de pagamento" });
  }
});

export default router;
