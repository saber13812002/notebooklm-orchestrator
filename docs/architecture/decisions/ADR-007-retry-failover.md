# ADR-007: Retry & Failover Policy (failure-class driven; UNKNOWN_EXTERNAL_STATE)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`](../NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md)
This is a cross-cutting policy of **Job Orchestration + Provider Management** (a folded context, ADR-001).

## Context

NLO already implements the *correct core* of recovery: the `RETRYABLE` failure-class map (auth / invalid_input / ambiguous / unknown = **not** auto-retried; rate_limit / connectivity / proxy / provider = retried), full-jitter backoff, 7-status restart recovery, and — decisively — **resume-never-resubmit**: `patchOperationIds` persists the external task id and the engine *polls* the existing op after a restart instead of resubmitting.

What is missing for the mission: (1) a **manual** retry API with a clear, safe semantic ("retry from last safe checkpoint"); (2) an explicit policy that distinguishes **three failure modes** with different rules — *Provider Unavailable* (safe to failover), *Operation Failed* (retry same op), *Operation Outcome Unknown* (never blind-resubmit); and (3) **provider failover** that is safe across accounts/nodes/providers.

## Decision

1. **Every failure is classified into exactly one mode** — the policy differs per mode and mixing them is the bug class P4 eliminates:
   - **A. Provider Unavailable** — the op could not even start (no account, no egress, worker down, pre-submit quota). **Failover allowed** (re-acquire account → node → later provider); safe because *no external id exists yet*.
   - **B. Operation Failed (definitive)** — the provider returned an explicit failure for a *known* op. **Retry policy per failure class** on the *same account/op*; `invalid_input` never retries; definitive ⇒ `FAILED` after max attempts.
   - **C. Operation Outcome Unknown** — an external op was submitted (external id exists) but the result is not known. **UNKNOWN_EXTERNAL_STATE rule** (§2): poll first; **never auto-transfer**.
2. **The UNKNOWN_EXTERNAL_STATE rule (no blind retry):** if `external_operation_id` is recorded for any stage, the *first* action on any retry — automatic or manual, after crash or timeout — is to **query the external system** for that op's status and proceed only on evidence:
   | Poll result | Action |
   |---|---|
   | op complete | **adopt** the result (fetch artifact, continue) |
   | op running | keep polling (no attempt increment) |
   | op not found / rejected | safe to resubmit once (`external_id_orphaned` event) |
   | poll failed / unverifiable | **park in `NEEDS_ATTENTION`**, `errorClass: "ambiguous"` — never assume success, never resubmit on assumption |
   Invariants: **settle-once** (the DB job lock is the arbiter — at most one submitter believes it owns the op); every transition is an **event** (`unknown_external_state_entered` / `_resolved_by_poll` / `_resolved_manual`) carrying the external id (redacted); `NEEDS_ATTENTION` is the only parking state and is counted in `/api/health/ready` diagnostics.
3. **Manual retry = RETRY FROM LAST SAFE CHECKPOINT.** A *safe checkpoint* is a stage boundary where all upstream stages are recorded complete, every upstream external id is persisted, and the job is in a terminal/parked state. New API `POST /api/jobs/:id/retry` (P4-4):
   - `from_checkpoint` (default): resume at the first incomplete stage; earlier stages are *trusted as recorded* (their external ids are polled per §2 before reuse — **adopt, not redo**).
   - `from_start`: **only when no external id exists anywhere**; otherwise `409 E2E_JOB_HAS_EXTERNAL_STATE` (a from-start would duplicate external resources). Forcing it requires explicit `discardExternal: true` + a warning event.
   - Retry = **new attempt on the same job** (no new job id — "retry without losing its id"); idempotent per job state (`409` if running/`SUCCEEDED`); same `jobs:write` scope; audit-logged.
4. **Automatic failover is failure-class driven** (extends the existing `RETRYABLE` map with a failover column):
   | FailureClass | Auto-retry (existing) | Switch node | Switch account | Switch provider |
   |---|---|---|---|---|
   | `auth` | no (park, needsReauth) | no | manual only | P4-later |
   | `rate_limit` | yes | yes | yes (quota-aware re-acquisition) | P4-later |
   | `invalid_input` | no ⇒ `FAILED` | no | no | no |
   | `connectivity` | yes | yes (if no external id; else §2) | no | P4-later |
   | `provider` | yes (bounded) | no | yes (if account-scoped) | P4-later |
   | `proxy` | yes | yes (immediate re-acquire) | no | P4-later |
   | `ambiguous` | **never** ⇒ `NEEDS_ATTENTION` + §2 | after §2 resolves "not found" | after §2 | P4-later |
   | `unknown` | no ⇒ `FAILED` | no | no | no |
   Rules: a **mid-job node switch is legal only while no external id** exists for the in-flight op (matches ADR-004); an **account switch** before notebook creation is automatic, but after creation it is manual-only with an explicit `accountId` (re-polling the old notebook per §2 first); **cross-provider auto-failover is deferred to P4-7** (needs per-provider stage mapping + conformance) — a job stays bound to its provider, and the honest path to "another engine" is a *new* job.
5. **No new job statuses are required** — the existing 12-status machine (plus `NEEDS_ATTENTION`, already present) expresses all of the above. New capability is *behavior + API*, not new states.

## Rationale
- **The evidence-based rule is the whole point:** the single most expensive bug in a multi-engine, multi-account system is *double-submitting an op whose outcome is unknown* (duplicate notebooks, double-billed generations, orphaned artifacts). NLO already proved the correct behavior for podcasts (resume-never-resubmit); ADR-007 makes it the universal rule and adds the API + failover matrix around it.
- **Failover is scoped to what is safe:** switching is cheap *before* an external id exists and dangerous *after*. The matrix encodes exactly that boundary instead of a blanket "retry everything" or "retry nothing."
- **Manual retry gives operators the lever** the ecosystem (roomi v4.6.0 "retry without losing its id") shows users want — NLO achieves it structurally via `job_stages`, not by re-creating the job.

## Consequences
**Positive:** crash/timeout/restart recovery is evidence-based and uniform across providers; manual retry is safe and idempotent; failover is expressible and auditable (events `failover_node`/`failover_account`); no state-machine change (backward compatible).
**Negative / risks:** `NEEDS_ATTENTION` can accumulate (a backlog of unverifiable ops) — mitigated by surfacing it in `/api/health/ready`; the poll-before-anything rule adds an external round-trip on every post-crash resume (bounded, and it is the price of not double-submitting); cross-provider failover being deferred means "another engine" is a new job, not a transfer (honest, but an operator expectation to document).

## Alternatives considered
- **Blanket auto-retry on all non-auth failures:** rejected — double-submits unknown-outcome ops (duplicate external resources).
- **No manual retry (cancel + re-create the job):** rejected — loses the external-id resume property and the job identity users track; the ecosystem proves the demand.
- **Auto cross-provider failover in P4-4:** rejected — needs per-provider stage mapping + conformance parity (P4-7); doing it early would make a job's engine non-deterministic before the registry can prove equivalence.

## Evidence
- `RETRYABLE` map + backoff + `classifyError`: [`packages/shared/src/retry.ts`](../../../packages/shared/src/retry.ts) + `test/retry.test.ts`.
- Resume-never-resubmit (the proven core): `patchOperationIds` + `job_stages.external_operation_id` in [`apps/server/src/providers/python-worker/python-worker-provider.ts`](../../../apps/server/src/providers/python-worker/python-worker-provider.ts); `test/podcast-fault-recovery.test.ts`.
- Restart recovery: [`isRestartRecoverable`](../../../packages/shared/src/job-state.ts:64) + `test/worker-queue-recovery.test.ts`.
- State machine (unchanged): [`packages/shared/src/job-state.ts`](../../../packages/shared/src/job-state.ts).
- Ecosystem precedent (retry without losing id): [`NLO_PROVIDER_ECOSYSTEM_RESEARCH.md`](../../research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md) §3.5 (roomi v4.6.0).
