import express from "express";
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const router = express.Router();
const NETWORKS = ["ERC20", "TRC20", "SPL"];

function mapCurrency(currency, network) {
  const net = String(network || "").toUpperCase();
  if (currency === "USDC") {
    if (net === "TRC20") return "USDCTRC20";
    if (net === "SPL" || net === "SOL" || net === "SOLANA") return "USDCSPL";
    return "USDC"; // ERC20 por default
  }
  throw new Error("Moeda não suportada");
}

// Criar intent de pagamento
router.post("/payments/create-intent", async (req, res) => {
  try {
    const { invoiceId, currency, network } = req.body;
    if (!invoiceId || !currency || !network) {
      return res.status(400).json({ error: "Parâmetros obrigatórios" });
    }
    if (currency !== "USDC") {
      return res.status(400).json({ error: "Apenas USDC suportado" });
    }
    if (!NETWORKS.includes(network.toUpperCase())) {
      return res.status(400).json({ error: "Rede inválida" });
    }

    const [inv] = await sql`
      SELECT id, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const price_amount = Number(inv.subtotal_amount);
    const provider_currency = mapCurrency(currency, network);

    const nowRes = await fetch("https://api.nowpayments.io/v1/payment", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount,
        price_currency: "USD",
        pay_currency: provider_currency,
        order_id: `invoice_${invoiceId}`,
        order_description: `Fatura energia #${invoiceId}`,
      }),
    });

    if (!nowRes.ok) {
      const errTxt = await nowRes.text();
      console.error("NOWPayments error:", errTxt);
      return res.status(502).json({ error: "Erro na criação do pagamento" });
    }

    const nowData = await nowRes.json();
    const intent = {
      id: null,
      invoice_id: invoiceId,
      currency,
      amount_fiat: price_amount,
      amount_crypto: nowData.pay_amount,
      payment_address: nowData.pay_address,
      network,
      status: "pending",
    };

    await sql`
      INSERT INTO payment_intents(invoice_id, currency, network, amount_fiat, amount_crypto, payment_address, status)
      VALUES (${invoiceId}, ${currency}, ${network}, ${price_amount}, ${nowData.pay_amount}, ${nowData.pay_address}, 'pending')
      ON CONFLICT (invoice_id) DO UPDATE SET
        currency = EXCLUDED.currency,
        network = EXCLUDED.network,
        amount_fiat = EXCLUDED.amount_fiat,
        amount_crypto = EXCLUDED.amount_crypto,
        payment_address = EXCLUDED.payment_address,
        status = 'pending',
        updated_at = NOW()
    `;

    // Atualiza fatura para "aguarda_pagamento"
    await sql`
      UPDATE energy_invoices
      SET status = 'aguarda_pagamento'
      WHERE id = ${invoiceId}
    `;

    res.json({ ok: true, intent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Webhook do NOWPayments
router.post("/payments/webhook", express.json(), async (req, res) => {
  try {
    const payload = req.body;
    console.log("NOWPayments webhook recebido:", payload);

    // Segurança: valida assinatura se ativada no painel NOWPayments
    const paymentStatus = String(payload.payment_status || "").toLowerCase();
    const orderId = String(payload.order_id || "");

    if (!orderId.startsWith("invoice_")) {
      return res.status(400).json({ error: "Order ID inválido" });
    }

    const invoiceId = Number(orderId.replace("invoice_", ""));
    if (!invoiceId) {
      return res.status(400).json({ error: "Invoice ID inválido" });
    }

    if (paymentStatus === "finished") {
      // Marca pagamento como confirmado
      await sql`
        UPDATE payment_intents
        SET status = 'confirmed', txid = ${payload.payment_id || null}, updated_at = NOW()
        WHERE invoice_id = ${invoiceId}
      `;
      await sql`
        UPDATE energy_invoices
        SET status = 'pago'
        WHERE id = ${invoiceId}
      `;
      console.log(`✅ Fatura ${invoiceId} marcada como paga`);
    } else if (paymentStatus === "expired" || paymentStatus === "failed") {
      await sql`
        UPDATE payment_intents
        SET status = 'expired', updated_at = NOW()
        WHERE invoice_id = ${invoiceId}
      `;
      console.log(`⚠️ Pagamento da fatura ${invoiceId} expirou ou falhou`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.status(500).json({ error: "Erro no processamento do webhook" });
  }
});

export default router;
