-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Events: detections and system events (connection_restored, etc.)
CREATE TABLE IF NOT EXISTS events (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  type          VARCHAR(50)   NOT NULL,
  confidence    FLOAT,
  snapshot_path VARCHAR(500),
  ended_at      TIMESTAMPTZ,
  synced        BOOLEAN       NOT NULL DEFAULT false
);

-- Idempotent: add ended_at to existing tables that were created before this migration
ALTER TABLE events ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_synced    ON events (synced);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events (type);

-- Connectivity log: records every online/offline status change
CREATE TABLE IF NOT EXISTS connectivity_log (
  id        SERIAL        PRIMARY KEY,
  status    VARCHAR(10)   NOT NULL CHECK (status IN ('online', 'offline')),
  timestamp TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connectivity_timestamp ON connectivity_log (timestamp DESC);

-- Persistent runtime preferences (feature flags, detection mode, ROI, etc.)
CREATE TABLE IF NOT EXISTS preferences (
  key        VARCHAR(100) PRIMARY KEY,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preferences_updated_at ON preferences (updated_at DESC);
