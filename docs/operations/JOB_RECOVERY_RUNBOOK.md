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
