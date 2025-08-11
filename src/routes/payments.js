import express from "express";
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const router = express.Router();

const SUPPORTED_CURRENCIES = ["USDC", "BTC", "LTC"];
const USDC_NETWORKS = ["ERC20", "BEP20", "SOL"];

/** Mapeia moeda+rede para pay_currency da NOWPayments */
function mapPayCurrency(currency, network) {
  const c = String(currency).toUpperCase();
  const n = String(network || "").toUpperCase();

  if (c === "USDC") {
    if (!USDC_NETWORKS.includes(n)) {
      throw new Error("Rede inválida para USDC");
    }
    if (n === "ERC20") return "USDC";
    if (n === "BEP20") return "USDCBSC"; // confirme no painel se é USDCBSC
    if (n === "SOL") return "USDCSPL";
  }
  if (c === "BTC") return "BTC";
  if (c === "LTC") return "LTC";

  throw new Error("Moeda não suportada");
}

/**
 * POST /api/payments/create-intent
 * body: { invoiceId:number, currency:"USDC"|"BTC"|"LTC", network:"ERC20"|"BEP20"|"SOL"|"NATIVE" }
 */
router.post("/payments/create-intent", async (req, res) => {
  try {
    const { invoiceId, currency, network } = req.body || {};
    if (!invoiceId || !currency) {
      return res.status(400).json({ error: "invoiceId e currency são obrigatórios" });
    }
    const cur = String(currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(cur)) {
      return res.status(400).json({ error: "Moeda inválida" });
    }

    // valida rede conforme moeda
    if (cur === "USDC") {
      if (!USDC_NETWORKS.includes(String(network).toUpperCase())) {
        return res.status(400).json({ error: "Rede inválida para USDC" });
      }
    } else {
      // BTC/LTC ignoram network (nativo)
    }

    const [inv] = await sql/*sql*/`
      SELECT id, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const price_amount = Number(inv.subtotal_amount);
    const pay_currency = mapPayCurrency(cur, network);

    // Criação do pagamento na NOWPayments
    const nowRes = await fetch("https://api.nowpayments.io/v1/payment", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount,
        price_currency: "USD",
        pay_currency,
        order_id: `invoice_${invoiceId}`,
        order_description: `Energia #${invoiceId}`,
      }),
    });

    if (!nowRes.ok) {
      const errTxt = await nowRes.text();
      console.error("NOWPayments error:", errTxt);
      return res.status(502).json({ error: "Erro na criação do pagamento" });
    }
    const np = await nowRes.json();

    // Guarda/atualiza intent e devolve o id
    const rows = await sql/*sql*/`
      INSERT INTO payment_intents (invoice_id, currency, network, provider_currency, amount_fiat, amount_crypto, payment_address, status, pay_url)
      VALUES (
        ${invoiceId},
        ${cur},
        ${cur === "USDC" ? String(network).toUpperCase() : "NATIVE"},
        ${pay_currency},
        ${price_amount},
        ${Number(np.pay_amount || 0)},
        ${np.pay_address || null},
        'pending',
        ${np.invoice_url || null}
      )
      ON CONFLICT (invoice_id) DO UPDATE SET
        currency = EXCLUDED.currency,
        network = EXCLUDED.network,
        provider_currency = EXCLUDED.provider_currency,
        amount_fiat = EXCLUDED.amount_fiat,
        amount_crypto = EXCLUDED.amount_crypto,
        payment_address = EXCLUDED.payment_address,
        status = 'pending',
        pay_url = EXCLUDED.pay_url,
        updated_at = NOW()
      RETURNING id, invoice_id, currency, network, provider_currency, amount_fiat, amount_crypto, payment_address, status, pay_url, created_at, updated_at
    `;
    const intent = rows[0];

    // fatura passa a "aguarda_pagamento"
    await sql/*sql*/`
      UPDATE energy_invoices SET status = 'aguarda_pagamento' WHERE id = ${invoiceId}
    `;

    res.json({ ok: true, intent });
  } catch (err) {
    console.error("POST /payments/create-intent:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * GET /api/payments/:id
 * devolve o intent (para o polling do app)
 */
router.get("/payments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });

    const rows = await sql/*sql*/`
      SELECT id, invoice_id, currency, network, provider_currency, amount_fiat, amount_crypto, payment_address, status, pay_url, created_at, updated_at
      FROM payment_intents
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Intent não encontrado" });

    res.json({ ok: true, intent: rows[0] });
  } catch (err) {
    console.error("GET /payments/:id:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * Webhook NOWPayments
 */
router.post("/payments/webhook", express.json(), async (req, res) => {
  try {
    const payload = req.body;
    const paymentStatus = String(payload.payment_status || "").toLowerCase();
    const orderId = String(payload.order_id || "");

    if (!orderId.startsWith("invoice_")) {
      return res.status(400).json({ error: "Order ID inválido" });
    }
    const invoiceId = Number(orderId.replace("invoice_", ""));
    if (!invoiceId) return res.status(400).json({ error: "Invoice ID inválido" });

    if (paymentStatus === "finished") {
      await sql/*sql*/`
        UPDATE payment_intents
        SET status = 'confirmed', txid = ${payload.payment_id || null}, updated_at = NOW()
        WHERE invoice_id = ${invoiceId}
      `;
      await sql/*sql*/`
        UPDATE energy_invoices
        SET status = 'pago'
        WHERE id = ${invoiceId}
      `;
    } else if (paymentStatus === "expired" || paymentStatus === "failed") {
      await sql/*sql*/`
        UPDATE payment_intents
        SET status = 'expired', updated_at = NOW()
        WHERE invoice_id = ${invoiceId}
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook NOWPayments:", err);
    res.status(500).json({ error: "Erro no processamento do webhook" });
  }
});

export default router;
