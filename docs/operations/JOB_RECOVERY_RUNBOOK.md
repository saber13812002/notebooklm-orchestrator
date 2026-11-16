# Job Recovery Runbook (NLO-P1)

Scope: manual, evidence-based recovery as observed **through the API**. No direct DB surgery, no
state-machine bypass, no automatic retry of ambiguous jobs.

## 1. Classify first (never act on an unclear job)

```bash
NLO_API_BASE=… NLO_API_TOKEN=… npm run e2e -w @nlo/server -- --scenario monitor --job-id <id>
```

Read the report: `job_status_history`, `attempts_observed`, `errors[].code`, `failure_class`.

| Observation                                           | Meaning                  | Allowed action                                                    |
| ----------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `errorClass=proxy`, attempts < max                    | transient tunnel failure | wait for the built-in `RETRY_WAIT`; do **not** requeue            |
| `errorClass=connectivity`                             | worker/connection issue  | verify worker supervisor health; let retry policy run             |
| `errorClass=auth`                                     | session expired          | re-authenticate the account; **never** requeue blind              |
| `errorClass=provider`                                 | provider-side failure    | inspect `errorMessage`; requeue only if attempts exhausted        |
| `status=NEEDS_ATTENTION` or `E2E_JOB_STUCK`           | ambiguous state          | **BLOCKED** — human inspection, no auto-requeue                   |
| `status=FAILED` and attempts exhausted, non-ambiguous | terminal failure         | `POST /jobs/{id}/requeue` (one at a time)                         |
| `status=SUCCEEDED` but artifact missing/invalid       | incomplete result        | treat as failure; investigate artifact storage before any requeue |

## 2. Requeue / cancel (documented endpoints only)

```bash
POST /api/v1/jobs/{id}/requeue     # only after §1 allows it
POST /api/v1/jobs/{id}/cancel      # user-requested cancellation
```

Idempotency: requeue is **not** idempotent by design; run it once, then monitor with the runner and
record the new `attempt`. Duplicate submissions from a client should use the existing
`idempotencyKey` support (token-scoped creation) instead of retrying the same request blindly.

## 3. Server-restart safety

After a restart, verify (1) the worker supervisor is up, (2) no job is left in `RUNNING` without a
heartbeat (`--stall-ms` will surface it), (3) the queue drains. Existing tests already cover
queue recovery (`apps/server/test/worker-queue-recovery.test.ts`).

## 4. Evidence to record per recovery

`job_id`, prior status, `errorClass`, `attempts_observed`, action taken, new status, run report path,
operator, timestamp (UTC). Never record tokens or user content.

## 5. Durable job locks (NLO-P4-1C) — settle-once

Since NLO-P4-1C (migration `0007_job_locks`), every instance that drives a
job from `CREATED`/`QUEUED` to a terminal state holds a **durable row** in
`job_locks(job_id, holder, acquired_at, expires_at)`. At most one LIVE
instance can drive a job: a second instance whose `acquire` is refused stands
down and leaves the job untouched.

- **Boot sweep:** on every start, `lock.resetAll()` runs **before**
  `recoverInFlight()`, so locks left behind by a crashed process are cleared
  and the recovered jobs are re-acquirable. The start log prints
  `[nlo] cleared N stale job lock(s) from a previous run` when N > 0.
- **TTL:** `max(job timeout, 30min) + 10min` (default 40min), refreshed on
  every attempt. A lock only becomes stealable after `expires_at` — a live
  holder is never dislodged mid-job.
- **Inspecting a lock:** `SELECT job_id, holder, acquired_at, expires_at
  FROM job_locks;` (read-only; the table is small — at most one row per
  in-flight job).
- **Unwedge (only after §1 says the holder is dead):** if a job sits in a
  non-terminal status and its lock `holder` is a PID that no longer exists
  (and the lock is not yet expired), restart the service — the boot sweep
  clears it. Do not delete lock rows while the holder process is alive.
