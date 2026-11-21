# NLO Manual Retry & Recovery Spec (Product)

Mission: **NLO-P4-0** · Product-level specification for how an operator **recovers a failed, stuck, or interrupted job** — "RETRY FROM LAST SAFE CHECKPOINT" and the no-blind-retry guarantee.
Companion: architecture [`NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`](../architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md), **ADR-007** (retry & failover policy). Baseline: `main @ 76cd5f03`.
Status labels as defined in [`NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md).

---

## 1. The product problem

Today (baseline) a job that ends `FAILED` or parks in `NEEDS_ATTENTION` has **no recovery path** — the operator must create a _new_ job. That is wrong in two ways:

1. **It loses identity.** The job id (`j_<hex32>`), its events, its artifacts-so-far, its webhooks, and any external notebook/op already created are all orphaned; a new job starts from scratch and can **duplicate external work** (a second notebook, a second paid generation).
2. **It re-does what already succeeded.** A podcast job that already created its notebook and added its sources, then failed at audio download, would re-create everything on a new job.

Ecosystem evidence: roomi-fields v4.6.0 added _"retry a failed generation without losing its id"_ — a signal that this is the behavior users expect. NLO can do it _structurally_ because `job_stages` already persists every external op id (the resume-never-resubmit property, `IMPLEMENTED` + integration-tested for podcasts).

**Product principle:** _a retry resumes from evidence, never from guesswork._ If NLO cannot prove what an external op did, it asks — it never re-runs it blindly.

---

## 2. The three failure modes (what the operator sees)

Every stopped job is in exactly one of these states, and the UI/API labels it as such:

| Mode                             | Label shown                                                 | What it means                                                          | What retry does                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Provider Unavailable**      | `failed_before_start` (no external id anywhere)             | the job never reached the provider (no account, no proxy, worker down) | safe to redo from the start of the op — **and** to try a different account/node (operator's choice)                                                        |
| **B. Operation Failed**          | `operation_failed` (explicit provider error for a known op) | the provider said "no" to a specific step                              | retry the _same_ op (backed by the automatic retry policy if the class is retryable); operator retry = one more attempt now, optionally on another account |
| **C. Operation Outcome Unknown** | `outcome_unknown` (external id exists, result not known)    | the worker crashed / tunnel dropped / timed out **after** submission   | **poll the external op first**; adopt its result if it exists. Never resubmit unless the poll proves the op was never accepted                             |

The mode is derived from stored evidence (`job_stages.external_operation_id` + last known outcome), **not** from the error message text.

---

## 3. RETRY FROM LAST SAFE CHECKPOINT

### 3.1 What a "safe checkpoint" is

A **safe checkpoint** is a stage boundary satisfying all of:

1. every upstream stage is recorded **complete** in `job_stages` (with its external op id persisted), and
2. the job is stopped in `FAILED`, `NEEDS_ATTENTION`, or `CANCELLED`, and
3. nothing downstream of the boundary has recorded an external id (i.e., the boundary is the _first incomplete_ stage).

**`GET /api/v1/jobs/:id/checkpoints`** (new, P4-4) returns the derived list:

```jsonc
{
  "jobId": "j_1a2b…",
  "status": "FAILED",
  "failureMode": "outcome_unknown", // A | B | C
  "checkpoints": [
    { "stage": "create_notebook", "externalOperationId": null, "safeForRetryFrom": true },
    { "stage": "add_source", "externalOperationId": "op_1", "safeForRetryFrom": true },
    {
      "stage": "generate_audio",
      "externalOperationId": "op_9",
      "safeForRetryFrom": true,
      "note": "external op exists — retry will POLL it first (adopt or resubmit-on-proof)",
    },
  ],
  "lastSafeCheckpoint": "add_source", // first incomplete = generate_audio resumes here
}
```

### 3.2 The retry API (new, P4-4)

```
POST /api/v1/jobs/:id/retry
Auth: API token, scope jobs:write (audit-logged)
Body (all optional):
{
  "mode": "from_checkpoint" | "from_start",     // default "from_checkpoint"
  "accountId": "acc_…",                          // optional — explicit account (failover choice)
  "nodeId": "node_…",                            // optional — explicit egress node
  "discardExternal": false                       // required true to force from_start with external ids
}
→ 202 { job, status: "QUEUED", attempt: n+1, resumeFrom: "generate_audio" }
```

**Semantics:**

- **`from_checkpoint` (default)** — resume at the first incomplete stage. All earlier stages are _trusted as recorded_: their external ids are **polled before reuse** (adopt the external result; never redo it). Intake is **not** re-extracted (the job archive is the source of truth).
- **`from_start`** — allowed **only when no external id exists anywhere**. If external ids exist, the server returns `409 { code: "E2E_JOB_HAS_EXTERNAL_STATE" }`. Forcing it requires explicit `"discardExternal": true`; the job then records a `retry_discard_external` warning event listing the orphaned ids for manual cleanup.
- **Retry = a new attempt on the same job** (`attempt += 1`): same job id, same events stream, same webhook endpoints, same artifacts. The id is never lost.
- **Idempotent per state:** retrying a job that is `RUNNING`/`QUEUED`/`RETRY_WAIT` ⇒ `409`; retrying `SUCCEEDED` ⇒ `409`.
- **Account/node choice:** an explicit `accountId`/`nodeId` is honored _if eligible_ (verified session / healthy node per ADR-003/004) and is recorded in the event `data`. Without it, the normal routing policy applies. **With external ids present, an account switch re-polls the old account's notebook first** (the notebook belongs to the account that created it).

### 3.3 What a retry does NOT do (product guarantees)

| Guarantee                                                | Rationale                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Never re-validates/re-extracts intake                    | the archive already has the verified input; re-doing it adds cost, not safety     |
| Never changes the template/prompt snapshot               | frozen at create (ADR-002); a retry is the _same_ job                             |
| Never blind-resubmits an op with a recorded external id  | the UNKNOWN_EXTERNAL_STATE rule (§4)                                              |
| Never reports success without evidence                   | an "adopted" result is verified (artifact fetched + validated) before `SUCCEEDED` |
| Never silently switches accounts when external ids exist | explicit `accountId` only, and it re-polls first                                  |

---

## 4. The UNKNOWN_EXTERNAL_STATE rule (the no-blind-retry guarantee)

> **If an external operation id is recorded, the first action on any retry is to ask the external system what happened. NLO proceeds only on evidence.**

| External poll result                 | Product behavior                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Op complete**                      | _Adopt_: fetch + validate the artifact, mark the stage done, continue. The operator sees `retry_adopted_external_result` (with the op id) in the job events.                                                         |
| **Op still running**                 | _Wait_: keep polling on the normal cadence (no extra attempt, no backoff reset).                                                                                                                                     |
| **Op not found / never accepted**    | _Resubmit once_: the external id is orphaned; the op is safely re-run. Event `external_id_orphaned`.                                                                                                                 |
| **Poll itself fails / unverifiable** | _Park_: job → `NEEDS_ATTENTION`, `errorClass: "ambiguous"`, event `unknown_external_state_entered` with the exact external id for human/ops follow-up. **Never assumed complete; never re-submitted on assumption.** |

Operator UX for the parked case: the job screen shows _"Outcome of external operation `op_9` is unknown. NLO will not re-run it automatically. Options: [Re-check now] [Cancel & create new job]."_ — "Re-check now" re-runs the poll only (no submission).

**Settle-once:** at most one process may believe it owns a given op (the DB job lock is the arbiter) — two concurrent retries can never both submit it.

---

## 5. Automatic vs manual (who does what)

| Situation                                                                              | Automatic (engine, existing policy extended per ADR-007) | Manual (operator)                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Retryable class (`rate_limit`/`connectivity`/`proxy`/`provider`) before an external id | backoff retry, node/account failover per policy          | optional earlier retry                                                             |
| `invalid_input`                                                                        | none — `FAILED`                                          | fix the input → **new job** (retry is refused: the input is known-bad)             |
| `auth` (needsReauth)                                                                   | none — park                                              | re-authenticate the account, then retry                                            |
| `ambiguous` / outcome unknown                                                          | none — `NEEDS_ATTENTION`                                 | "Re-check now" (poll only) or retry-from-checkpoint (poll-first)                   |
| `unknown`                                                                              | none — `FAILED` with full evidence                       | inspect `errorClass`/events; retry is allowed but the same evidence is re-attached |

The operator is never required to understand internal classes: the job screen shows the **mode** (§2) and the **recommended action**; the raw `errorClass` is available in the API/events for automation.

---

## 6. API/MCP surface (product-relevant)

| Surface                            | Endpoint                                                                                                                                                                                                                    | Phase |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Checkpoints (derived, read-only)   | `GET /api/v1/jobs/:id/checkpoints`                                                                                                                                                                                          | P4-4  |
| Retry                              | `POST /api/v1/jobs/:id/retry`                                                                                                                                                                                               | P4-4  |
| Re-check unknown state (poll-only) | `POST /api/v1/jobs/:id/recheck` (alias for a poll-only retry)                                                                                                                                                               | P4-4  |
| MCP tools                          | `retry_job` (maps to the retry endpoint), `get_job` (includes `failureMode` + checkpoints when non-running)                                                                                                                 | P4-6  |
| Webhook events                     | `retry_requested`, `retry_adopted_external_result`, `external_id_orphaned`, `unknown_external_state_entered/_resolved_by_poll/_resolved_manual`, `failover_node`, `failover_account` (all redacted, existing HMAC envelope) | P4-4  |

All retry endpoints reuse the existing error envelope (`ApiCodes`), audit logging, and idempotency-key support (token-scoped) — no new auth or error machinery.

---

## 7. Acceptance (definition of done, product level)

- A `FAILED` podcast job with a completed `create_notebook` + `add_source` retries `from_checkpoint`: the notebook and sources are **not** re-created (verified by external op ids being polled, not re-submitted), and the audio generation resumes. Same job id, `attempt` incremented, events continuous.
- A job with external ids in state B retrying `from_start` ⇒ `409 E2E_JOB_HAS_EXTERNAL_STATE`; with `"discardExternal": true` it proceeds + warning event + orphan ids recorded.
- A job in state C: retry polls first; on "complete" it adopts (artifact fetched + validated) and reaches `SUCCEEDED` **without** a new submission; on unverifiable poll it parks in `NEEDS_ATTENTION` and no submission occurs.
- Retry is available on all three paths (UI, REST, MCP `retry_job`) with identical semantics.
- No new job status is introduced; all states above are expressible with the existing 12-status machine + `NEEDS_ATTENTION`.
