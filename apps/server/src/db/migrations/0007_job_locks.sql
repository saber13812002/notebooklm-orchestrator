-- 0007: NLO-P4-1C — durable job execution locks (settle-once)
--   * job_locks: one row per job while a live instance is driving it from
--     CREATED/QUEUED to a terminal state. The row is DURABLE (SQLite), so it
--     outlives the holder's crash; the next boot clears every lock with
--     resetAll() BEFORE recoverInFlight() re-queues in-flight jobs, so a
--     dead instance can never wedge a job.
--   * holder: the process instance id that owns the lock (owner-only release
--     + owner-only lease renewal).
--   * acquired_at / expires_at: ISO-8601 UTC timestamps; the lock is
--     stealable only once expires_at is in the past (holder presumed dead —
--     TTL = max(jobTimeout, 30min) + 10min margin, refreshed while driving).
--
-- Compatibility: pure CREATE TABLE IF NOT EXISTS + CREATE INDEX. Existing
-- deployments apply this on boot and keep working (no pre-existing rows).

CREATE TABLE IF NOT EXISTS job_locks (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_locks_expires ON job_locks(expires_at);
