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
// Redes de USDC suportadas no teu fluxo
const USDC_NETWORKS = ["ERC20", "BEP20"];

/* =========================
   Utilitários Provider
========================= */

// GET /v1/currencies — lista pay_currencies disponíveis para a tua conta
async function getNowCurrencies() {
  const r = await fetch(`${NOW_API}/currencies`, {
    headers: { "x-api-key": NOW_API_KEY },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`NOWPayments /currencies falhou: ${r.status} ${t}`);
  }
  return r.json(); // ex.: ["BTC","LTC","USDC","USDCBSC",...]
}

// Mapeia moeda + rede local → pay_currency do NOWPayments, validando contra /currencies
async function mapPayCurrency(currency, network) {
  const c = String(currency).toUpperCase();
  const n = String(network || "").toUpperCase();
  const list = await getNowCurrencies();

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

// (Opcional) verificação da assinatura HMAC do IPN
function verifyNowSig(reqBody, headerSig, secret) {
  if (!secret) return true; // em dev, se não tiveres segredo, não bloqueia
  if (!headerSig) return false;
  const raw = JSON.stringify(reqBody);
  const check = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  return String(headerSig).toLowerCase() === check.toLowerCase();
}

/* =========================
   Rotas públicas
========================= */

/**
 * POST /api/payments/create-intent
 * body: { invoiceId:number, currency:"USDC"|"BTC"|"LTC", network:"ERC20"|"BEP20"|"NATIVE" }
 * -> cria pagamento no NOWPayments e grava TUDO na energy_invoices (sem payment_intents)
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
      net = "NATIVE"; // BTC/LTC usam rede base
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
    const pay_currency = await mapPayCurrency(cur, net);

    // Cria pagamento no NOWPayments
    const payload = {
      price_amount,
      price_currency: "USD",
      pay_currency,
      order_id: `invoice_${invoiceId}`,
      order_description: `Energia #${invoiceId}`,
    };
    if (NOW_IPN_URL) payload.ipn_callback_url = NOW_IPN_URL;

    const nowRes = await fetch(`${NOW_API}/payment`, {
      method: "POST",
      headers: {
        "x-api-key": NOW_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const np = await nowRes.json();
    if (!nowRes.ok || !np.payment_id) {
      console.error("NOWPayments error:", np);
      return res.status(502).json({ error: "Erro na criação do pagamento", provider: np });
    }

    // Guarda diretamente na energy_invoices (sem payment_intents)
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

    // Devolve um "intent" sintético (o app só precisa destes dados)
    return res.json({
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
    return res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * GET /api/payments/intent?invoiceId=123
 * -> devolve os dados do intent guardados na energy_invoices (para renderizar/retomar)
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
 * -> estado atual da fatura (para polling no app)
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
 * -> fallback: consulta o NOWPayments pelo payment_id e atualiza a fatura
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
 * -> IPN do NOWPayments: atualiza energy_invoices.status com base no payment_id
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

    // Podes usar tanto order_id (invoice_123) como payment_id. Usaremos ambos para robustez.
    let invoiceId = 0;
    if (orderId.startsWith("invoice_")) {
      invoiceId = Number(orderId.replace("invoice_", ""));
    }

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
