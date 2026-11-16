import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

/**
 * NLO-P4-1C — durable job execution locks (settle-once).
 *
 * A `job_locks` row (migration 0007) means "this instance is driving this
 * job right now". The lock is durable (SQLite), so it survives the holder's
 * crash; the next boot clears every lock via `resetAll()` BEFORE
 * `recoverInFlight()` re-queues in-flight jobs, so a dead instance can
 * never wedge a job (F-C4).
 *
 * Semantics:
 *   - `acquire`: settle-once claim. Inserts a fresh lock, or steals one that
 *     has EXPIRED (holder presumed dead). Never steals a live lock held by
 *     another holder (F9). Idempotent for the current holder.
 *   - `release`: owner-only (a non-owner release is a no-op, never an error).
 *   - `refresh`: owner-only lease renewal — the runner renews while driving
 *     a job that legitimately outlasts a single TTL (retries + podcast).
 *   - `resetAll`: boot-time sweep; returns the number of locks cleared.
 */

/** Floor: even the fastest job gets the default job-timeout window. */
const MIN_JOB_TIMEOUT_MS = 30 * 60_000;
/** Grace margin over the job budget, so a live holder's lock outlives the job. */
const LOCK_MARGIN_MS = 10 * 60_000;

/** Default TTL (no explicit job timeout configured): 30min budget + 10min. */
export const DEFAULT_LOCK_TTL_MS = Math.max(MIN_JOB_TIMEOUT_MS, 30 * 60_000) + LOCK_MARGIN_MS;

/** TTL for a job with the given per-job hard timeout (ms). */
export function lockTtlFor(jobTimeoutMs: number = MIN_JOB_TIMEOUT_MS): number {
  return Math.max(jobTimeoutMs, MIN_JOB_TIMEOUT_MS) + LOCK_MARGIN_MS;
}

export class JobLocks {
  /** Stable id for this process instance (unique per `new JobLocks`). */
  readonly holderId: string;

  constructor(
    private readonly db: Db,
    holderId?: string,
  ) {
    this.holderId = holderId ?? `process:${process.pid}:${randomUUID()}`;
  }

  /**
   * Claim the lock for `jobId`. Returns true iff THIS instance holds it
   * afterwards. Steals only an EXPIRED lock; a live foreign lock is
   * untouched. Idempotent for the current holder (renews the lease).
   */
  acquire(jobId: string, ttlMs: number): boolean {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO job_locks (job_id, holder, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           holder = excluded.holder,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE job_locks.holder = excluded.holder
            OR job_locks.expires_at < excluded.acquired_at`,
      )
      .run(jobId, this.holderId, now, expires);
    return this.holder(jobId) === this.holderId;
  }

  /** Owner-only release. Returns true iff a lock row was removed. */
  release(jobId: string): boolean {
    const res = this.db.raw
      .prepare("DELETE FROM job_locks WHERE job_id = ? AND holder = ?")
      .run(jobId, this.holderId);
    return Number(res.changes) > 0;
  }

  /** Owner-only lease renewal. Returns true iff this instance still holds it. */
  refresh(jobId: string, ttlMs: number): boolean {
    const res = this.db.raw
      .prepare("UPDATE job_locks SET expires_at = ? WHERE job_id = ? AND holder = ?")
      .run(new Date(Date.now() + ttlMs).toISOString(), jobId, this.holderId);
    return Number(res.changes) > 0;
  }

  /** Boot-time sweep: clear locks held by ANY (now-dead) instance. */
  resetAll(): number {
    const res = this.db.raw.prepare("DELETE FROM job_locks").run();
    return Number(res.changes);
  }

  holder(jobId: string): string | null {
    const row = this.db.raw.prepare("SELECT holder FROM job_locks WHERE job_id = ?").get(jobId) as
      { holder: string } | undefined;
    return row?.holder ?? null;
  }

  isHeld(jobId: string): boolean {
    return this.holder(jobId) !== null;
  }
}
