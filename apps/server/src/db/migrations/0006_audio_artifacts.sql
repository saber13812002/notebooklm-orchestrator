-- 0006: NLO-P2 audio pipeline — artifact metadata, stage persistence, webhook outbox
--   * artifacts: audio metadata (duration, codec, sample rate, channels,
--     bitrate), the SHA-256 of the stored file, provenance (mock/real/
--     unknown — from the provider's own report, never assumed) and
--     source_artifact_id (an application-produced artifact, e.g. an MP3
--     transcode, points at the artifact it was derived from). All columns
--     are nullable: NULL means "the producer did not report it" — the app
--     never fabricates metadata.
--   * job_stages: per-stage persistence for the podcast pipeline (stage,
--     state, attempt, timestamps, deadline, external_operation_id,
--     checkpoint_reference, last_error). After a restart, the persisted
--     state tells the runner which external operation was already
--     submitted, so it resumes instead of re-submitting.
--   * webhook_endpoints / webhook_deliveries: durable webhook outbox
--     (endpoints carry config + secret ref; deliveries are rows a
--     dispatcher retries and dead-letters). Created here so the schema is
--     stable before the delivery infrastructure lands.
--
-- Compatibility: pure ADD COLUMN + CREATE TABLE IF NOT EXISTS. Existing
-- deployments apply this on boot and keep working (new columns are NULL
-- on pre-existing rows).

ALTER TABLE artifacts ADD COLUMN duration_seconds REAL;
ALTER TABLE artifacts ADD COLUMN codec TEXT;
ALTER TABLE artifacts ADD COLUMN sample_rate INTEGER;
ALTER TABLE artifacts ADD COLUMN channels INTEGER;
ALTER TABLE artifacts ADD COLUMN bitrate INTEGER;
ALTER TABLE artifacts ADD COLUMN source_artifact_id TEXT;
ALTER TABLE artifacts ADD COLUMN sha256 TEXT;
ALTER TABLE artifacts ADD COLUMN provenance TEXT;

CREATE TABLE IF NOT EXISTS job_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  deadline_ms INTEGER,
  external_operation_id TEXT,
  checkpoint_reference TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_stages_job ON job_stages(job_id, stage);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  secret_ref TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  job_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  hmac_nonce TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  delivered_at TEXT,
  dead_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_job ON webhook_deliveries(job_id);
