import type { Db } from "../db/db.js";

export type StageState = "in_progress" | "completed" | "failed";

export interface StageRow {
  id: number;
  jobId: string;
  stage: string;
  state: StageState;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  deadlineMs: number | null;
  externalOperationId: string | null;
  checkpointReference: string | null;
  lastError: string | null;
  createdAt: string;
}

/**
 * JobStagesRepo (NLO-P2): per-stage persistence for the podcast pipeline.
 *
 * Every pipeline stage (audio_generation, artifact_download, artifact_store)
 * is recorded as a row carrying its state, attempt, timestamps, deadline and
 * — crucially — the external operation id it is tracking. Restart recovery
 * (`recoverOpen`) marks any stage still in_progress as interrupted WITHOUT
 * touching the external operation id, so a restarted process knows exactly
 * which external operation to resume (or reconcile) and can never re-submit
 * an operation whose completion is unproven.
 *
 * Stage semantics:
 *  - `begin`        creates a new in_progress row (one row per attempt).
 *  - `setExternal`  records the external operation id on the open row.
 *  - `complete`     the open row -> completed.
 *  - `fail`         the open row -> failed + last_error.
 *  - a yield (restart recovery re-queued the job) leaves the row in_progress
 *    on purpose: that IS the checkpoint. `recoverOpen` settles it at restart.
 */
export class JobStagesRepo {
  constructor(private readonly db: Db) {}

  /** Begin a stage (a new in_progress row). Returns the row id. */
  begin(
    jobId: string,
    stage: string,
    opts: {
      attempt?: number;
      deadlineMs?: number;
      externalOperationId?: string | null;
      checkpointReference?: string | null;
    } = {},
  ): number {
    const res = this.db.raw
      .prepare(
        `INSERT INTO job_stages (
           job_id, stage, state, attempt, started_at, deadline_ms,
           external_operation_id, checkpoint_reference, created_at
         ) VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        stage,
        opts.attempt ?? 1,
        this.db.now(),
        opts.deadlineMs ?? null,
        opts.externalOperationId ?? null,
        opts.checkpointReference ?? null,
        this.db.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /** Record the external operation id on the open (in_progress) row. */
  setExternal(
    jobId: string,
    stage: string,
    externalOperationId: string,
    checkpointReference: string | null = null,
  ): number {
    return Number(
      this.db.raw
        .prepare(
          `UPDATE job_stages
           SET external_operation_id = ?, checkpoint_reference = ?
           WHERE id = (SELECT id FROM job_stages
                       WHERE job_id = ? AND stage = ? AND state = 'in_progress'
                       ORDER BY id DESC LIMIT 1)`,
        )
        .run(externalOperationId, checkpointReference, jobId, stage).changes,
    );
  }

  /** Mark the open row completed. Returns 0 when nothing is open. */
  complete(jobId: string, stage: string): number {
    return Number(
      this.db.raw
        .prepare(
          `UPDATE job_stages SET state = 'completed', finished_at = ?
           WHERE id = (SELECT id FROM job_stages
                       WHERE job_id = ? AND stage = ? AND state = 'in_progress'
                       ORDER BY id DESC LIMIT 1)`,
        )
        .run(this.db.now(), jobId, stage).changes,
    );
  }

  /** Mark the open row failed with a last_error. Returns 0 when nothing is open. */
  fail(jobId: string, stage: string, lastError: string): number {
    return Number(
      this.db.raw
        .prepare(
          `UPDATE job_stages SET state = 'failed', finished_at = ?, last_error = ?
           WHERE id = (SELECT id FROM job_stages
                       WHERE job_id = ? AND stage = ? AND state = 'in_progress'
                       ORDER BY id DESC LIMIT 1)`,
        )
        .run(this.db.now(), lastError, jobId, stage).changes,
    );
  }

  /**
   * Restart recovery: mark every in_progress stage of the job as failed with
   * a restart marker. The external_operation_id is PRESERVED — the restarted
   * process resumes from it (no duplicate submission, no lost operation).
   */
  recoverOpen(jobId: string): number {
    return Number(
      this.db.raw
        .prepare(
          `UPDATE job_stages
           SET state = 'failed', finished_at = ?, last_error = 'interrupted by restart'
           WHERE job_id = ? AND state = 'in_progress'`,
        )
        .run(this.db.now(), jobId).changes,
    );
  }

  /** The most recent row for (jobId, stage), any state. */
  latest(jobId: string, stage: string): StageRow | null {
    const rows = this.db.raw
      .prepare(`SELECT * FROM job_stages WHERE job_id = ? AND stage = ? ORDER BY id DESC LIMIT 1`)
      .all(jobId, stage);
    const row = rows[0];
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  listByJob(jobId: string): StageRow[] {
    return this.db.raw
      .prepare(`SELECT * FROM job_stages WHERE job_id = ? ORDER BY id`)
      .all(jobId)
      .map((r) => this.map(r as Record<string, unknown>));
  }

  private map(row: Record<string, unknown>): StageRow {
    return {
      id: Number(row.id),
      jobId: String(row.job_id),
      stage: String(row.stage),
      state: row.state as StageState,
      attempt: Number(row.attempt),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      deadlineMs: row.deadline_ms == null ? null : Number(row.deadline_ms),
      externalOperationId:
        row.external_operation_id == null ? null : String(row.external_operation_id),
      checkpointReference:
        row.checkpoint_reference == null ? null : String(row.checkpoint_reference),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: String(row.created_at),
    };
  }
}
