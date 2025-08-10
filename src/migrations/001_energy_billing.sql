-- logs de estado da miner
CREATE TABLE IF NOT EXISTS miner_status_logs (
  id BIGSERIAL PRIMARY KEY,
  miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
  status BOOLEAN NOT NULL,                 -- true=online
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  extra JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_msl_miner_time ON miner_status_logs(miner_id, at DESC);

-- cabeçalho da fatura (1 por user/mês)
CREATE TABLE IF NOT EXISTS energy_invoices (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  subtotal_eur NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente | enviada | paga | falhada
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_user_month
  ON energy_invoices(user_id, year, month);

-- linhas por miner
CREATE TABLE IF NOT EXISTS energy_invoice_items (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES energy_invoices(id) ON DELETE CASCADE,
  miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
  miner_nome TEXT NOT NULL,
  hours_online NUMERIC(12,3) NOT NULL,
  kwh_used NUMERIC(12,3) NOT NULL,
  preco_kw NUMERIC(12,6) NOT NULL,
  consumo_kw_hora NUMERIC(12,6) NOT NULL,
  amount_eur NUMERIC(12,2) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_item ON energy_invoice_items(invoice_id, miner_id);
