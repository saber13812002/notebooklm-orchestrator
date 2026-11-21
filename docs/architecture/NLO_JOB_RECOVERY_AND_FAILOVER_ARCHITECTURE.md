# NLO Job Recovery & Failover Architecture (NLO-P4)

Mission: **NLO-P4-0**. Target design for **manual retry & recovery** and **provider failover** — the cross-cutting policy of Job Orchestration + Provider Management (folded context, see [`NLO_P4_TARGET_ARCHITECTURE.md`](NLO_P4_TARGET_ARCHITECTURE.md) §3).
Companion to **ADR-007** (retry & failover policy). Baseline: `main @ 76cd5f03`. Design document — no code changes.
Status labels as defined in [`NLO_P4_TARGET_ARCHITECTURE.md`](NLO_P4_TARGET_ARCHITECTURE.md).

---

## 1. Baseline (source-audited, status-labeled)

| Area                    | Baseline at `76cd5f03`                                                                                                                                                                                                                                                                                                                      | Status                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| State machine           | 12 `JobStatus` values; `canTransition`/`transition` in [`job-state.ts`](../../packages/shared/src/job-state.ts) enforced in `JobsRepo.setStatus` (illegal transition ⇒ throw, not silent)                                                                                                                                                   | `IMPLEMENTED` + unit-tested                                           |
| Auto-retry loop         | `RETRY_WAIT` status + engine backoff; [`retry.ts`](../../packages/shared/src/retry.ts): `RETRYABLE` map (auth / invalid_input / ambiguous / unknown = **false**; rate_limit / connectivity / proxy / provider = **true**), `classifyError`, `backoffMs` (exponential, full jitter, base 2 s, cap 300 s — deterministic when `rng` supplied) | `IMPLEMENTED` + unit-tested                                           |
| Failure classification  | `FailureClass` (8 values) + `ProviderFailure` with `ambiguous` flag (**NEVER auto-retried**) and `needsReauth`                                                                                                                                                                                                                              | `IMPLEMENTED`                                                         |
| Restart recovery        | 7 restart-recoverable statuses → reset to `QUEUED` at boot with a `restart_recover` event — [`isRestartRecoverable`](../../packages/shared/src/job-state.ts:64), `RESTART_RESET_STATUS`                                                                                                                                                     | `IMPLEMENTED` + integration-tested (`worker-queue-recovery.test.ts`)  |
| Resume-never-resubmit   | `patchOperationIds` persists the external task id **without a status transition**; `job_stages` rows preserve `external_operation_id` across restart ("interrupted by restart"); on resume the engine **polls the existing op**, it never resubmits                                                                                         | `IMPLEMENTED` + integration-tested (`podcast-fault-recovery.test.ts`) |
| Worker process          | `WorkerSupervisor`: arg-array spawn, JSON-line stdio, **settle-once contract**, stale-response drop, SIGTERM→SIGKILL 4 s, 30-min request timeout                                                                                                                                                                                            | `IMPLEMENTED` + unit-tested                                           |
| Manual retry API        | **none** — a failed job can only be cancelled or left; there is no `POST /jobs/:id/retry`                                                                                                                                                                                                                                                   | `NOT_IMPLEMENTED`                                                     |
| Cross-account failover  | account chosen at admission; a mid-job `auth` failure parks the job (`needsReauth` / `WAITING_FOR_ACCOUNT`), it does **not** move to another account automatically                                                                                                                                                                          | `IMPLEMENTED` (parking); cross-account move `NOT_IMPLEMENTED`         |
| Cross-provider failover | one provider is configured (python worker) + mock; no provider switch path                                                                                                                                                                                                                                                                  | `NOT_IMPLEMENTED` (single provider by construction)                   |

**The decisive baseline fact:** NLO already implements the _correct_ core — **an external id, once persisted, is never blindly resubmitted**. P4 generalizes that from "podcast ops" to _every_ op, and adds the human-facing API + the failover policy around it.

---

## 2. The three failure modes (mission taxonomy)

Every job failure is classified into exactly one of these — the policy is different for each, and mixing them is the bug class P4 eliminates:

| Mode                                 | Definition (observable evidence)                                                                                                                                                 | Examples                                                                            | Policy (target)                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Provider Unavailable**          | The job _could not even start_ the op: no healthy account, no healthy egress node, provider process down, quota exhausted _before_ submission                                    | `WAITING_FOR_ACCOUNT` timeout, fail-closed egress, worker crash before submit       | **Failover allowed** — re-acquire (other account → other node → later: other provider). No external id exists yet, so switching is always safe.                                          |
| **B. Operation Failed (definitive)** | The provider returned an explicit failure for a known op                                                                                                                         | "notebook not found", "source too large", HTTP 400-class from a _known_ external op | **Retry policy per failure class** — retryable classes re-run _the same op on the same account_ (with backoff); `invalid_input` never retries; definitive ⇒ `FAILED` after max attempts. |
| **C. Operation Outcome Unknown**     | An external op was submitted (external id exists) but the result is not known: worker died mid-poll, tunnel dropped during submit, 30-min request timeout after an ambiguous ack | SIGKILL between submit and result persist; proxy node died at submit time           | **UNKNOWN_EXTERNAL_STATE rule** (§3): _poll the external op before anything else_. **Never auto-transfer** to another account/provider — a duplicate notebook/overview would be created. |

This taxonomy is _data-driven_: the engine records, for every op, `external_operation_id` (existing `job_stages` column) plus a `lastOutcomeKnownAt` marker. The classification follows from what evidence exists, not from guesswork.

---

## 3. The UNKNOWN_EXTERNAL_STATE rule (no blind retry)

> **If `external_operation_id` is recorded for any stage of a job, the first action on any retry — automatic or manual, after crash or after timeout — is to query the external system for that op's status. The job may only proceed on evidence.**

Decision table (applied per op, in stage order):

| External query result                   | Action                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **op complete**                         | **Adopt the result**: fetch the artifact, record the stage done, continue. The job resumes exactly where the external world says it is. (This is what the podcast pipeline already does — generalized.)                                                                                      |
| **op still running**                    | Continue polling with the normal cadence (no attempt increment, no backoff reset).                                                                                                                                                                                                           |
| **op not found / rejected by provider** | Treat as Mode B on the _submit_ step: the external id was never accepted ⇒ safe to resubmit (delete the stale id, log `external_id_orphaned` event).                                                                                                                                         |
| **query itself failed / unverifiable**  | **Do not guess.** Park in `NEEDS_ATTENTION` with `errorClass: "ambiguous"` and a `state: UNKNOWN_EXTERNAL_STATE` event + the exact external id for human/ops follow-up. The operator (or a later live query) resolves it. **Never `SUCCEEDED` on assumption; never resubmit on assumption.** |

Invariants:

1. **Settle-once** (existing worker contract) carries over: two competing retries may never both submit the same op. The DB row lock on the job (existing single-writer engine) is the arbiter.
2. Every unknown-state transition is an **event** (`unknown_external_state_entered` / `_resolved_by_poll` / `_resolved_manual`) with the external id in `data` — webhooks carry it out (redacted).
3. `NEEDS_ATTENTION` is the _only_ parking state for mode C; a job in it is counted in `/api/health/ready` diagnostics so operators see the backlog.

---

## 4. Manual retry: RETRY FROM LAST SAFE CHECKPOINT (ADR-007)

### 4.1 What is a "safe checkpoint"

A **safe checkpoint** is a stage boundary where:

- all upstream stages are recorded **complete** in `job_stages`, and
- every external id produced upstream is persisted, and
- the job is in a terminal or parked state (`FAILED`, `NEEDS_ATTENTION`, or `CANCELLED` for the cancel-requested-but-op-unknown case).

The checkpoint list for a job is derived, never stored: `GET /api/jobs/:id/checkpoints` (new, P4-4) returns, per stage, `{ stage, externalOperationId?, status, safeForRetryFrom }`.

### 4.2 API (new, P4-4)

```
POST /api/jobs/:id/retry
body (all optional):
{
  "mode": "from_checkpoint" | "from_start",   // default "from_checkpoint"
  "accountId": "acc_..." ,                    // optional explicit account (Mode A failover)
  "nodeId": "node_..."                        // optional explicit egress node
}
```

Semantics:

1. `from_checkpoint` (default): resume at the first incomplete stage; all earlier stages are **trusted as recorded** (their external ids are polled per §3 before reuse — adopting, not redoing).
2. `from_start`: **allowed only when no external id exists anywhere** (pre-submit failures). If external ids exist, the server returns `409 { code: "E2E_JOB_HAS_EXTERNAL_STATE" }` — a from-start retry would duplicate external resources. (Forcing `from_start` with external ids requires an explicit `"discardExternal": true` and is logged as a warning event; the old external ids are recorded in the event `data` for manual cleanup.)
3. Retry is **idempotent per job state**: retrying a job that is already running ⇒ `409`; retrying `SUCCEEDED` ⇒ `409`.
4. The retry creates a **new attempt** (`attempt += 1`) on the _same job_ — no new job id (the mission's "retry a failed generation without losing its id", the same property roomi-fields v4.6.0 advertises — NLO achieves it structurally via `job_stages`).
5. Auth: same token scopes as job create (`jobs:write`); audit-logged.

### 4.3 What the manual retry does **not** do

- Never re-extracts/re-validates intake (the archive is the source of truth; re-validation only re-checks existence).
- Never changes the template/prompt snapshot (frozen at create).
- Never silently switches accounts _when external ids exist_ — explicit `accountId` in the body is the only way, and it is validated against the UNKNOWN_EXTERNAL_STATE rule first.

---

## 5. Automatic retry & failover policy (target, per failure class)

Preserves the existing `RETRYABLE` semantics; P4 only _adds_ the failover column (what to switch when it is safe to switch):

| FailureClass    | Auto-retry (existing)                 | Switch egress node (Mode A safe)                                                                            | Switch account                                                                       | Switch provider                          |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `auth`          | **no** (needsReauth ⇒ park)           | no                                                                                                          | only via manual retry with explicit `accountId`                                      | P4-later                                 |
| `rate_limit`    | yes (backoff)                         | yes (different egress IP can dodge per-IP limits)                                                           | yes, at next `WAITING_FOR_ACCOUNT` acquisition (quota-aware)                         | P4-later                                 |
| `invalid_input` | **no** ⇒ `FAILED`                     | no                                                                                                          | no                                                                                   | no (another provider has the same input) |
| `connectivity`  | yes (backoff)                         | **yes** — re-acquire via Egress Gateway (ADR-004); _only if no external id yet_; if external id exists ⇒ §3 | no                                                                                   | P4-later                                 |
| `provider`      | yes (backoff, bounded)                | no                                                                                                          | yes, at re-acquisition (if provider error is account-scoped, e.g. per-account quota) | P4-later                                 |
| `proxy`         | yes (backoff)                         | **yes** — immediate re-acquire (the node is the suspect)                                                    | no                                                                                   | P4-later                                 |
| `ambiguous`     | **never** ⇒ `NEEDS_ATTENTION` + §3    | only after §3 poll resolves "not found"                                                                     | only after §3 resolves                                                               | P4-later                                 |
| `unknown`       | **no** ⇒ `FAILED` (evidence recorded) | no                                                                                                          | no                                                                                   | no                                       |

Rules:

1. **A mid-job node switch is only legal while no external id is recorded for the in-flight op** (matches ADR-004's mid-job switch rule). After an external id exists, transport failures follow §3.
2. **Account switch mid-job** (mode A/B) re-resolves the session (verification TTL applies); the notebook that was already created on the old account is _owned by that account_ — so account switch is only permitted **before notebook creation** or via explicit manual retry with `accountId` (which re-polls the old notebook per §3 first).
3. **Provider switch** (cross-provider) is deliberately **not** in P4-4's auto path — the Provider Registry (ADR-001) makes it expressible, but auto cross-provider transfer is P4-7 (needs per-provider stage mapping + conformance). Manual cross-provider retry is _not_ offered either (a job is bound to its provider at create; a new job on another provider is the honest path).
4. All switches are **events** (`failover_node`, `failover_account`) with redacted `data`, so webhooks + the event log are the audit trail.

---

## 6. Restart / crash recovery (preserved, extended)

- The 7-status restart-recoverable set and `restart_recover → QUEUED` (existing) is **unchanged**.
- On boot, a job whose in-flight op had an external id follows §3 during its first re-pickup: poll before acting. The existing "interrupted by restart" `job_stages` handling is the implementation of this rule for the podcast path — P4 generalizes it to all providers.
- **Crash window guarantee** (design invariant): _for any op, at most one process may believe it is the submitter._ Today this holds via single-writer + settle-once; it must hold under P4's multi-worker growth path (target-arch §6) — the DB-level job lock is the mechanism, and it is the acceptance test for that path.

---

## 7. Testing hooks (feeds `NLO_P4_FUTURE_TEST_STRATEGY.md`)

| Scenario (mock provider)                                                                       | Verifies                    |
| ---------------------------------------------------------------------------------------------- | --------------------------- |
| Kill worker after submit, before result persist → restart → job resumes via poll, not resubmit | §3 "adopt"                  |
| Mock external op "not found" on poll → resubmit once, `external_id_orphaned` event             | §3 "orphan"                 |
| Mock external op unverifiable (network error on poll) → `NEEDS_ATTENTION`, `ambiguous`         | §3 "park"                   |
| Retry `from_start` with existing external ids ⇒ `409 E2E_JOB_HAS_EXTERNAL_STATE`               | §4.2(2)                     |
| Retry `from_checkpoint` after `FAILED` at stage 3 of 4 → stages 1–2 not redone                 | §4.1                        |
| `proxy` failure pre-submit → node switch, same account                                         | §5                          |
| `connectivity` failure post-submit → NO resubmit, §3 poll first                                | §5(1)                       |
| Restart with job in `RETRY_WAIT` → backoff continues, no attempt reset                         | existing behavior preserved |

All of these are expressible with the existing `fake-worker.mjs` / `fake-audio-worker.mjs` fixtures + the mock provider; **no live gate is required** for §3/§4 semantics (live verification belongs to C7 conformance per the capability contracts doc).
