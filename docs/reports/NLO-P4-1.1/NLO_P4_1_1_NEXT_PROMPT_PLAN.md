# NLO-P4-1.1 — Next-Prompt Plan (P4-2 … P4-8)

- **Purpose:** hand the owner a set of copy-pasteable prompts for the next product phases.
  Each prompt is **independently deliverable** (has its own acceptance criteria, needs no
  other phase's output to start, and ends with a phase report per AGENTS.md §9).
- **Numbering decision (resolves F-BL-02 / BL-P2-7):** the **owner's mission numbering is
  canonical**: P4-2 intake/templates, P4-3 sessions, P4-4 failover, P4-5 MCP, P4-6 retry UI,
  P4-7 webhooks/delivery, P4-8 live acceptance. The in-repo docs
  (`NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md`, `NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`) carry an
  older split (retry inside P4-4, MCP server P4-6, MCP client P4-7) and **must be updated to
  this numbering** — that doc edit is the first step of the P4-2 prompt below (no new backlog
  item needed; it is BL-P2-7).
- **Pre-work vs phases:** BL-P0-1 (production re-deploy), BL-P1-2 (local venv), BL-P1-6/7
  (SSH + host prereqs) are **pre-work, not blockers for P4-2 code** — they gate P4-8 (live
  acceptance) and any staging/production claim, and can run in parallel with P4-2.
- **Order recommendation:** P4-2 → P4-3 → P4-4 → P4-5 → P4-6 → P4-7 → P4-8. Deviations are
  documented per phase below (e.g. P4-5 MCP may slip after P4-6 if the owner prefers the
  recovery UI first — nothing in P4-6 depends on MCP).
- **Model assignments (rationale in §assignments):** DeepSeek = contract/design-heavy
  surfaces; Qwen = infra/ops/mechanical. All phases follow the same rules: AGENTS.md §3
  (tests proportional to risk, docs + CHANGELOG, OpenAPI if the API changes), mock-level
  CI, live gates manual.

---

## Pre-work prompts (ops track — run in parallel with P4-2, before P4-8)

### Prompt PW-1 — Production re-deploy session on 172.30.0.133 (backlog BL-P0-1, BL-P1-6, BL-P1-7)

```
NLO-DEPLOY-133 — Re-deploy NLO on the new production host (172.30.0.133), staging-first.

Inputs from the owner (request exactly these):
1. SSH access (user + key/credential) for 172.30.0.133, read scope first.
2. Whether s52's data/ (DB, vault.key, vendor/xray, sessions, backups) was migrated;
   if not, locate the latest backup source.
3. Confirmation that /home/saber (or the target user/layout) and Node 22 exist or where they are.

Scope (all owner-approved production changes; no other changes):
- Host inventory (read-only): systemd state, paths, disk, git clone presence, data/ contents.
- data/ migration/restore if needed (DB restore from backups, vault.key, vendor/xray,
  3 session storage-states) — with a backup taken BEFORE any move.
- Correct deploy/systemd/nlo.service paths for this host (commit that change on main first).
- Run deploy/deploy.sh (git-based; only origin/main-ancestor commits; it backs up DB + .env,
  verifies health/ready/port/journal, records data/deployed-commit).
- Staging vhost: nlo2.ai.ismc.ir with deploy/nginx/nlo-vhost.stageA.conf.tpl (plain HTTP first).
- Optional in this session: docker build verification (BL-P2-6) if a daemon exists.

Acceptance criteria:
- https://nlo2.ai.ismc.ir/api/health → {"ok":true} and /api/health/ready → "ready":true.
- systemctl status nlo active; journal clean since restart; data/deployed-commit written.
- DB row counts match migrated source (accounts >= 3, proxy nodes present).
- ROLLBACK dry-run (NLO_DEPLOY_DRY_RUN=1) succeeds; previous-good commit recorded.
- Phase report in docs/reports/ with evidence, changed files, commits, limitations.

Non-goals: TLS/stageB (needs cert), production domain cutover (separate approval),
any P4 code change.
```

**Model:** Qwen · **Owner approval:** YES (production session) · **Parallelizable:** with P4-2.

### Prompt PW-2 — Local live-path repair (backlog BL-P1-2, BL-P3-2, BL-P3-7)

```
NLO-LOCAL-FIX-1 — Repair the local python worker venv (0xC0000006 spawn failure).

Scope (workstation only, no repo code change expected):
- Rebuild data/venv per docs/deployment/s52-deploy.md first-time-setup (pinned Python,
  pip install -r apps/server/python-requirements.txt / notebooklm-py[browser]).
- Remove sandbox-user read on .env (icacls .env /remove:g CodexSandboxUsers) if the
  dev sandbox doesn't need it; otherwise document and accept.
- Optional: install ffmpeg + set NLO_FFMPEG_BIN in local .env.

Acceptance criteria:
- /api/health/ready → provider.configured:true (no worker-spawn issue).
- npm test still 515/515 (regression).
- One MOCK text job via the Runbook A (AGENT_G_LIVE_READINESS.md §3) succeeds with
  resultProvenance "mock". (Live job deferred to PW-3 / P4-8.)

Non-goals: no live job, no session verify, no production touch.
```

**Model:** Qwen · **Owner approval:** NO (local runtime) · **Parallelizable:** YES.

### Prompt PW-3 — Session validity verification (backlog BL-P2-9)

```
NLO-SESSIONS-VERIFY-1 — Verify the 3 stored Google sessions before the first live job.

Scope (owner present; read-mostly; no jobs):
- For each account in data/sessions/: POST /api/sessions/<acc>/verify (or accounts health).
- Record outcome + timestamp per account (no cookie values in the report).
- Re-auth any failure via UI login or cookie-import (owner present for credentials).

Acceptance criteria:
- All 3 accounts report valid, or documented re-auth performed; evidence recorded in
  a short report note (account ids, timestamps, outcomes — never secret values).

Non-goals: no live job yet (that is P4-8), no proxy changes.
```

**Model:** Qwen (execution, owner present) · **Owner approval:** YES (Google session state) ·
**Dependency:** PW-2 or PW-1 (worker must spawn).

---

## Phase prompts (product track — one at a time, each independently deliverable)

### Prompt P4-2 — Content Intake & Prompt Template Engine (DeepSeek)

```
NLO-P4-2 — Content Intake & Prompt Template Engine.

Goal: users can define and reuse prompt TEMPLATES (e.g. "podcast from a paper",
"summary in Persian") and create template-driven jobs from text or file content,
via UI + REST. Spec base: docs/product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md and
docs/architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md (update them where this phase
refines them).

Scope:
1. Template model: templates table (name, description, language, output kind, prompt
   body with {{placeholders}}, versioning/soft-delete) + zod validation + safe-name
   rules for user-facing names; repository in apps/server/src/domain.
2. REST API (both surfaces where appropriate): CRUD /api/v1/templates (+ legacy
   surface for UI), template-aware job creation (POST /api/v1/jobs with
   templateId, or from-text with templateId); placeholder substitution is validated
   (unknown placeholder → 400 with machine-readable code).
3. UI: template picker/manager on the CreateJob page + templates list page (existing
   api.ts pattern; legacy /api surface for UI stays by design).
4. Docs: docs/api/README.md endpoints, OpenAPI spec (api/openapi/spec.ts), README
   feature status, CHANGELOG; fix the doc numbering in
   docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md and
   docs/roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md to the owner's P4-2…P4-8
   numbering, correct the UI-auth wording ("token-less loopback", not "session +
   token"), and update docs/ROADMAP_MASTER.md + NLO_MASTER_EXECUTION_STATUS.md to
   mark P4-1 completed (backlog BL-P2-7/8/10 — folded into this phase's doc step).
5. Tests: unit (template validation, substitution), integration (template CRUD +
   template-driven mock job end-to-end in-process, artifact provenance "mock"),
   OpenAPI contract test; four-path matrix row for templates updated.

Acceptance criteria:
- Create template via REST + UI; create a job from it; job SUCCEEDS on mock provider
  with substituted prompt (verify in provider request log/artifact); unknown
  placeholder rejected 400 with ApiCodes envelope.
- npm run typecheck/lint/build green; npm test all workspaces green; prettier green
  on all touched files (BL-P1-1 format-only commit should land BEFORE this phase).
- Live behavior NOT claimed (mock level; C7 + e2e-live manual gates unchanged).
- Phase report in docs/reports/ (evidence, changed files, commits, limitations).

Non-goals: no multi-account session changes (P4-3), no failover logic (P4-4),
no MCP (P4-5). Production/staging deployment is the PW-1 track, not this phase.

Definition of done: AGENTS.md §3 + §10 checklist (tests, docs, CHANGELOG, OpenAPI,
commit message states goal + scope; regression + health checks pass).
```

**Model:** DeepSeek (contract-heavy: API + UI + template language) · **Owner approval:**
normal flow · **Parallelizable:** with PW-1/PW-2 ops track; NOT with other P4 code phases.

### Prompt P4-3 — Multi-Account Google Session Management (Qwen)

```
NLO-P4-3 — Multi-Account Google Session Management.

Goal: first-class management of multiple Google accounts: per-account session
lifecycle (login, verify, refresh, rotate, logout, import/cookie-import), account
health surfaced, and deterministic account selection for jobs (round-robin or
preferred, fail-closed when no valid session).

Spec base: docs/architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md +
docs/research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md (update where refined).

Scope:
1. Account selection policy for jobs (configured: preferred/round-robin; selection
   recorded per job attempt as evidence; fail-closed with a clear errorClass when
   no account is usable).
2. Session operations hardening: rotate-lock discipline already present — verify and
   document; per-account last-verified timestamp surfaced in accounts API/UI.
3. UI: accounts page improvements (health badges, verify button per account,
   selection policy setting in /settings).
4. Tests: integration for selection policy (mock provider, 2+ fake accounts),
   404/health/lock edge cases; unit for the policy.
5. Docs: API README, runbook update (session ops), CHANGELOG, README status.

Acceptance criteria:
- With 2 accounts configured, mock jobs distribute per policy (evidence in attempt
  records); when all sessions invalid, job creation/poll returns a clear
  errorClass + needsReauth flag (no ambiguous in-flight job).
- All gates green (typecheck/lint/test/build/format); phase report written.
- Live verification NOT claimed (manual gate: PW-3 verifies real sessions; a real
  multi-account live run is a P4-8 item).

Non-goals: proxy pool failover (P4-4), no new auth model (API tokens unchanged).
```

**Model:** Qwen (mechanical lifecycle + policy) · **Owner approval:** normal flow ·
**Parallelizable:** with ops track; sequence after P4-2 (shared job-creation path —
one code track at a time).

### Prompt P4-4 — Proxy Pool & Egress Failover (Qwen)

```
NLO-P4-4 — Proxy Pool & Egress Failover.

Goal: the egress gateway fails over across the proxy pool with explicit policy and
evidence: per-attempt node selection with health-aware preference, automatic
fallback to the next healthy node on proxy-class failures, attempt records showing
which node was used, and a typed (not string-matched) "no enabled node" sentinel.

Spec base: docs/architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md +
docs/research/NLO_PROXY_EGRESS_RESEARCH.md; ADR-004/ADR-007.

Scope:
1. Failover policy in EgressGateway/proxy-manager: try preferred → healthy nodes
   (order: preferred, then priority) on proxy-class failures (connectivity/timeout
   from the tunnel, NOT auth/rate-limit/ambiguous job classes); cap per attempt;
   record node + egress IP per attempt.
2. Replace the string-coupled direct fallback with a typed NoEnabledNodeError or
   listEnabled() === 0 precheck (backlog BL-P2-1 / R-3).
3. Land the lock-design fixes in the same window (same modules, one coherent commit
   series): BL-P1-4 (refresh() stand-down) + BL-P1-5 (scoped resetAll / stated
   invariant) — with their unit tests.
4. Tests: integration failover matrix (mock provider + stub proxy manager: preferred
   unhealthy → next node used; all unhealthy → clean errorClass proxy; ambiguous
   class NEVER retried automatically), settle-once suite stays green.
5. Docs: proxy-design.md §8, JOB_RECOVERY_RUNBOOK.md, CHANGELOG, README.

Acceptance criteria:
- Failover matrix tests green (each cell: trigger → expected node/errorClass).
- No double-drive: stolen-lock test (R-1 fix) proves stand-down; scoped reset test
  (R-2) proves other-holder live locks survive a second boot.
- All gates green; phase report written; live failover NOT claimed (P4-8).

Non-goals: proxy node provisioning (script/ops), no new provider.
```

**Model:** Qwen (infra/mechanical) · **Owner approval:** normal flow · **Parallelizable:**
with ops track; sequence after P4-3.

### Prompt P4-5 — MCP Server & External MCP Providers (DeepSeek)

```
NLO-P4-5 — MCP Server & External MCP Providers (backlog BL-P1-8).

Goal: implement the MCP path of the four-path contract: an MCP server exposing
NLO operations as tools, and the foundation to consume external MCP providers as
NotebookLM-provider peers (per ADR-005/ADR-006).

Spec base: ADR-005, ADR-006,
docs/architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md,
docs/research/NLO_NOTEBOOKLM_MCP_COMPARISON.md (update where refined).

Scope:
1. MCP server: /mcp endpoint (Streamable HTTP), JSON-RPC handling, tool registry.
   Tools (the 9 designed): list_providers, create_job, get_job, get_artifact,
   retry_job, list_templates (uses P4-2), get_provider_health, get_job_events,
   list_accounts_health (or the ADR-005 set — follow the ADR; document deviations).
2. Auth: API tokens (nlo_…) with per-tool scope mapping (jobs:read/write/cancel/
   download, meta:read, providers:read); no token → error envelope; wrong scope →
   per-tool denial with machine-readable code.
3. External MCP client foundation: provider descriptor kind "mcp_client" is already
   in the OpenAPI enum — implement the client adapter skeleton behind the same
   NotebookLMProvider interface (fail-closed when the external server is
   unreachable), WITHOUT claiming live parity (mock/harness level).
4. MCP client harness: an in-repo test client that exercises EVERY tool against the
   in-process app (mock provider) — this is the four-path "MCP" evidence.
5. Tests + docs: harness green for all tools; OpenAPI (add /mcp surface);
   four-path matrix MCP column updated from NOT-IMPLEMENTED to mock-verified;
   CHANGELOG; README status (honest: mock-level).

Acceptance criteria:
- MCP harness: all tools pass (mock provider); auth matrix (no token / right scope /
  wrong scope) asserted; create_job via MCP produces a job whose status/artifacts
  match REST-observed state (cross-path consistency check).
- All gates green; phase report written; live MCP NOT claimed.

Non-goals: third-party MCP provider production integration (harness-level only,
documented as follow-up), no UI for MCP (by design).
```

**Model:** DeepSeek (protocol/contract-heavy) · **Owner approval:** normal flow ·
**Parallelizable:** with ops track; sequence after P4-4 (P4-6 may run first if the
owner prefers the recovery UI — see order note).

### Prompt P4-6 — Manual Retry & Durable Recovery UI (DeepSeek)

```
NLO-P4-6 — Manual Retry & Durable Recovery UI.

Goal: operators (and external agents) can safely handle stuck/ambiguous jobs: a
recovery UI + API flow that CLASSIFIES first, never auto-retries ambiguous jobs,
and documents every action (settle-once discipline).

Spec base: docs/product/NLO_MANUAL_RETRY_SPEC.md +
docs/operations/JOB_RECOVERY_RUNBOOK.md + ADR-007 (update where refined).

Scope:
1. Recovery API: GET /api/v1/jobs/:id/recovery (classification: terminal-ok /
   requeueable / ambiguous-park / needs-reauth, with evidence: last event, attempt
   count, externalOperationId presence), POST …/recovery/actions (requeue |
   mark-failed | park-needs-attention) — each action audited (who/when/why).
2. UI: job details gains a "Recovery" panel — classification banner, action buttons
   (enabled per classification), attempt/node history; NEEDS_ATTENTION jobs flagged
   on the job list.
3. Invariants: ambiguous (UNKNOWN_EXTERNAL_STATE) jobs are NEVER auto-retried;
   the first engine action after recovery is a poll of the external op, not a
   re-submit (asserted in tests); lock behavior per the P4-4 fixes.
4. Tests: integration recovery matrix (each class → allowed actions), audit trail
   assertions, settle-once green.
5. Docs: runbook updated to match the UI, API README, CHANGELOG, README.

Acceptance criteria:
- Recovery matrix tests green; a deliberately ambiguous job (simulated) can only be
  parked/poll — requeue requires an explicit operator action and is audited.
- All gates green; phase report written; live recovery NOT claimed (P4-8 runs the
  real scenario: kill mid-job → restart → poll-first recovery, per the matrix's
  reference scenario T1).

Non-goals: automatic failover (P4-4), no MCP surface yet (P4-5 may add retry_job
  later — design for it but don't block on it).
```

**Model:** DeepSeek (product/UX contract) · **Owner approval:** normal flow ·
**Parallelizable:** with ops track; sequence after P4-4 (uses its lock fixes).

### Prompt P4-7 — Webhook & Artifact Delivery (Qwen)

```
NLO-P4-7 — Webhook & Artifact Delivery.

Goal: make webhook + artifact delivery a first-class, documented, tested delivery
surface: event coverage, delivery guarantees, and artifact download hardening for
external consumers (including MCP/agent paths).

Spec base: docs/architecture/WEBHOOK_ARCHITECTURE.md +
docs/operations/WEBHOOK_DELIVERY_RUNBOOK.md (dispatcher already implemented —
this phase completes the contract, not the mechanism).

Scope:
1. Event catalog: every job lifecycle transition (created, queued, running, stage
   changes, succeeded, failed, cancelled, needs-attention, requeued) published to
   the outbox with stable event names + versioned payload schema (documented).
2. Delivery completeness: dead-letter + delivery history UI/API polish (list,
   re-deliver manually with audit — re-delivery is byte-identical per existing
   HMAC design), webhook CRUD hardening (test-endpoint button, SSRF errors
   surfaced clearly).
3. Artifact delivery: download links in webhook payloads (signed/loopback policy
   documented), digest (sha256) in artifact rows + payloads for external
   verification; large-artifact range-request support if missing.
4. Tests: integration — each event fires exactly once (outbox exactly-once),
   re-deliver is byte-identical (HMAC verifiable), digest matches downloaded
   bytes; allowlist fail-closed preserved.
5. Docs: event catalog in docs/api/README.md + wiki page 10 (webhook integration),
   OpenAPI, CHANGELOG.

Acceptance criteria:
- Event catalog test: a full mock job lifecycle emits the documented event set,
  exactly once each; dead-letter + manual re-deliver path tested; digests verified.
- All gates green; phase report written.

Non-goals: push transports beyond HTTP POST (SSE/queue backends = follow-up),
no MCP (P4-5 owns agent subscription).
```

**Model:** Qwen (mechanical delivery surface) · **Owner approval:** normal flow ·
**Parallelizable:** with ops track; sequence after P4-6 (recovery events feed the
catalog).

### Prompt P4-8 — Four-Path Live Acceptance (Qwen, owner present)

```
NLO-P4-8 — Four-Path Live Acceptance (manual gates, real NotebookLM, cost-bearing).

Prerequisites (ALL must be true before starting — this phase is BLOCKED until):
- PW-1 done: production (or staging nlo2.ai.ismc.ir) instance live, health/ready true.
- PW-2 done: local venv healthy (for the local leg) — OR use the staging instance.
- PW-3 done: >=1 verified Google session; >=1 healthy enabled proxy node (health
  check target notebooklm, egress IP recorded).

Scope (execute the four-path matrix reference scenario T1 — podcast from a PDF —
plus the P4 capability matrix, across all four paths that exist at the time):
1. Human UI: create the T1 job from the CreateJob page with a P4-2 template;
   observe to success; download all artifacts in the UI.
2. REST: same T1 scenario via /api/v1 with a token; cross-check status/events/
   artifacts match the UI job's shape (provenance "real" both).
3. MCP: same via the P4-5 harness/tools (mock-level tools exercised against the
   live instance).
4. External E2E: apps/server/scripts/nlo-e2e.ts scenario podcast against the live
   instance; record the machine-readable report (exit code 0 = PASS-or-mock —
   with a live instance it must be a genuine PASS).
5. Crash-recovery leg (the matrix's T1 requirement): kill the service mid-job
   (owner-approved window), restart, verify poll-first recovery (no duplicate
   external op), job settles exactly once.
6. Evidence record per job: job id, account id (not cookies), node id + egress IP,
   duration, artifact sizes + sha256 digests, resultProvenance "real".

Acceptance criteria:
- T1 SUCCEEDED with resultProvenance "real" on every path attempted; crash-recovery
  leg passes; no ambiguous job left behind (all parked jobs resolved or documented).
- Report: docs/reports/ with per-job evidence, paths × outcomes matrix, honest
  NOT-verified list (e.g. anything not attempted), cost note (accounts/egress used).

Non-goals: no code change expected except bug fixes discovered (each with its own
tests + commit), no new phases.
```

**Model:** Qwen (execution) with owner present · **Owner approval:** YES (live jobs,
restart, cost) · **Dependency:** PW-1/2/3 + P4-2…P4-7.

---

## Order & parallelism summary

| Sequence                       | Track      | Prompts                                                       | Notes                                                        |
| ------------------------------ | ---------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Immediate (parallel)           | Ops        | PW-1 (needs owner SSH), PW-2, decision BL-P1-3 (UUID)         | gates P4-8, not P4-2                                         |
| Immediate (fast, repo hygiene) | Hygiene    | BL-P1-1 format fix; BL-P1-4+5 lock fixes (can also ride P4-4) | land BEFORE P4-2 so its format gate is clean                 |
| 1                              | Product    | P4-2 (DeepSeek)                                               | first user-visible feature; includes doc-numbering alignment |
| 2                              | Product    | P4-3 (Qwen)                                                   | session policy                                               |
| 3                              | Product    | P4-4 (Qwen)                                                   | failover + R-1/R-2 lock fixes (if not done in hygiene)       |
| 4                              | Product    | P4-5 (DeepSeek)                                               | MCP server + client foundation                               |
| 5                              | Product    | P4-6 (DeepSeek)                                               | recovery UI/API (may swap with P4-5 by owner preference)     |
| 6                              | Product    | P4-7 (Qwen)                                                   | webhook/artifact delivery completion                         |
| 7                              | Ops + live | PW-3, then P4-8 (Qwen, owner present)                         | real NotebookLM, four paths, crash leg                       |

**Rationale:** intake (P4-2) is the first user-visible value and touches the fewest
shared seams; sessions (P4-3) and failover (P4-4) are the reliability spine; MCP
(P4-5) and recovery (P4-6) are the agent/operator doors; delivery (P4-7) completes
the outbox contract; P4-8 is the honest live gate that nothing earlier may claim.

## Model-assignment rationale (mission §9 Q11)

- **DeepSeek:** P4-2 (template language + API contract + UI), P4-5 (MCP protocol —
  JSON-RPC/Streamable HTTP, scope mapping), P4-6 (product UX contract + recovery
  semantics). These are design/contract-heavy where spec fidelity matters most.
- **Qwen:** PW-1/PW-2/PW-3 (ops execution), P4-3 (lifecycle mechanics), P4-4
  (infra/policy), P4-7 (delivery mechanics), P4-8 (execution + evidence), and all
  mechanical backlog fixes (format, ACLs, sentinel, doc edits).
- Either model can execute any item; the assignment is a recommendation, not a
  requirement.

## Standing rules for every prompt above (carried from the mission + AGENTS.md)

1. Read-only preflight first (branch/HEAD/tree/remotes; production: systemctl +
   health + ready) and report before touching.
2. Tests proportional to risk; docs + CHANGELOG + OpenAPI updated in the same change.
3. No secrets in repo/reports; mock ≠ live in every claim; no live job outside P4-8
   (and PW-3 verifies, not runs).
4. One commit series per phase with clear messages; phase report at the end;
   **wait for owner approval before the next phase** (AGENTS.md §9).
5. Four-path matrix row for the phase's capability updated with honest test types
   (U/I/C/M) before the phase closes.
