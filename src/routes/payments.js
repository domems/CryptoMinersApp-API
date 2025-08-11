// src/routes/payments.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { sql } from "../config/db.js";

const router = express.Router();

const NOW_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOW_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET; // opcional (verificação HMAC)
const NOW_IPN_URL = process.env.NOWPAYMENTS_WEBHOOK_URL;   // ex: https://teu-backend.com/api/payments/webhook
const NOW_API = "https://api.nowpayments.io/v1";

const SUPPORTED_CURRENCIES = ["USDC", "BTC", "LTC"];
const USDC_NETWORKS = ["ERC20", "BEP20"]; // sem SOL neste fluxo

/* =========================
   Utilitários Provider
========================= */

// Robust parser: garante que devolve sempre um ARRAY de strings ou lança erro legível
async function getNowCurrencies() {
  const r = await fetch(`${NOW_API}/currencies`, {
    headers: { "x-api-key": NOW_API_KEY },
  });

  const raw = await r.text(); // lê como texto primeiro
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  if (!r.ok) {
    throw new Error(`NOWPayments /currencies falhou: HTTP ${r.status} ${raw}`);
  }

  // Normaliza para array
  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && Array.isArray(data.currencies)) {
    list = data.currencies;
  } else if (data && Array.isArray(data.supported_currencies)) {
    list = data.supported_currencies;
  } else {
    throw new Error(
      `NOWPayments /currencies formato inesperado: ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  // sanity check
  if (!Array.isArray(list)) {
    throw new Error("NOWPayments /currencies não devolveu uma lista de moedas.");
  }
  return list.map((s) => String(s).toUpperCase());
}

// Mapeia moeda+rede → pay_currency do NOWPayments
async function mapPayCurrency(currency, network) {
  const c = String(currency).toUpperCase();
  const n = String(network || "").toUpperCase();
  const list = await getNowCurrencies(); // array robusto

  if (c === "USDC") {
    if (!USDC_NETWORKS.includes(n)) throw new Error("Rede inválida para USDC");
    if (n === "ERC20") {
      if (!list.includes("USDC")) throw new Error("USDC (ERC20) indisponível no PSP");
      return "USDC";
    }
    if (n === "BEP20") {
      // NOWPayments usa "USDCBSC" para BEP-20
      if (!list.includes("USDCBSC")) throw new Error("USDC (BEP20) indisponível no PSP");
      return "USDCBSC";
    }
  }

  if (c === "BTC") {
    if (!list.includes("BTC")) throw new Error("BTC indisponível no PSP");
    return "BTC";
  }
  if (c === "LTC") {
    if (!list.includes("LTC")) throw new Error("LTC indisponível no PSP");
    return "LTC";
  }

  throw new Error("Moeda não suportada");
}

// (Opcional) verificação HMAC do IPN
function verifyNowSig(reqBody, headerSig, secret) {
  if (!secret) return true;
  if (!headerSig) return false;
  const raw = JSON.stringify(reqBody);
  const check = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  return String(headerSig).toLowerCase() === check.toLowerCase();
}

/* =========================
   Rotas
========================= */

/**
 * POST /api/payments/create-intent
 * body: { invoiceId:number, currency:"USDC"|"BTC"|"LTC", network:"ERC20"|"BEP20"|"NATIVE" }
 * -> cria pagamento no NOWPayments e guarda na energy_invoices
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

    // Rede por moeda
    let net = String(network || "").toUpperCase();
    if (cur === "USDC") {
      if (!USDC_NETWORKS.includes(net)) {
        return res.status(400).json({ error: "Rede inválida para USDC" });
      }
    } else {
      net = "NATIVE"; // BTC/LTC rede base
    }

    // Lê a fatura
    const [inv] = await sql/*sql*/`
      SELECT id, subtotal_amount, status
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const price_amount = Number(inv.subtotal_amount);

    // Resolve pay_currency (robusto)
    const pay_currency = await mapPayCurrency(cur, net);

    // Cria pagamento no NOWPayments
    const payload = {
      price_amount,
      price_currency: "USD",
      pay_currency,
      order_id: `invoice_${invoiceId}`,
      order_description: `Energia #${invoiceId}`,
      ...(NOW_IPN_URL ? { ipn_callback_url: NOW_IPN_URL } : {}),
    };

    const npRes = await fetch(`${NOW_API}/payment`, {
      method: "POST",
      headers: {
        "x-api-key": NOW_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await npRes.text();
    let np;
    try {
      np = JSON.parse(raw);
    } catch {
      np = raw;
    }

    if (!npRes.ok || !np?.payment_id) {
      console.error("NOWPayments error:", raw);
      return res.status(502).json({ error: "Erro na criação do pagamento", provider: np });
    }

    // Guarda diretamente na energy_invoices
    await sql/*sql*/`
      UPDATE energy_invoices
      SET status               = 'aguarda_pagamento',
          provider_payment_id  = ${Number(np.payment_id)},
          provider_currency    = ${pay_currency},
          pay_network          = ${net},
          pay_address          = ${np.pay_address || null},
          pay_amount           = ${np.pay_amount || null},
          pay_url              = ${np.invoice_url || null},
          updated_at           = NOW()
      WHERE id = ${invoiceId}
    `;

    res.json({
      ok: true,
      intent: {
        invoice_id: invoiceId,
        currency: cur,
        network: net,
        provider_currency: pay_currency,
        amount_fiat: price_amount,
        amount_crypto: np.pay_amount || null,
        payment_address: np.pay_address || null,
        pay_url: np.invoice_url || null,
        status: "pending",
      },
    });
  } catch (err) {
    console.error("POST /payments/create-intent:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/**
 * GET /api/payments/intent?invoiceId=123
 */
router.get("/payments/intent", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT id, status, provider_payment_id, provider_currency, pay_network, pay_address, pay_amount, pay_url, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    res.json({
      ok: true,
      intent: {
        invoice_id: inv.id,
        status: inv.status,
        provider_payment_id: inv.provider_payment_id,
        provider_currency: inv.provider_currency,
        network: inv.pay_network,
        payment_address: inv.pay_address,
        amount_crypto: inv.pay_amount,
        amount_fiat: inv.subtotal_amount,
        pay_url: inv.pay_url,
      },
    });
  } catch (err) {
    console.error("GET /payments/intent:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * GET /api/payments/status?invoiceId=123
 */
router.get("/payments/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT status
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    res.json({ ok: true, status: inv.status });
  } catch (err) {
    console.error("GET /payments/status:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * GET /api/payments/sync?invoiceId=123
 */
router.get("/payments/sync", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [row] = await sql/*sql*/`
      SELECT provider_payment_id
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!row?.provider_payment_id) {
      return res.status(400).json({ error: "sem provider_payment_id na fatura" });
    }

    const r = await fetch(`${NOW_API}/payment/${row.provider_payment_id}`, {
      headers: { "x-api-key": NOW_API_KEY },
    });
    const p = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "Erro no provider", detail: p });
    }

    const status = String(p.payment_status || "").toLowerCase();
    if (status === "finished") {
      await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
    } else if (status === "failed" || status === "expired") {
      await sql/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;
    } else if (status === "partially_paid") {
      await sql/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
    }

    res.json({ ok: true, provider_status: status });
  } catch (err) {
    console.error("GET /payments/sync:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * POST /api/payments/webhook
 */
router.post("/payments/webhook", express.json(), async (req, res) => {
  try {
    if (!verifyNowSig(req.body, req.headers["x-nowpayments-sig"], NOW_IPN_SECRET)) {
      return res.status(401).json({ error: "assinatura inválida" });
    }

    const p = req.body;
    const paymentStatus = String(p.payment_status || "").toLowerCase();
    const orderId = String(p.order_id || "");
    const paymentId = p.payment_id ? Number(p.payment_id) : null;

    let invoiceId = 0;
    if (orderId.startsWith("invoice_")) invoiceId = Number(orderId.replace("invoice_", ""));

    if (paymentStatus === "finished") {
      if (paymentId) {
        await sql/*sql*/`
          UPDATE energy_invoices
          SET status='pago'
          WHERE provider_payment_id=${paymentId}
             OR (id=${invoiceId} AND ${invoiceId} <> 0)
        `;
      } else if (invoiceId) {
        await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      }
    } else if (paymentStatus === "partially_paid") {
      if (paymentId) {
        await sql/*sql*/`
          UPDATE energy_invoices
          SET status='aguarda_pagamento'
          WHERE provider_payment_id=${paymentId}
             OR (id=${invoiceId} AND ${invoiceId} <> 0)
        `;
      }
    } else if (paymentStatus === "failed" || paymentStatus === "expired") {
      if (paymentId) {
        await sql/*sql*/`
          UPDATE energy_invoices
          SET status='pendente'
          WHERE provider_payment_id=${paymentId}
             OR (id=${invoiceId} AND ${invoiceId} <> 0)
        `;
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /payments/webhook:", err);
    res.status(500).json({ error: "Erro no processamento do webhook" });
  }
});

export default router;
