-- 0005: API productization (Phase C)
--   * api_tokens: scoped API tokens for external consumers.
--     Only a SHA-256 hash of the token value is stored — the plaintext
--     token is returned exactly once (at creation) and can never be
--     read back. Revocation is a flag (the row is kept for audit).
--   * api_audit_log: append-only audit trail of token-authorized API
--     activity (actor = token name, action, path, status). No request
--     bodies, no secrets (redaction applied at the call site).
--   * jobs.idempotency_key: client-supplied key (per token) that makes
--     repeated job-creation requests collapse onto one job.

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'jobs:read',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_name ON api_tokens(name);

CREATE TABLE IF NOT EXISTS api_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  token_name TEXT,
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_audit_at ON api_audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_api_audit_token ON api_audit_log(token_id, at DESC);

-- Idempotency anchor on jobs: (token_id, idempotency_key) is unique;
-- re-sending the same key for the same token returns the same job.
ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;
ALTER TABLE jobs ADD COLUMN token_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idem ON jobs(token_id, idempotency_key)
  WHERE token_id IS NOT NULL AND idempotency_key IS NOT NULL;
