// src/routes/payments.js
import express from "express";
import { sql } from "../config/db.js";

const router = express.Router();

/**
 * POST /api/payments/create-intent
 * body: { invoiceId: number, currency: "USDT" | "BTC" | "LTC" }
 * cria (ou atualiza) intent de pagamento para a fatura (status 'aguarda_pagamento')
 */
router.post("/payments/create-intent", async (req, res) => {
  try {
    const { invoiceId, currency } = req.body || {};
    if (!invoiceId || !currency) {
      return res.status(400).json({ error: "invoiceId e currency são obrigatórios" });
    }

    // 1) valida fatura
    const [inv] = await sql/*sql*/`
      SELECT id, user_id, subtotal_eur, status
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    // Opcional: só permitir criar intent se estiver 'pendente'
    // if (inv.status !== 'pendente') return res.status(400).json({ error: "Estado inválido" });

    // 2) calcula montante em cripto (placeholder: 1 EUR = 1 USD) — trocas depois para cotação real
    const amount_fiat = Number(inv.subtotal_eur) || 0;
    // placeholder "taxa" por moeda: deves substituir por cotação real e fees do PSP
    const fakeRates = { USDT: 1.0, BTC: 1 / 60000, LTC: 1 / 70 };
    const rate = fakeRates[currency] ?? 1.0;
    const amount_crypto = +(amount_fiat * rate).toFixed(8);

    // 3) gera "endereço" / ID de pagamento (placeholder)
    const payment_address = `demo_${currency}_${invoiceId}_${Date.now()}`;

    // 4) grava em tabela de intents (cria se não existir)
    // cria uma tabela simples se ainda não existir:
    // CREATE TABLE IF NOT EXISTS payment_intents (
    //   id SERIAL PRIMARY KEY,
    //   invoice_id INT UNIQUE REFERENCES energy_invoices(id),
    //   currency TEXT NOT NULL,
    //   amount_fiat NUMERIC NOT NULL,
    //   amount_crypto NUMERIC NOT NULL,
    //   payment_address TEXT NOT NULL,
    //   status TEXT DEFAULT 'pending', -- 'pending' | 'confirmed' | 'expired'
    //   txid TEXT,
    //   created_at TIMESTAMP DEFAULT NOW(),
    //   updated_at TIMESTAMP DEFAULT NOW()
    // );
    const upsert = await sql/*sql*/`
      INSERT INTO payment_intents (invoice_id, currency, amount_fiat, amount_crypto, payment_address, status)
      VALUES (${invoiceId}, ${currency}, ${amount_fiat}, ${amount_crypto}, ${payment_address}, 'pending')
      ON CONFLICT (invoice_id) DO UPDATE SET
        currency = EXCLUDED.currency,
        amount_fiat = EXCLUDED.amount_fiat,
        amount_crypto = EXCLUDED.amount_crypto,
        payment_address = EXCLUDED.payment_address,
        updated_at = NOW()
      RETURNING *
    `;

    // 5) opcional: atualizar estado da fatura para 'aguarda_pagamento'
    await sql/*sql*/`
      UPDATE energy_invoices
      SET status = 'aguarda_pagamento'
      WHERE id = ${invoiceId}
    `;

    res.json({ ok: true, intent: upsert[0] });
  } catch (e) {
    console.error("POST /payments/create-intent:", e);
    res.status(500).json({ error: "Erro ao criar intent de pagamento" });
  }
});

/**
 * POST /api/payments/mark-paid
 * body: { invoiceId: number, txid?: string }
 * marca como pago (para testes; em produção usas webhook do PSP)
 */
router.post("/payments/mark-paid", async (req, res) => {
  try {
    const { invoiceId, txid } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: "invoiceId é obrigatório" });

    // atualiza intent
    await sql/*sql*/`
      UPDATE payment_intents
      SET status = 'confirmed', txid = ${txid || null}, updated_at = NOW()
      WHERE invoice_id = ${invoiceId}
    `;

    // atualiza fatura
    await sql/*sql*/`
      UPDATE energy_invoices
      SET status = 'pago'
      WHERE id = ${invoiceId}
    `;

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /payments/mark-paid:", e);
    res.status(500).json({ error: "Erro ao confirmar pagamento" });
  }
});

/**
 * GET /api/payments/status?invoiceId=...
 * devolve estado do intent + fatura
 */
router.get("/payments/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT id, user_id, subtotal_eur, status
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const [intent] = await sql/*sql*/`
      SELECT *
      FROM payment_intents
      WHERE invoice_id = ${invoiceId}
      LIMIT 1
    `;

    res.json({ ok: true, invoice: inv, intent: intent || null });
  } catch (e) {
    console.error("GET /payments/status:", e);
    res.status(500).json({ error: "Erro ao consultar estado de pagamento" });
  }
});

export default router;
