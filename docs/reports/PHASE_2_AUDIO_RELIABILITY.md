# Master Phase 2 — PROXY, SESSION AND REAL AUDIO RELIABILITY — Close-Out Report

- **Mission:** NLO-MASTER-2026-11, master Phase 2 (re-scoped label, see
  renumbering note below)
- **Close-out date:** 2026-11-09 (Asia/Tehran, UTC+3:30)
- **Scope of this close-out:** verify the three Phase 2 requirements
  (2.1 proxy reliability, 2.2 session lifecycle, 2.3 stage-specific audio
  errors + 12-stage pipeline) against the **actual code** at HEAD, close any
  small gaps, run the full verification suite, and consolidate the live
  evidence already gathered by the out-of-phase mission
  **NLO-PHASE-2-AUDIO-LIVE-2026-11** (2026-11-06→09 gap).
- **Headline result:** all three requirements are **SATISFIED — verified in
  code, no code changes made** (per AGENTS.md §1.3: working, live-verified
  capability is never rewritten without a test and a stated technical reason).
  The close-out is a verification + documentation deliverable.

> **Renumbering note.** The preflight working labels numbered "Phase 2 =
> Webhook infrastructure". The user's Phase 2 close-out brief re-scoped
> master Phase 2 as **Proxy, Session and Real Audio Reliability** (the
> substance already executed and LIVE-verified by the out-of-phase audio-live
> mission). This document follows the brief's numbering:
>
> | #   | Phase (close-out label)                              |
> | --- | ---------------------------------------------------- |
> | 2   | **Proxy, session and real audio reliability (THIS)** |
> | 3   | Unified text/audio workflow                          |
> | 4   | Deep Dive + audio conversion                         |
> | 5   | Webhooks + integration (blocker B8)                  |
> | 6   | Production deploy + verification                     |
> | F   | Final acceptance                                     |
>
> The webhooks work is **not dropped** — it is carried to master Phase 5
> (still PENDING, still needs B8).

---

## 1. Executive summary + live evidence pointer

| Requirement                                                                                                                                            | Verdict                                                                                         | Code change |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------- |
| 2.1 Proxy reliability (staged health check, no aggressive probe loop, failing nodes never selected, long-connection behavior documented)               | **SATISFIED — verified**                                                                        | none        |
| 2.2 Session lifecycle (10-min TTL characterized precisely; a job cannot start with an unverified/expired session)                                      | **SATISFIED — verified**                                                                        | none        |
| 2.3 Stage-specific audio errors (each stage failure distinguishable to the user) + 12-stage pipeline fully represented in code with SHA-256 on persist | **SATISFIED — verified** (via the task's own "distinct `error.code` **or stage field**" clause) | none        |

Live evidence (already recorded, not re-run): the one real audio job
**`j_367ea5baa8382e2ec42d7a29dcfe5b3b` SUCCEEDED in 50.2 s** against the real
NotebookLM service on local dev 4871, via proxy `france1`, with
`result_provenance="real"`. Full evidence:

- [`PHASE_2_AUDIO_LIVE_ACCEPTANCE.md`](PHASE_2_AUDIO_LIVE_ACCEPTANCE.md)
  (27-section final mission report, status `COMPLETE — LIVE AUDIO VERIFIED`)
- Stage reports [`PHASE_2_STAGE_0_BASELINE.md`](PHASE_2_STAGE_0_BASELINE.md)
  … [`PHASE_2_STAGE_5_REGRESSION.md`](PHASE_2_STAGE_5_REGRESSION.md)
- Reconciliation 2026-11-09 (DB row re-verified field-by-field):
  [`NLO_MASTER_EXECUTION_STATUS.md`](NLO_MASTER_EXECUTION_STATUS.md) §4

This report **consolidates, not duplicates**: per-requirement verification is
documented here with file/line references; the live evidence table in §5
pointers to the Stage 4/5 reports rather than re-quoting them in full.

Verification level (honest): **Unit/Integration/E2E-mock re-run green on
2026-11-09** + **LIVE-verified** claims rest on the recorded 2026-11-06 run
(DB row, backup, worker log, running dev server). No new live work was
performed in this close-out (mandate: no live jobs, no prod contact).

---

## 2. Requirement 2.1 — Proxy reliability (per-node audit)

**Verdict: SATISFIED.** Audited at
[`apps/server/src/proxy/proxy-manager.ts`](../../apps/server/src/proxy/proxy-manager.ts),
[`apps/server/src/proxy/runtime.ts`](../../apps/server/src/proxy/runtime.ts),
[`apps/server/src/proxy/connect-proxy.ts`](../../apps/server/src/proxy/connect-proxy.ts),
[`apps/server/src/proxy/egress.ts`](../../apps/server/src/proxy/egress.ts).

### 2.1 Staged health check exists (one bounded check per candidate)

`ProxyManager.runHealthCheck` (proxy-manager.ts:272–417) performs a staged
check, stopping at the first failing stage and persisting a categorized
verdict (`config | runtime | listener | egress | nbl_access | tls |
upstream`):

1. **SSRF guard** — `assertSafe(dest)` (proxy-manager.ts:445–461) resolves
   the destination and blocks private/loopback targets
   (`packages/shared/src/ssrf.ts`);
2. **Config validation** — `validateConfig` (proxy-manager.ts:420–439):
   vless URI parses, node reachable shape;
3. **Runtime check** — xray runtime present/available (`runtime.ts`);
4. **Tunnel start** — loopback CONNECT listener up;
5. **Real traffic** — an actual HTTPS CONNECT + TLS + HTTP fetch through the
   tunnel to the destination (the check exercises the same path a real job
   uses, not just TCP).

The result is persisted to `proxy_health` with `last_checked_at`,
`healthy`, and the failure category/reason.

### 2.1 It is NOT an aggressive probe loop

- No periodic probe loop exists anywhere in the proxy code (verified by
  reading `proxy-manager.ts`, `runtime.ts`, `queue.ts` — the only health
  invocations are the explicit on-demand paths below).
- Health is re-checked **on demand** with a 10-minute freshness TTL
  (proxy-manager.ts:79): if `last_checked_at` is fresher than 10 min and
  healthy, the cached verdict is used.
- Self-heal is bounded: when a cached-healthy node turns out to be stale,
  selection triggers self-heal with **at most 12 candidates** and a **3000 ms
  latency cap** (`SELF_HEAL_MAX_CANDIDATES`, `SELF_HEAL_MAX_LATENCY_MS`) —
  i.e. one check per candidate, best-first, first success wins.
- The deliberate **single-probe** design is documented in `runtime.ts`: a
  second immediate connection to a shared node was measured to trigger TLS
  resets because shared VLESS nodes rate-limit rapid connections. The code
  therefore never re-probes a node more often than the 10-min TTL + on-demand
  self-heal caps allow.

### 2.1 Failing nodes are never selected

- Selection (`select`/`selectAuto`, proxy-manager.ts:92–262) considers only
  nodes whose health verdict is fresh-and-healthy; every rejected candidate
  is recorded with a reason, and each rejection is also emitted as a
  `proxy_candidate_rejected` job event
  ([`apps/server/src/queue/job-runner.ts:252–258`](../../apps/server/src/queue/job-runner.ts:252))
  — this is exactly what the live run showed (`England_1: read ECONNRESET`).
- **Fail-closed:** if no node is selectable, `selectAuto` rejects and the job
  runner fails it with `errorClass:"proxy"` + `proxy_unavailable` event
  (job-runner.ts:260–275); the provider separately refuses to run a job with
  no tunnel (`python-worker-provider.ts` `runJob` pre-check: `"no approved
proxy tunnel for this job (fail-closed…)"`, failureClass `proxy`). Direct
  egress without a verified tunnel is blocked at the egress boundary
  (`DirectEgressBlockedError`, [`egress.ts:15`](../../apps/server/src/proxy/egress.ts:15)).
  Covering test: `fail-closed.test.ts` (17 tests, green 2026-11-09).

### 2.1 Per-node results (live, 2026-11-06 — from Stage 3 report, re-confirmed against the DB)

| Node                                             | Staged health check                         | Live evidence                                                                                                     | Status at close-out                                          |
| ------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **france1-SeyedSaber** (`node_23e81d9a6ca04d10`) | **PASS** (771 ms, 2026-11-06)               | Carried the real 50.2 s audio job (notebook create + source upload + `wait_until_ready` + prompt) over the tunnel | Healthy, **live-verified**                                   |
| **England_1** (`node_1e238ac8aed440cb`)          | **FAIL — `read ECONNRESET`** (egress stage) | Rejected by the selector during the live run (`proxy_candidate_rejected` event) — never used, never harmed        | **OPEN (B2 leg)** — needs a fresh/working node from the user |

**Long-connection behavior (documented, not re-proven):** the 50.2 s job
proves a ~50 s held CONNECT+TLS session works. The **15–17 min long-hold**
failure mode from the preflight P0 audit was **not reproduced** and is
**not claimed fixed** (honest caveat, carried to Phase 3/6). The tunnel is
re-established per provider op (per job), which bounds exposure: a dropped
session surfaces as a classified worker error (`connectivity`/`timeout`),
never as a silent success.

**Gap carried forward (non-blocking):** no per-node _long-session_ stability
metric exists (health check is a ~15 s single fetch). Adding one is
explicitly deferred — do not re-architect the proven path.

---

## 3. Requirement 2.2 — Session lifecycle (TTL + gate)

**Verdict: SATISFIED.** Audited at
[`apps/server/src/domain/auth-sessions.repo.ts`](../../apps/server/src/domain/auth-sessions.repo.ts),
[`apps/server/src/api/routes/sessions.ts`](../../apps/server/src/api/routes/sessions.ts),
[`apps/server/src/queue/job-runner.ts`](../../apps/server/src/queue/job-runner.ts:389),
`apps/server/test/session-gate.test.ts`.

### 3.1 What the 10-minute TTL actually is (precise characterization)

The 10 minutes is a **cached-eligibility TTL, not a credential expiry**:

- `AuthSessionsRepo.isUsable(session, ttlMs = 10 * 60 * 1000)`
  (auth-sessions.repo.ts:131–136) returns true only when the session state is
  `AUTHENTICATED` **and** `lastVerifiedAt` is within 10 minutes.
- `lastVerifiedAt` is set when a session is **verified against the real
  service** (e.g. the Stage 2 official re-verify: `ok:true, "verified
against service (453 notebooks)"`). It is a freshness stamp on _verified
  eligibility_, not a token TTL.
- The cache is invalidated earlier than the TTL by any state transition
  (`transition()`, auth-sessions.repo.ts:100–128): failed verify →
  `AUTH_REQUIRED`, mismatch → `SESSION_INVALID`, re-auth → fresh
  `AUTHENTICATED` with a new `lastVerifiedAt`.
- **True credential expiry** surfaces differently: at the next re-verify the
  real service rejects the session (`session rejected by service`) and the
  account transitions to `AUTH_REQUIRED` (Stage 2 report §2 documents exactly
  this path). The 10-min TTL never masks an expired credential for more than
  10 minutes, and a job attempt itself re-validates via the worker (`op_verify`
  path in `python-worker-provider.ts getAccountStatus`).
- `eligibleAccountIds(ttlMs)` (auth-sessions.repo.ts:143–149) is the single
  source of truth used by the queue.

### 3.2 A job CANNOT start with an unverified/expired session (pre-provider gate)

The gate sits **before any provider work**, at queue pickup:

1. Job transitions `QUEUED → WAITING_FOR_ACCOUNT`;
2. `JobRunner.selectAccount` (job-runner.ts:389–442) reads
   `sessions.eligibleAccountIds()` — **verified sessions are the only
   source of truth** (no DB flag, no "configured" flag can pass);
3. Outcomes, all **before** `WAITING_FOR_PROXY`/`RUNNING` and before any
   tunnel/provider call:
   - no eligible account → job FAILED `errorClass:"auth"`,
     `"no eligible google account with a verified session"`, event
     `no_account`;
   - strictly-preferred account unusable → FAILED `errorClass:"auth"`,
     `"requested account "X" is not usable: session not verified
(re-authentication required)"` — **never silently switches** to another
     account, event `no_account`;
4. On each retry loop iteration the account (and proxy) are **re-selected**,
   so a session that expires mid-flight cannot be reused on a retry.

This is **live-proven twice over**: (a) the 2026-11-06 run's mission-target
error `no eligible google account…` was the gate fast-failing a job in
**26 ms** before a stale session could be used (Stage 2/4 reports); (b)
`session-gate.test.ts` (6 tests, green 2026-11-09) covers: no-verified
session → auth failure; verified session → SUCCEEDED; **stale (expired)
verification ignored — "a DB flag is not evidence"**; strict preferred
account behavior; default-account preference.

### 3.3 Sync session routes (context)

`routes/sessions.ts` — login failure → `AUTH_REQUIRED` + `unauthorized` 401;
identity mismatch → `SESSION_INVALID` + `conflict` 409; concurrent login
attempts → `conflict` 409 (in-flight guard); successful verify →
`transition AUTHENTICATED` with `verified:true` (clears stale
`AUTH_REQUIRED`/`UNKNOWN`). Sessions are stored as `0600` files under
`0700` dirs (AGENTS.md §7 invariant, verified in `auth-sessions.repo.ts` /
`nbl_worker.py _secure_write`).

**No gap found. No code change.**

---

## 4. Requirement 2.3 — Stage-specific audio errors + 12-stage pipeline

**Verdict: SATISFIED via the brief's own alternative** ("does each stage
failure produce a distinct `error.code` **(or stage field)**"). No code
change; the reasoning is recorded here so the decision is auditable.

### 4.1 Why the requirement is already met (two-layer error model)

NLO has two error planes, matched to when failures happen:

1. **Synchronous request failures** (upload, text create, session ops) →
   the HTTP error envelope `{ "error": { "code", "message" } }` with
   `ApiCodes` from [`packages/shared/src/api-error.ts`](../../packages/shared/src/api-error.ts).
2. **Asynchronous job-execution failures** (notebook/source/prompt stages)
   → the job row + typed job events: `errorClass` (one of
   `auth | rate_limit | invalid_input | connectivity | proxy | provider |
ambiguous | unknown`, from
   [`packages/shared/src/retry.ts`](../../packages/shared/src/retry.ts) +
   [`packages/shared/src/job-state.ts`](../../packages/shared/src/job-state.ts)),
   `errorMessage` (redacted), `job_events` with stable event types
   (`validation_failed`, `no_account`, `proxy_unavailable`,
   `proxy_candidate_rejected`, `retry_scheduled`, `needs_attention`,
   `failed`, `cancelled`, `succeeded`), `job_attempts` rows with
   `{failureClass, message, nextDelayMs?}` — and **the stage field
   `jobs.progress_note`**, which carries the **worker stage key** at the
   moment of failure (below).

`ApiCodes` are HTTP envelope codes for _request_ errors; worker sub-stage
failures happen minutes after the 201 response, so an HTTP `error.code` per
sub-stage is architecturally inapplicable. Adding schema columns/new enums
would re-architect live-verified code for zero observable benefit — the
stage is already distinguishable (next section). Per AGENTS.md §1.3 and the
brief's own "if a requirement is already satisfied, verify and document —
do not rewrite working code", **no code change was made**.

_Candidate Phase 3 refinement (non-blocking, recorded for handoff):_ promote
the worker's stable stage keys from free-text `progressNote` to a stable
machine-readable stage enum on the job row/events, for API consumers who want
to branch on stage programmatically.

### 4.2 The stage field: how a failed stage is distinguishable to the user

The Python worker emits a **stable stage key on every progress event**
([`apps/server/src/providers/python-worker/nbl_worker.py`](../../apps/server/src/providers/python-worker/nbl_worker.py),
`op_job` / `op_job_text`):

```
opening_session → selecting_notebook → [notebook_created] →
[uploading_audio → upload_done | source_reused] →
waiting_for_processing → processing_done → executing_prompt → prompt_done
```

The provider maps these to persisted progress
([`apps/server/src/providers/python-worker/python-worker-provider.ts:449–453`](../../apps/server/src/providers/python-worker/python-worker-provider.ts:449)
`stageProgress`):

| Worker stage key             | `jobs.progress` | `jobs.progress_note` (the stage field)   |
| ---------------------------- | --------------- | ---------------------------------------- |
| `opening_session`            | 10              | opening authenticated session            |
| `selecting_notebook`         | 20              | selecting/creating notebook              |
| `notebook_created`           | — (event only)  | —                                        |
| `uploading_audio`            | 30              | uploading audio to NotebookLM            |
| `upload_done`                | 50              | upload complete                          |
| `source_reused`              | — (event only)  | —                                        |
| `adding_text` / `text_added` | 30 / 50         | adding text source / text source added   |
| `waiting_for_processing`     | 55              | waiting for NotebookLM to process source |
| `processing_done`            | 75              | source processed                         |
| `executing_prompt`           | 80              | executing prompt                         |
| `prompt_done`                | 95              | prompt completed                         |

Each `onProgress` lands in `jobs.setProgress()`
([`apps/server/src/domain/jobs.repo.ts:134`](../../apps/server/src/domain/jobs.repo.ts:134))
**in real time** — so when a job fails, `progress_note` still holds the
**last completed/entered stage**, and `setStatus` to FAILED preserves it
(`setStatus` only overwrites fields present in the patch —
jobs.repo.ts:77–123). The failed job therefore exposes, via
`GET /api/jobs/:id`: `status:"FAILED"`, `errorClass` (failure _nature_),
`errorMessage` (redacted detail), `progress` + `progress_note` (failure
_stage_), plus the `failed`/`needs_attention`/`retry_scheduled` event with
message `"{failureClass}: {message}"`. Stage + nature = full distinction.

### 4.3 Error-stage matrix (every failure site → what the user sees)

| Stage (user-facing)                                                          | Failure example                                                                              | Distinguishing signal(s)                                                                                                                                                                                                                                                                                                                                                                                  | Code site                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Upload** (sync multipart)                                                  | bad extension / size 0 / missing prompt / over size limit                                    | `validation_error` 400 (with `details` e.g. `{maxTextChars, charCount}`) / 413 size; `not_found` 404 unknown preferred account; `conflict` 409; Idempotency-Key regex fail → `validation_error` 400                                                                                                                                                                                                       | [`apps/server/src/api/job-create.ts`](../../apps/server/src/api/job-create.ts) `parseJobMultipart` + `createJobFromUpload`; [`job-create-text.ts`](../../apps/server/src/api/job-create-text.ts:34)                                                                                                    |
| **Validation** (runner)                                                      | empty prompt (audio job), archive init failure                                               | job FAILED `errorClass:"invalid_input"`, message `"prompt is empty"` / archive message, event `validation_failed`                                                                                                                                                                                                                                                                                         | [`job-runner.ts:331–373`](../../apps/server/src/queue/job-runner.ts:331) `validate()`                                                                                                                                                                                                                  |
| **Authentication** (session gate)                                            | no verified session / preferred account unusable / login fail / identity mismatch            | job FAILED `errorClass:"auth"` + `"no eligible google account with a verified session"` or `"requested account … not usable: session not verified (re-authentication required)"` + event `no_account`; account → `AUTH_REQUIRED`; sync routes: `unauthorized` 401 (login fail), `conflict` 409 (mismatch/in-flight)                                                                                       | [`job-runner.ts:389–442`](../../apps/server/src/queue/job-runner.ts:389); [`routes/sessions.ts`](../../apps/server/src/api/routes/sessions.ts)                                                                                                                                                         |
| **Proxy** (tunnel selection)                                                 | no approved route (fail-closed) / candidate rejected                                         | job FAILED `errorClass:"proxy"` + `"no approved proxy route available (fail-closed): …"` + event `proxy_unavailable`; per-candidate `proxy_candidate_rejected` events (`node X: reason`); provider-level `proxy` failureClass `"no approved proxy tunnel for this job (fail-closed…)"`                                                                                                                    | [`job-runner.ts:236–275`](../../apps/server/src/queue/job-runner.ts:236); [`python-worker-provider.ts`](../../apps/server/src/providers/python-worker/python-worker-provider.ts) `runJob` pre-checks; `fail-closed.test.ts` (17 tests)                                                                 |
| **Notebook creation / Source upload / Prompt execution** (worker sub-stages) | auth dropped mid-job, rate limit, network reset, timeout, provider 5xx, ambiguous completion | `errorClass` from the worker's classified code (protocol ErrorPayload: `auth, rate_limit, timeout, connectivity, invalid_input, not_found, ambiguous, configuration, provider, provider_unavailable, protocol, unknown` → `toFailureClass`); **stage = `progress_note`** (table above) + `failed`/`retry_scheduled`/`needs_attention` event message `"{failureClass}: {message}"` + `job_attempts` detail | [`nbl_worker.py` `op_job`/`_classify`](../../apps/server/src/providers/python-worker/nbl_worker.py:73); [`protocol.ts`](../../apps/server/src/providers/python-worker/protocol.ts); [`python-worker-provider.ts:104–124`](../../apps/server/src/providers/python-worker/python-worker-provider.ts:104) |
| **Retry / ambiguity policy**                                                 | retryable vs not; ambiguous completion                                                       | `RETRYABLE = {auth:✗, rate_limit:✓, invalid_input:✗, connectivity:✓, proxy:✓, provider:✓, ambiguous:✗, unknown:✗}`; ambiguous/timeout → **never** auto-retried → `NEEDS_ATTENTION`; attempts exhausted → `FAILED`; backoff full-jitter (2 s base, 300 s cap)                                                                                                                                              | [`packages/shared/src/retry.ts`](../../packages/shared/src/retry.ts); [`job-runner.ts:450–550`](../../apps/server/src/queue/job-runner.ts:450) `handleFailure`                                                                                                                                         |
| **Empty-answer guard** (result integrity)                                    | provider returns an empty answer                                                             | `ProviderFailure {failureClass:"provider", ambiguous:true, "provider returned an empty answer; not reporting success"}` — **never reported as successful**                                                                                                                                                                                                                                                | [`python-worker-provider.ts:524–536`](../../apps/server/src/providers/python-worker/python-worker-provider.ts:524)                                                                                                                                                                                     |
| **Artifact generation / retrieval**                                          | n/a — **not live stages**                                                                    | `capabilities().retrieveArtifacts = "unsupported"` (honest: "chat answers are text; no downloadable artifacts in this workflow"); real provider always returns `artifacts: []` — **never fabricated**. Deep Dive generation is master Phase 4 (blocker B9).                                                                                                                                               | [`python-worker-provider.ts:187–207`](../../apps/server/src/providers/python-worker/python-worker-provider.ts:187) `capabilities()`; [`providers/types.ts`](../../apps/server/src/providers/types.ts) `ProviderJobResult.artifacts` ("Application must not fabricate")                                 |

Mock parity: `mock-provider.ts` emits the same `onProgress` shape
(`"mock: validating request" → "mock: uploading audio source" → "mock:
indexing source" → "mock: asking question" → "mock: collecting artifacts" →
"mock: done"`) and scenario-based `ProviderFailure`s (auth 401
`needsReauth`, transient provider 500, ambiguous) — the same matrix is
exercised at mock level in `job-lifecycle.test.ts`, `fail-closed.test.ts`,
`session-gate.test.ts` (all green 2026-11-09).

### 4.4 The 12-stage audio pipeline → code (every stage represented; SHA-256 recorded on persist)

| #   | Stage (per brief)                                                                       | Code location                                                                                                                                                                                                                                                                                     | Evidence it is real                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Account selection (eligibility gate)                                                    | `selectAccount` — [`job-runner.ts:389`](../../apps/server/src/queue/job-runner.ts:389)                                                                                                                                                                                                            | live: `account_selected` event; `acc_315776aeb5b74e33` in the live job row                                                             |
| 2   | Browser/session validation (real service)                                               | `routes/sessions.ts` `verifyAccount` → provider `getAccountStatus` → worker `op_verify` via tunnel (nbl_worker.py:176–189)                                                                                                                                                                        | live: Stage 2 official re-verify `ok:true, "verified against service (453 notebooks)"`                                                 |
| 3   | Multipart upload parse                                                                  | `parseJobMultipart` — [`job-create.ts:28`](../../apps/server/src/api/job-create.ts:28)                                                                                                                                                                                                            | live: `POST /api/jobs` 201 for the MP3                                                                                                 |
| 4   | Persist to job archive (audio stored, rollback on failure)                              | `createJobFromUpload` — [`job-create.ts:75`](../../apps/server/src/api/job-create.ts:75) (archive.init + storeAudio, rollback on error)                                                                                                                                                           | live: audio file present under the job archive; DB `input_json`                                                                        |
| 5   | **SHA-256 computed and recorded on persist**                                            | audio: `sha256OfFile(tempPath)` → `input_json.audio.sha256` in `job-create.ts`; text: `createHash("sha256")` → `input.text.sha256` in [`job-create-text.ts:99`](../../apps/server/src/api/job-create-text.ts:99)                                                                                  | **live byte-identical:** `85de5f0a24c5219112e13e382de646795fb716e1b22891dfe73becd77620748a` in the request matches the DB `input_json` |
| 6   | Job created + queued                                                                    | `ctx.jobs.create` → queue pickup (`queue.ts`, `JobRunner.run` CREATED→VALIDATING→QUEUED)                                                                                                                                                                                                          | live: job row `j_367ea5baa8382e2ec42d7a29dcfe5b3b`, events `created`/`validate`                                                        |
| 7   | Account (execution-time re-check)                                                       | `selectAccount` again at queue pickup (re-evaluates `eligibleAccountIds()`; retry loop re-selects)                                                                                                                                                                                                | live: fast-fail 26 ms case in Stage 2/4 + `session-gate.test.ts`                                                                       |
| 8   | Proxy selection + tunnel                                                                | `selectAuto` in WAITING_FOR_PROXY (`job-runner.ts:236`) → `tunnelEnv` (HTTP(S)_PROXY/ALL_PROXY + NO_PROXY)                                                                                                                                                                                        | live: `proxy_selected` event `node france1…`; `proxy_candidate_rejected` for England_1                                                 |
| 9   | Source received by NotebookLM (session open, notebook create/reuse, idempotency anchor) | worker `op_job` (nbl_worker.py:403–500): audio file check → `opening_session` → `get_account_email(live_fallback=True)` → `selecting_notebook` → `notebooks.list()` reuse-by-title or `notebooks.create(title)` (+ `notebook_created` event) → `sources.list()` reuse anchor (+ `source_reused`)  | live: notebook `19f65354-8641-446e-8987-84da22187a9c` created                                                                          |
| 10  | Source ID obtained + processing wait                                                    | `uploading_audio` → `sources.add_file(notebook_id, audio_path)` → `upload_done` (sourceId) → **explicit RuntimeError if no source id** ("audio upload reported success but returned no source id…") → `waiting_for_processing` → `sources.wait_until_ready(timeout=wait_sec)` → `processing_done` | live: source `97c79146-a8a6-4739-a317-3cf0391eca2b`, `uploaded:true`                                                                   |
| 11  | Prompt execution                                                                        | `executing_prompt` → `chat.ask(notebook_id, prompt, source_ids=[source_id])` → `prompt_done`                                                                                                                                                                                                      | live: conversation `0facdc26-077e-47fe-8525-7aba84771308`, turn 1, 653-char Persian answer                                             |
| 12  | Result persisted                                                                        | success path (`job-runner.ts:200–285`): artifacts stored (none from real provider), `recordAttempt ok`, `setStatus SUCCEEDED {answerMarkdown, resultProviderMeta, progress:100, resultProvenance:"real", notebookId, notebookTitle, sourceId, conversationId}`, event `succeeded`                 | live: DB row SUCCEEDED/100, `result_provenance="real"`, `simulated:false` in `result_provider_meta_json`                               |

**Pipeline integrity invariants verified:** settle-once worker protocol
(Phase 1 fix `87f964b`; JSON-line stdio, pure-ASCII frames); empty-answer
guard (§4.3); cancel-race check before success persistence (a cancelled job
never becomes SUCCEEDED); restart recovery of in-flight jobs
(`recoverInFlight`, jobs.repo.ts:300; `worker-queue-recovery.test.ts` 4
tests).

---

## 5. Live acceptance evidence (LIVE — recorded 2026-11-06, re-verified 2026-11-09)

**Verification level: LIVE** (real Google account, real VLESS egress, real
NotebookLM service, local dev 4871). Not re-run in this close-out (mandate:
no new live work). Source-of-truth record:
[`PHASE_2_STAGE_4_AUDIO_LIVE_ACCEPTANCE.md`](PHASE_2_STAGE_4_AUDIO_LIVE_ACCEPTANCE.md)

- DB re-read during the 2026-11-09 reconciliation.

| Field                            | Value                                                                                                                                                                                                        | Verified                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Job                              | `j_367ea5baa8382e2ec42d7a29dcfe5b3b`                                                                                                                                                                         | DB row (2026-11-09 re-read)               |
| Outcome                          | SUCCEEDED, progress 100, **50.2 s** (23:15:22.803Z → 23:16:13.040Z), attempt 1 `ok`                                                                                                                          | DB row + 7 `job_events`                   |
| Provenance                       | `result_provenance="real"`; `simulated:false`; `provider:"python-worker"`; `sourceKind:"audio"`; turn 1                                                                                                      | `result_provider_meta_json`               |
| Notebook / source / conversation | `19f65354-8641-446e-8987-84da22187a9c` / `97c79146-a8a6-4739-a317-3cf0391eca2b` / `0facdc26-077e-47fe-8525-7aba84771308`                                                                                     | DB row, byte-identical to report          |
| Route                            | account `acc_315776aeb5b74e33` via proxy `node_23e81d9a6ca04d10` (france1); England_1 rejected (`ECONNRESET`)                                                                                                | DB row + `proxy_candidate_rejected` event |
| Input integrity                  | MP3 720,429 B, SHA-256 `85de5f0a…0748a` — request hash **byte-identical** to `input_json.audio.sha256` (persist-time hash, §4.4 row 5)                                                                       | DB `input_json`                           |
| Answer                           | 653-char verbatim Persian transcript in `answer_markdown`                                                                                                                                                    | DB row                                    |
| Session at submission            | fresh official re-verify (real service, 453 notebooks) — gate satisfied (§3)                                                                                                                                 | Stage 2 report §6                         |
| Anti-mock guarantees             | worker meta `simulated:false`; no mock provider in the 4871 config; worker log trail with correlation `job:j_367ea…5b3b`; Stage 0 DB backup on disk (`data/backups/nlo-pre-phase2-2026-11-06T20-18Z.sqlite`) | Stage 4 §13/§23 + Stage 0                 |
| UI visibility                    | job + transcript visible in the Web UI data feed                                                                                                                                                             | Stage 4 §6                                |

Honest caveats (unchanged from the acceptance report): the P0 **15–17 min
long-hold** failure mode was not reproduced (not claimed fixed); MP3 is not
in the provider's verified extension label list (label stays `.wav`);
audio-file content was never printed or committed.

---

## 6. Regression — before / after (full verification, 2026-11-09)

All suites re-run fresh at the repo root, Node v24.14.0, **with zero code
changes since baseline `d90bb42`**:

| Suite     | Command                | Baseline (2026-11-06 Stage 5) | This close-out (2026-11-09)                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck | `npm run typecheck`    | PASS                          | **PASS** (shared/server/web `tsc` clean, exit 0)                                                                                                                                                                                                                                                                             |
| Lint      | `npm run lint`         | PASS                          | **PASS** (`eslint .` clean, exit 0)                                                                                                                                                                                                                                                                                          |
| Format    | `npm run format:check` | PASS                          | **PASS** (all files Prettier-clean)                                                                                                                                                                                                                                                                                          |
| Tests     | `npm test`             | 227/227                       | **PASS — 227/227, 0 failed**: `@nlo/shared` 7 files / 53 tests; `@nlo/server` 14 files / 144 tests (incl. `session-gate` 6, `fail-closed` 17, `job-lifecycle` 12, `from-text` 11, `api` 16, `openapi-v1` 30, `worker-supervisor` 10, `worker-queue-recovery` 4, `worker-nonascii-protocol` 1); `@nlo/web` 4 files / 30 tests |
| Build     | `npm run build`        | PASS                          | **PASS** (web `tsc` + `vite build`, 1853 modules)                                                                                                                                                                                                                                                                            |

**Delta: 0 tests added, 0 removed, 0 failures.** Expected — no code changed.

---

## 7. Remaining gaps + Phase 3 handoff

| Gap                                                                                                                                                                                                     | Status                                                          | Owner                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| **G1 — No per-node long-session stability metric.** Health check proves a ~15 s held session; the preflight P0 15–17 min hold was not re-tested (50 s live-proven only).                                | OPEN — non-blocking; do not re-architect the proven tunnel path | Phase 3/6 (measure, don't rebuild)             |
| **G2 — Stage is free-text (`progress_note`), not a machine-readable enum.** §4.1 candidate refinement: stable stage enum on job row/events for API consumers.                                           | OPEN — non-blocking (stage IS currently distinguishable)        | Phase 3 (with the unified text/audio workflow) |
| **G3 — B8 webhook destination + shared secret not provided.** Webhooks implementation + live verification.                                                                                              | OPEN — user input required                                      | master **Phase 5**                             |
| **G4 — B9 Deep Dive audio-overview generation unverified** against real NotebookLM (the live job proved audio→text transcription — a different capability). `retrieveArtifacts` honestly `unsupported`. | OPEN — live spike gate                                          | master **Phase 4**                             |
| **G5 — B6 FFmpeg absent locally** (`where ffmpeg` → not found, re-checked 2026-11-09); no conversion code exists.                                                                                       | OPEN                                                            | master **Phase 4**                             |
| **G6 — England_1 node failing** (`read ECONNRESET`, last checked 2026-11-06). france1 is healthy + live-verified and remains the sole usable local node.                                                | OPEN (B2 leg) — needs fresh/working node from user              | user input; re-check in Phase 3/6              |
| **G7 — Prod is behind.** `172.30.0.133` last verified at `d705634`, 7 commits behind `origin/main` (incl. the Phase 1 worker fix). No prod contact in this close-out (mandate).                         | OPEN                                                            | master **Phase 6** (B5 sudo gate)              |
| **G8 — GitLab mirror inactive / stale** (B3/B4); no `gh` CLI (B10); LiteLLM key rotation still a user action (B7).                                                                                      | OPEN                                                            | carried, unchanged                             |

**Phase 3 handoff ("Unified text/audio workflow", deliverable
`docs/reports/PHASE_3_UNIFIED_INPUT_AND_NOTEBOOK.md`):**

- The 12-stage pipeline (§4.4) is the reference architecture; G2's stage
  enum should land with the unified workflow so both input kinds share it.
- `op_job` / `op_job_text` in `nbl_worker.py` are the two entry points to
  unify; both already share the stage-key vocabulary and error taxonomy.
- G1 (long-hold metric) is the natural Phase 3 stability workstream —
  measure with an instrumented live run, keep the fail-closed +
  classified-retry machinery as-is.
- B9/G4 and G5 live in Phase 4 (Deep Dive + conversion); B8/G3 in Phase 5.

---

## 8. Commits, changed files, and verification levels (honest)

**Code changes in this close-out: NONE.** (No `src/` file modified; the
verification mandate found the requirements already satisfied — see §4.1 for
the explicit no-change decision and its rationale.)

**Changed files in this close-out (docs only):**

| File                                                                            | Change                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/reports/PHASE_2_AUDIO_RELIABILITY.md`                                     | **new** — this close-out report                                                                                                                                                                                                 |
| `docs/reports/NLO_MASTER_EXECUTION_STATUS.md`                                   | phase table re-scoped + Phase 2 → VERIFIED-COMPLETED (close-out 2026-11-09); reconciliation row appended; Next action → Phase 3 (Unified text/audio workflow, deliverable `docs/reports/PHASE_3_UNIFIED_INPUT_AND_NOTEBOOK.md`) |
| `docs/ROADMAP_MASTER.md`                                                        | "Current position" header updated to the close-out                                                                                                                                                                              |
| `CHANGELOG.md`                                                                  | docs-only close-out entry (no user-visible behavior changed)                                                                                                                                                                    |
| `docs/reports/NLO_MASTER_EXECUTION_STATUS.md` (pre-existing uncommitted change) | the Reconciliation 2026-11-09 section, committed first as its own docs commit                                                                                                                                                   |

**Verification levels honestly stated:**

- **Unit/Integration/E2E-mock: PASS** — full suite re-run 2026-11-09
  (227/227; typecheck/lint/format/build clean). This proves the code as
  committed is green; it does **not** prove live NotebookLM behavior.
- **LIVE-verified (recorded evidence, not re-run):** the single audio job of
  §5 (real service, `provenance:"real"`), the Stage 2 real-service
  re-verify, and the france1 live carry.
- **Not tested / not claimed:** 15–17 min long-hold hold-up behavior
  (G1); Deep Dive overview generation (G4); MP3 56 kbps conversion (G5);
  webhooks (G3); any production-host behavior (no prod contact).

**Git:** two docs commits on `main` (reconciliation docs first, then this
report + tracking-doc updates), secret-scanned, fast-forward push to
`origin/main` (GitHub = source of truth), `local HEAD == origin/main`
verified after push. No force-push, no `git add -A`, no deletions, no
prod contact, no live jobs — per close-out rules.
