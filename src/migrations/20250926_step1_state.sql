-- ✅ Garantir UTC lógico (timestamptz já guarda em UTC)
-- SELECT current_setting('TIMEZONE');

-- ===== Tabela de estado estável do miner =====
CREATE TABLE IF NOT EXISTS miner_state (
  miner_id           BIGINT PRIMARY KEY REFERENCES miners(id) ON DELETE CASCADE,
  current_state      TEXT NOT NULL CHECK (current_state IN ('ONLINE','OFFLINE','STALE','DEGRADED')),
  stable_since_utc   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_change_utc    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_utc      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hashrate      NUMERIC(20,8) NOT NULL DEFAULT 0,
  flap_count         INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_miner_state_last_seen   ON miner_state (last_seen_utc DESC);
CREATE INDEX IF NOT EXISTS idx_miner_state_stable_since ON miner_state (stable_since_utc DESC);

-- ===== Log de transições (edge events) =====
CREATE TABLE IF NOT EXISTS miner_state_events (
  id                 BIGSERIAL PRIMARY KEY,
  miner_id           BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
  from_state         TEXT NOT NULL CHECK (from_state IN ('ONLINE','OFFLINE','STALE','DEGRADED')),
  to_state           TEXT NOT NULL CHECK (to_state   IN ('ONLINE','OFFLINE','STALE','DEGRADED')),
  slot_iso           TEXT NOT NULL,  -- "YYYY-MM-DDTHH:MM:00.000Z" (slot de 15m)
  occurred_at_utc    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason             TEXT,
  CONSTRAINT miner_state_events_unique UNIQUE (miner_id, slot_iso, from_state, to_state)
);

CREATE INDEX IF NOT EXISTS idx_mse_miner_time ON miner_state_events (miner_id, occurred_at_utc DESC);

-- ===== Smoke tests rápidos =====
-- Deve retornar 0 linhas, mas existir a tabela:
-- SELECT * FROM miner_state LIMIT 0;
-- SELECT * FROM miner_state_events LIMIT 0;
