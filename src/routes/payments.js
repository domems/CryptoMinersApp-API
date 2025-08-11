import express from "express";
import { sql } from "../config/db.js";
import fetch from "node-fetch";

const router = express.Router();

// apenas USDC com redes ERC20, TRC20, SPL
const NETWORKS = ["ERC20", "TRC20", "SPL"];

// mapeia moeda + rede para código NOWPayments
function mapCurrency(currency, network) {
  const net = String(network || "").toUpperCase();
  if (currency === "USDC") {
    if (net === "TRC20") return "USDCTRC20";
    if (net === "SPL" || net === "SOL" || net === "SOLANA") return "USDCSPL";
    return "USDC"; // ERC20 por default
  }
  throw new Error("Moeda não suportada");
}

// criar intent de pagamento
router.post("/payments/create-intent", async (req, res) => {
  try {
    const { invoiceId, currency, network } = req.body;
    if (!invoiceId || !currency) {
      return res.status(400).json({ error: "invoiceId e currency são obrigatórios" });
    }
    if (currency !== "USDC") {
      return res.status(400).json({ error: "Apenas USDC é suportado" });
    }
    if (!NETWORKS.includes(String(network || "").toUpperCase())) {
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
    const price_currency = "USD"; // sempre USD
    const provider_currency = mapCurrency(currency, network);

    // chamada para NOWPayments
    const nowRes = await fetch("https://api.nowpayments.io/v1/payment", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount,
        price_currency,
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

    // opcional: guardar no DB se quiseres histórico
    await sql`
      INSERT INTO payment_intents(invoice_id, currency, network, amount_fiat, amount_crypto, payment_address, status)
      VALUES (${invoiceId}, ${currency}, ${network}, ${price_amount}, ${nowData.pay_amount}, ${nowData.pay_address}, 'pending')
    `;

    res.json({ ok: true, intent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

export default router;
