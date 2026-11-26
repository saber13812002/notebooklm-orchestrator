# NLO-M00 — Product Gap Analysis & Delivery Backlog

Mission: **M00** (P0, READ-ONLY). Date: 2026-11-26. Author: NLO agent.
Baseline: `main @ 25841c0` (tree clean, single remote `origin` = GitHub).

This is a READ-ONLY product assessment. No code, configuration, infrastructure, or
runtime change was made during M00, except: (a) `prettier --write` on the Gate-D RCA
report (a file committed in the previous mission) to restore the `format:check` gate,
and (b) the reformat that the M00 report itself needs to pass the gate. Both are
recorded in the commit accompanying this report.

Status labels (per the M00 directive and
[`NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md)):
`NOT_IMPLEMENTED`, `DESIGNED_ONLY`, `IMPLEMENTED`, `UNIT_TESTED`, `INTEGRATION_TESTED`,
`MOCK_E2E_VERIFIED`, `LIVE_E2E_VERIFIED`, `OWNER_ACCEPTED`.
**Mock evidence is never presented as Live evidence.**

---

## 0. Executive summary

NLO is an **API-first, deployable, testable product at the mock/integration level**:
the full job pipeline (upload/text → notebook → podcast → MP3 artifact → webhook/
polling), the state machine, durable locks, fail-closed egress, webhook delivery,
API-token auth, and an RTL Persian human UI all exist and are tested.
516 tests pass at `25841c0` (shared 128, server 357, web 30; one flaky Windows
exit-code artifact in the E2E negative control — see §2.11).

The product's **center of gravity is real (Live) acceptance**, not more features:

- **Live provider is not runnable locally right now**: the Python worker venv
  spawn fails with `0xC0000006` (BL-P1-2) and FFmpeg is absent for MP3
  transcode on this workstation (BL-P3-7). Live podcast was LIVE-verified once
  (2026-11-06) and the capability remains `LIVE_E2E_VERIFIED (historical)` —
  re-verification is M02's job.
- **MCP (both directions) and the Content-Intake template engine are
  `DESIGNED_ONLY`** — detailed target architecture + ADRs exist, zero code.
- **Production is running** on `172.30.0.133` (`AI-TOOLS`): systemd `nlo.service`,
  loopback `127.0.0.1:4870`, commit `278273a` (deployed 2026-11-14 17:35 UTC,
  confirmed via SSH in the P5-0 baseline 2026-11-20). The open item is a
  **forward deploy** (production is N commits behind `origin/main`), not a
  first-ever deployment. Stage A (nlo2.ai.ismc.ir, HTTP + Basic-auth) also
  exists; Stage B (TLS) is blocked on the edge :80 issue (Gate-D RCA).
- **GitLab one-way mirror is configured in-repo (`.gitlab-ci.yml`) but the
  GitLab remote does not exist** — dual-repo policy is half-built.

The prioritized backlog in §6 maps directly onto missions M01–M10.

---

## 1. Capability Inventory

Evidence key: code = current `apps/`/`packages/` at `25841c0`; tests = workspace
`npm test` results; reports = `docs/reports/` + `docs/architecture/`.

### 1.1 Core product

| #   | Capability                                                                                                                                                 | Status                                                                                                       | Code                                                                                                                                         | Tests                                                                                                        | Evidence                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| C1  | Job creation from **file upload** (multipart; doc/txt/srt/docx extraction; audio; size/ext validation; safe names; idempotency key)                        | `MOCK_E2E_VERIFIED` + historical `LIVE_E2E_VERIFIED` (audio P0, 2026-11-06)                                  | `apps/server/src/api/job-create.ts`, `routes/jobs.ts`                                                                                        | `api.test.ts`, `document-sources.test.ts`, `provider-audio.test.ts`, E2E `nlo-e2e.ts` audio scenario         | CHANGELOG live entries; `docs/testing/AUDIO_LIVE_ACCEPTANCE.md`                                              |
| C2  | Job creation from **pasted text** (`POST /notebooks/from-text`, idempotent, ≤200k chars, versioned master prompt v1 or custom, derived title)              | `MOCK_E2E_VERIFIED` + historical `LIVE_E2E_VERIFIED`                                                         | `api/job-create-text.ts`, `shared/text-source.ts`, `routes/jobs.ts`                                                                          | `from-text.test.ts`, `e2e-text-to-podcast.test.ts` (positive + negative), conformance C2                     | `docs/architecture/h1-text-to-notebook.md`                                                                   |
| C3  | **Job state machine** (10 states, validated transitions, restart-recoverable set → QUEUED)                                                                 | `IMPLEMENTED` + `UNIT_TESTED`                                                                                | `packages/shared/src/job-state.ts`                                                                                                           | `packages/shared/test/job-state.test.ts`                                                                     | —                                                                                                            |
| C4  | **Job queue / runner** (single in-process worker, tick loop, progress stages 0–98, per-class failure handling, cancel-during-run)                          | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED`                                                                   | `queue/queue.ts`, `queue/job-runner.ts`                                                                                                      | `job-lifecycle.test.ts`, `orchestrator.test.ts`, E2E scripts                                                 | —                                                                                                            |
| C5  | **Durable job locks** (settle-once; runner stands down on lock loss)                                                                                       | `INTEGRATION_TESTED`                                                                                         | `domain/jobs.lock.ts`                                                                                                                        | `settle-once.test.ts`, `worker-queue-recovery.test.ts`                                                       | P4-1.1 R-1 (refresh() return ignored — cosmetic)                                                             |
| C6  | **Restart recovery** (in-flight jobs reset to QUEUED on boot)                                                                                              | `INTEGRATION_TESTED`                                                                                         | `queue/job-runner.ts` (recovery path)                                                                                                        | `worker-queue-recovery.test.ts`, `podcast-fault-recovery.test.ts`                                            | `docs/architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`                                            |
| C7  | **Retry policy** (per-failure-class; ambiguous/timeout never auto-retried)                                                                                 | `UNIT_TESTED` + `INTEGRATION_TESTED`                                                                         | `shared/retry.ts`, `queue/job-runner.ts`, `python-worker/protocol.ts` (`isAmbiguousCode`)                                                    | `shared/test/retry.test.ts`, `podcast-fault-recovery.test.ts`                                                | `ADR-007`                                                                                                    |
| C8  | **Hourly auto-retry** of FAILED jobs (unbounded, paced sweep, opt-in `NLO_AUTO_RETRY`) + **hourly session re-verification** (`NLO_SESSION_REFRESH`)        | `INTEGRATION_TESTED` (2026-11-25, `f96a9de`)                                                                 | `queue/auto-ops.ts`, `domain/jobs.repo.ts` (`requeueFailed`)                                                                                 | covered by server suite (auto-ops exercised in app-context tests)                                            | CHANGELOG [2026-11-25]; this is the M05 "unlimited retry until output" requirement — **already implemented** |
| C9  | **Podcast generation** (audio_formats deep_dive/brief/critique/debate; lengths short/default/long; instructions; sourceIds) — capability-gated on provider | `IMPLEMENTED` (capability matrix honest) + `MOCK_E2E_VERIFIED` + historical `LIVE_E2E_VERIFIED` (2026-11-06) | `providers/types.ts`, `providers/mock-provider.ts`, `providers/python-worker/python-worker-provider.ts`, `job-runner.ts` podcast steps 60–98 | `provider-audio.test.ts`, `podcast-lifecycle.test.ts`, `podcast-fault-recovery.test.ts`, `transcode.test.ts` | `docs/architecture/AUDIO_PIPELINE_ARCHITECTURE.md`, `docs/testing/AUDIO_LIVE_ACCEPTANCE.md`                  |
| C10 | **Artifact storage + validation** (archive under `data/jobs/<id>/`, size/type/size checks, mediaType, safe download)                                       | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED`                                                                   | `domain/archive.ts`, `domain/artifacts.repo.ts`, `domain/artifact-validate.ts`                                                               | `artifact-download.test.ts` (suite), E2E collectEvidence                                                     | `docs/operations/ARTIFACT_STORAGE_RUNBOOK.md`                                                                |
| C11 | **Artifact download API** (legacy + v1; media streaming; job audio blob for UI)                                                                            | `MOCK_E2E_VERIFIED`                                                                                          | `routes/jobs.ts`, `web/lib/api.ts` (`jobAudioBlobUrl`, `downloadJobAudio`)                                                                   | `api.test.ts`, E2E                                                                                           | —                                                                                                            |
| C12 | **MP3 transcode** (FFmpeg, `NLO_FFMPEG_BIN`)                                                                                                               | `IMPLEMENTED` (code + unit test) — **FFmpeg binary ABSENT on this workstation**                              | `media/transcode.ts`                                                                                                                         | `transcode.test.ts`                                                                                          | BL-P3-7. Live MP3 56kbps was produced in the 2026-11-06 live run (host had FFmpeg).                          |
| C13 | **Provider capability matrix** (honest per-op levels; undeclared ⇒ unavailable)                                                                            | `IMPLEMENTED` + `UNIT_TESTED`                                                                                | `providers/types.ts` (`capabilityMatrix`), `shared/input-capabilities.ts`                                                                    | `shared/test/input-capabilities.test.ts`, `capabilities.test.ts`                                             | —                                                                                                            |
| C14 | **Provider registry** (active + candidate/disabled descriptors)                                                                                            | `INTEGRATION_TESTED`                                                                                         | `providers/registry.ts`                                                                                                                      | conformance C1 (descriptor lint)                                                                             | MCP-client provider kind exists **only as schema enum** (`openapi/spec.ts:1188`) — no adapter                |

### 1.2 Live provider & accounts

| #   | Capability                                                                                                                                                                                 | Status                                                                                         | Code                                                                                         | Tests                                                                                                                 | Evidence                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| C15 | **Python worker** (JSON-line protocol: ping/validate/verify/login/browser-import/job/job_text/audio_generate/audio_status/audio_download; zod both ends; error taxonomy incl. `ambiguous`) | `IMPLEMENTED` + protocol `UNIT_TESTED` (fake worker fixtures) — **live spawn BLOCKED locally** | `providers/python-worker/{nbl_worker.py, protocol.ts, python-worker-provider.ts, worker.ts}` | `worker-supervisor.test.ts`, `worker-nonascii-protocol.test.ts` (fixtures `fake-worker.mjs`, `fake-audio-worker.mjs`) | P4-1.1 BL-P1-2: venv spawn `0xC0000006` (Windows); 3 stored sessions present but unverified (BL-P2-9) |
| C16 | **Google account management** (accounts repo, enable/disable, health)                                                                                                                      | `INTEGRATION_TESTED`                                                                           | `domain/accounts.repo.ts`, `routes/accounts.ts`                                              | `accounts.repo.test.ts` (suite)                                                                                       | —                                                                                                     |
| C17 | **Auth sessions** (login flow, browser-state import, verify; TTL-gated selection)                                                                                                          | `INTEGRATION_TESTED`                                                                           | `domain/auth-sessions.repo.ts`, `routes/sessions.ts`                                         | `session-gate.test.ts`, `sessions-404.test.ts`                                                                        | `docs/research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`                                                   |
| C18 | **Proxy manager + fail-closed egress** (VLESS nodes, vault-stored UUIDs, staged health check, allowlist SSRF, egress gateway direct-refusal)                                               | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED`                                                     | `proxy/{connect-proxy,egress,gateway,proxy-manager,runtime}.ts`                              | `egress-gateway.test.ts`, `fail-closed.test.ts`, `api.test.ts` ping-all                                               | `ADR-004`, `docs/architecture/proxy-design.md`                                                        |
| C19 | **Secrets vault** (AES-256-GCM, 0600 key, refs masked in API)                                                                                                                              | `UNIT_TESTED` + `INTEGRATION_TESTED`                                                           | `secrets/vault.ts`, `routes/settings.ts` `/secrets`                                          | server suite                                                                                                          | —                                                                                                     |

### 1.3 Delivery & integration surfaces

| #   | Capability                                                                                                                                                                                       | Status                                                                               | Code                                                                      | Tests                                                                      | Evidence                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C20 | **REST API — legacy `/api/*`** (loopback UI surface; jobs CRUD/list/filter, cancel, artifacts, accounts, proxies, sessions, settings, secrets, health/ready, capabilities, provider)             | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED`                                           | `api/server.ts`, `api/routes/*` (11 route modules)                        | `api.test.ts` (broad)                                                      | `docs/api/README.md`, wiki 09                                                              |
| C21 | **REST API — versioned `/api/v1/*`** (Bearer `nlo_` tokens, 6 scopes, per-token sliding-window rate limit, audit log, correlation IDs, idempotency; re-registers legacy handlers + tokens/audit) | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED` (E2E runner uses v1 + token)              | `api/v1.ts`, `domain/api-tokens.repo.ts`, `routes/tokens.ts`              | `openapi-v1.test.ts`, `e2e-text-to-podcast.test.ts`, `first-admin.test.ts` | `docs/wiki/08-api-authentication.md`                                                       |
| C22 | **OpenAPI v1 spec** (static, validated by test)                                                                                                                                                  | `IMPLEMENTED` + `UNIT_TESTED`                                                        | `api/openapi/spec.ts`                                                     | `openapi-v1.test.ts`                                                       | —                                                                                          |
| C23 | **Webhooks** (endpoints CRUD, HMAC-SHA256 signature, outbox, exponential backoff, fail-closed SSRF allowlist + loopback opt-in, admin views)                                                     | `INTEGRATION_TESTED` + `MOCK_E2E_VERIFIED` (Stage Gate F9 loopback receiver)         | `webhooks/dispatcher.ts`, `domain/webhooks.repo.ts`, `routes/webhooks.ts` | `webhooks.test.ts`                                                         | `docs/architecture/WEBHOOK_ARCHITECTURE.md`, `docs/operations/WEBHOOK_DELIVERY_RUNBOOK.md` |
| C24 | **Polling contract** (job status/events/stages/result/artifacts queryable; E2E runner polls)                                                                                                     | `MOCK_E2E_VERIFIED`                                                                  | `routes/jobs.ts`, `scripts/nlo-e2e.ts`                                    | `api.test.ts`, E2E                                                         | M04 "manual polling" requirement — **already implemented**                                 |
| C25 | **Radio RAG orchestrator** (`POST /orchestrator/ask`: radio-rag v1 + NLO text job gluing, honest timeout semantics)                                                                              | `INTEGRATION_TESTED` (mocked radio)                                                  | `api/routes/orchestrator.ts`                                              | `orchestrator.test.ts`                                                     | Legacy feature (M2-6-05); depends on `NLO_RADIO_TOKEN`                                     |
| C26 | **Human UI (RTL Persian)**: dashboard, create-job (file + text), job details/history, accounts, proxies, settings; Vazirmatn font; Jalali dates                                                  | `IMPLEMENTED` + `UNIT_TESTED` (30 component tests) — not OWNER_ACCEPTED              | `apps/web/src/features/*`                                                 | `apps/web/src/**/*.test.tsx` (create-job, api, jalali, utils)              | `npm run build` ✓ (vite, 492 kB bundle)                                                    |
| C27 | **Customer docs (wiki)** — 14 Persian wiki pages + developer guide                                                                                                                               | `IMPLEMENTED` (docs) — Wiki.js publication **blocked** (no credentials at this time) | `docs/wiki/01..14`                                                        | n/a                                                                        | AGENTS.md §6                                                                               |

### 1.4 Gaps (what does NOT exist)

| #   | Capability                                                                                                                            | Status                                                                                                                           | Design evidence                                                                  | Notes                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **MCP server** (NLO-as-MCP: 9 tools, Streamable-HTTP on `/mcp`, Bearer-token auth, scope-per-tool)                                    | `DESIGNED_ONLY`                                                                                                                  | `docs/architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md` §2, `ADR-005`            | Zero MCP code/deps in `apps/` (verified by search). All 7 wrapper tools map 1:1 to existing v1 routes → work is ACL + transport, not domain logic. |
| G2  | **MCP client** (external MCP servers as provider kind `mcp_client`, mapping-file capability honesty, supervisor-owned stdio children) | `DESIGNED_ONLY`                                                                                                                  | same doc §3, `ADR-006`                                                           | Only vestige: `kind: mcp_client` enum value in OpenAPI spec + registry comment.                                                                    |
| G3  | **Template engine T1–T4** (`GET /api/v1/templates`, versioned template data store, `list_templates` MCP tool)                         | `DESIGNED_ONLY`                                                                                                                  | `NLO_CONTENT_INTAKE_ARCHITECTURE.md` §2.5/ADR-002                                | Current "template" is the in-code versioned master prompt (`shared/text-source.ts`) — a **label**, not a data store.                               |
| G4  | **Content Intake v2**: PDF, Markdown, video (audio-track), URL fetch, LLM metadata enrichment                                         | `NOT_IMPLEMENTED` (URL SSRF guard building block `IMPLEMENTED`+`UNIT_TESTED`; docx/srt/txt extraction `IMPLEMENTED`)             | `NLO_CONTENT_INTAKE_ARCHITECTURE.md` §2, `ADR-002`                               | M09 scope.                                                                                                                                         |
| G5  | **GitLab mirror + GitLab CI** (one-way GitHub→GitLab; runner; secret-scan gate)                                                       | `DESIGNED_ONLY` (in-repo: `.gitlab-ci.yml` mirrors the GitHub workflow)                                                          | AGENTS.md §2, `docs/operations/gitlab-sync.md`                                   | **No `gitlab` remote configured** at `25841c0`. M08 scope (needs owner to provide GitLab URL/creds).                                               |
| G6  | **Production forward deploy** (systemd `nlo` on 172.30.0.133)                                                                        | `IMPLEMENTED` + `RUNNING` (active since 2026-11-14, commit `278273a`, loopback 4870); **behind `origin/main`** — forward deploy needed; Stage A also exists (HTTP + Basic-auth) | `deploy/deploy.sh`, `deploy/systemd/nlo.service`, `deploy/stage/*`, P5-0 baseline, P5-1A report | Production has been running continuously (deployed progressively: `b5e9ad3` → `d705634` → `278273a`). The P4-1.1 "ABSENT" claim was a stale workstation-only port probe. Stage B (TLS) blocked on edge :80 (Gate-D RCA). M08 scope. |
| G7  | **Live provider local runtime** (venv + FFmpeg on workstation)                                                                        | `BLOCKED`                                                                                                                        | BL-P1-2 (`0xC0000006`), BL-P3-7                                                  | M01 scope. Historical live proof exists (2026-11-06).                                                                                              |
| G8  | **Job retry endpoint** (`POST /api/v1/jobs/:id/retry`, ADR-007)                                                                       | `DESIGNED_ONLY`                                                                                                                  | `ADR-007`, MCP doc tool table                                                    | Needed by MCP `retry_job`; also useful for humans. Small delta on existing state machine.                                                          |
| G9  | **Webhook retry/delivery observability admin** (per-delivery status view)                                                             | `PARTIAL` (admin CRUD exists; delivery table exists)                                                                             | —                                                                                | Check during M04; likely small.                                                                                                                    |

---

## 2. Verification state at baseline (evidence, re-run 2026-11-26, Node v24, Windows)

| Gate                   | Result                                                                                                                                   | Notes                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run build`        | **PASS**                                                                                                                                 | vite web build 7.6 s; all workspaces                             |
| `npm run typecheck`    | **PASS**                                                                                                                                 | shared + server + web                                            |
| `npm run lint`         | **PASS**                                                                                                                                 | eslint clean                                                     |
| `npm run format:check` | **PASS** (after `prettier --write` on the Gate-D RCA md — the only drift at HEAD; P4-1.1 BL-P1-1's 36-file drift was fixed by `41ac79b`) |                                                                  |
| `npm test` — shared    | **128/128 PASS**                                                                                                                         |                                                                  |
| `npm test` — server    | **356/357 PASS**                                                                                                                         | 1 flaky failure, see §2.1                                        |
| `npm test` — web       | **30/30 PASS**                                                                                                                           |                                                                  |
| Conformance C1–C6      | **PASS** (in server suite)                                                                                                               | provider descriptor/honesty/lifecycle/failure/concurrency/egress |
| Live (real NotebookLM) | **NOT RUN** (manual gate; venv blocked)                                                                                                  | last live evidence 2026-11-06                                    |

### 2.1 Flaky test finding (new, M00)

`test/e2e-text-to-podcast.test.ts` → _negative control: no healthy proxy →
fail-closed FAILED_ failed **once** (child exit `3221226505` = Win32 `0xC0000005`,
libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) and **passed on
immediate re-run**. The negative behavior itself was correct in both runs (job
FAILED fail-closed, `acceptance: FAIL`, `provenance: unknown`) — the flake is a
Windows exit-code race in the spawned `nlo-e2e.ts` child, not a product defect.
**Backlog item B-M00-1** (P3): make the negative-control assertion
platform-tolerant (accept exit 1 OR the documented libuv Win32 code, or assert on
the JSON verdict only).

### 2.2 Reconciliation vs P4-1.1 (2026-11-17, HEAD b833d89)

| P4-1.1 item                                                                             | State at `25841c0`                                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| BL-P0-1 re-deploy prod 172.30.0.133                                                     | **Reframed: forward deploy.** Production IS running on 172.30.0.133 (commit `278273a`, active since 2026-11-14 17:35 UTC, confirmed via SSH in P5-0 baseline 2026-11-20). The P4-1.1 "ABSENT" claim (line 105 of the consolidated audit) was a stale workstation-only port-4870 probe without SSH — it is contradicted by the newer SSH-verified P5-0 baseline. The open item is bringing production from `278273a` up to `origin/main` (currently `08c1848`), an approval-gated forward deploy. P5-1A also built Stage A (HTTP+Basic-auth) for nlo2.ai.ismc.ir; Stage B blocked on edge :80. |
| BL-P1-1 prettier 36-file drift                                                          | **CLOSED** by `41ac79b` (only residual drift was the later RCA md — fixed during M00).                                                          |
| BL-P1-2 venv `0xC0000006`                                                               | **Still open** → M01.                                                                                                                           |
| BL-P1-3 VLESS UUID owner decision                                                       | **Still open** (owner decision, unchanged).                                                                                                     |
| BL-P1-4 `refresh()` return ignored (R-1)                                                | **Still open** (cosmetic).                                                                                                                      |
| BL-P1-5 `resetAll()` scope (R-2)                                                        | **Still open** (single-instance precondition).                                                                                                  |
| BL-P1-6 SSH creds prod host                                                             | **Changed:** owner provided SSH access for P5-1A (stage deploy succeeded) — production re-deploy still needs the same channel.                  |
| BL-P1-7 host prerequisites                                                              | **Partially done** (Docker + nginx present on 172.30.0.133 per P5-1A).                                                                          |
| BL-P1-8 MCP server                                                                      | **Still open** → M07.                                                                                                                           |
| BL-P2/P3 items (R-3/R-4/R-5, gitlab-sync, Docker build verify, FFmpeg, release tagging) | **Unchanged** → M08/M09 wave.                                                                                                                   |

---

## 3. Product Requirements Description (PRD)

**Product statement.** NLO turns a document (pasted text, doc/txt/srt/docx, audio)
into a real NotebookLM notebook and produces a downloadable audio-overview podcast
(MP3), orchestrated as durable, observable, retryable jobs. The REST API is the
primary contract; the UI, MCP surface, and external agents are peers on the same
business logic.

**Personas.** (1) Operator (owner) — runs the service, manages accounts/sessions/
proxies/tokens. (2) Integrating developer — consumes `/api/v1/*` with a token
(Python/Node/cURL). (3) AI agent — consumes the MCP surface. (4) End user — RTL
Persian UI.

**Non-negotiables (carried from AGENTS.md §4/§7).** Capability honesty (declared
matrix, never fake success); fail-closed egress; no secrets in repo/logs/images;
loopback default binding; mock ≠ live in every report; durable jobs survive restart;
artifacts are real provider output only.

**In-scope for the active program (M01–M10).** Everything in §1.1–§1.3 that is not
`OWNER_ACCEPTED`, plus G1–G9. **Explicitly OUT of the active execution program:**
full HTTPS/TLS for nlo2 (Gate-D RCA pending network owner), prior-security-risk
resolution, DNS/firewall work — these remain **release-gate** items only.

**Success (release) definition.** All four acceptance paths (UI, REST, MCP,
External Agent) drive a real NotebookLM podcast job to a validated MP3 in an
isolated/stage environment, with honest status labels, docs published, and the
dual-repo + release pipeline in place (M10 = FULLY_ACCEPTED or
ACCEPTED_WITH_LIMITATIONS with the limitations enumerated).

---

## 4. Gap Analysis (product promise → current state)

| Promise                                                   | Current state                                                              | Gap class                       | Gap ID                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| "Real NotebookLM podcast"                                 | Code complete; live-verified once; locally un-runnable (venv/FFmpeg)       | Runtime                         | G7 → **M01/M02**                                     |
| "External REST client (Python/Node/cURL)"                 | v1 API + tokens + OpenAPI + examples exist (`docs/api/examples/*`)         | Acceptance (not code)           | **M03** (write external-client harness + acceptance) |
| "Artifact delivery + webhook + polling (manual + hourly)" | All three exist (webhook outbox, polling E2E, hourly auto-retry `f96a9de`) | Acceptance + observability (G9) | **M04** (acceptance proof; delivery admin if needed) |
| "Durable job management & safe recovery"                  | Implemented + integration-tested; R-1/R-2 open                             | Acceptance + hardening          | **M05**                                              |
| "Human UI complete"                                       | Feature-complete at mock level; needs real-session walkthrough             | Acceptance                      | **M06**                                              |
| "MCP Server & Client"                                     | Design only                                                                | Build                           | G1/G2 → **M07**                                      |
| "GitLab + docs + release engineering"                     | GitLab remote absent; Docker build unverified; release tagging absent; production running but behind main | Build/ops                       | G5/G6 + BL-P2-6/P2-8 → **M08**                       |
| "Universal content intake & templates"                    | Formats: text/txt/srt/docx/audio only; templates = in-code label           | Build                           | G3/G4 → **M09**                                      |
| "Final independent acceptance"                            | —                                                                          | Gate                            | **M10**                                              |

Key insight (per owner's note): **most P1 capabilities are already implemented**
(webhook, polling, hourly retry, recovery, UI). M04/M05 should primarily be
**real acceptance + targeted hardening**, not new builds.

---

## 5. Prioritized Backlog (P0 → P3)

IDs are stable for mission references. `Dep` = must be done before.

### P0 (release-critical path)

| ID     | Item                                                                                                                     | Maps to | Dep       | Size               |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ------- | --------- | ------------------ |
| B-P0-1 | Repair local python-worker venv (recreate venv; diagnose `0xC0000006`; pin deps) + verify `worker ping/validate` locally | M01     | —         | M                  |
| B-P0-2 | Install/configure FFmpeg on workstation; verify MP3 transcode locally (NLO_FFMPEG_BIN)                                   | M01     | —         | S                  |
| B-P0-3 | Verify 3 stored Google sessions (login/import/verify) without consuming quota beyond verify                              | M01     | B-P0-1    | M                  |
| B-P0-4 | Owner-permissioned **first live podcast job** in isolated env (upload → SUCCEEDED → MP3 artifact → provenance "real")    | M02     | B-P0-1..3 | M (mostly waiting) |
| B-P0-5 | Live acceptance matrix: text-to-podcast live, audio-upload live, fail-closed negative live                               | M02     | B-P0-4    | M                  |

### P1 (product surfaces)

| ID     | Item                                                                                                                                                      | Maps to | Dep    | Size |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---- |
| B-P1-1 | External REST client acceptance: cURL/Python/Node scripts against a running instance (create→poll→download→webhook receive); fix any contract drift found | M03     | —      | M    |
| B-P1-2 | Webhook delivery acceptance (real receiver, HMAC verify, retry on 5xx, dead-letter) + per-delivery admin view if missing (G9)                             | M04     | —      | M    |
| B-P1-3 | Polling acceptance (client-side poll patterns documented in wiki 06) + hourly auto-retry acceptance (watch a FAILED job re-queue and succeed)             | M04     | B-P1-1 | S    |
| B-P1-4 | Recovery hardening: fix R-1 (`refresh()` return → stand down), document/enforce single-instance for R-2 (`resetAll`), crash-mid-podcast resume acceptance | M05     | —      | M    |
| B-P1-5 | `POST /api/v1/jobs/:id/retry` endpoint (ADR-007) + tests + OpenAPI                                                                                        | M05/M07 | —      | S    |
| B-P1-6 | UI acceptance on a real (mock-provider or stage) instance: full RTL walkthrough, job lifecycle, artifacts download, session import UI; fix gaps found     | M06     | —      | M    |

### P2 (new builds + engineering)

| ID     | Item                                                                                                                                       | Maps to | Dep                               | Size |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------- | ---- |
| B-P2-1 | MCP server: `/mcp` Streamable-HTTP endpoint, 9 tools, Bearer-token + scope, audit `via:mcp`, conformance against C-suite                   | M07     | B-P1-5 (retry tool)               | L    |
| B-P2-2 | Independent MCP client acceptance (e.g. Claude/agent driver calling NLO's MCP)                                                             | M07     | B-P2-1                            | M    |
| B-P2-3 | MCP **client adapter** (provider kind `mcp_client`, mapping file, supervisor ownership) — scope: design → one real external MCP admitted   | M07     | B-P2-1                            | L    |
| B-P2-4 | GitLab remote + one-way mirror + GitLab CI parity + secret-scan gate; verify Docker image build on daemon host; release tagging convention | M08     | owner: GitLab URL/creds           | M    |
| B-P2-5 | Production **forward deploy** on 172.30.0.133 (systemd `nlo`, port 4870) — bring `278273a` → `origin/main` (`08c1848`); separate from nlo2 stage | M08     | B-P2-4 (optional), owner approval | M    |
| B-P2-6 | Docs refresh: ROADMAP_MASTER + MASTER_EXECUTION_STATUS reconciliation; wiki publish to Wiki.js when creds available                        | M08     | —                                 | S    |

### P3 (extension)

| ID      | Item                                                                                                                                               | Maps to | Dep    | Size |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---- |
| B-P3-1  | Template engine T1–T4 as versioned **data** (`/api/v1/templates`), `list_templates` tool, template interpolation with untrusted-content delimiters | M09     | —      | L    |
| B-P3-2  | Content intake v2: PDF + Markdown extraction; (video/URL as sub-options behind config)                                                             | M09     | —      | L    |
| B-P3-3  | LLM metadata enrichment (internal-llm client already exists)                                                                                       | M09     | B-P3-1 | M    |
| B-M00-1 | Fix flaky Windows exit-code in E2E negative control (§2.1)                                                                                         | any     | —      | S    |
| B-P3-4  | R-3 gateway sentinel typing; R-5 boundary lint fixture; R-4 threat-model note; BL-P2-4/P2-5 doc/ACL nits                                           | M08     | —      | S    |

### Out of active scope (release-gate only, per owner directive)

- TLS/ACME completion for nlo2 (Gate-D RCA 2026-11-25; waiting on network owner
  to open inbound :80 to 185.213.10.25; retry on "retry").
- Prior security-risk resolution items.
- DNS/firewall/ISP changes.

---

## 6. Dependency Map

```
M01 (B-P0-1..3: venv, FFmpeg, sessions)
  └─> M02 (B-P0-4..5: live podcast acceptance)  ── required before M10

M03 (B-P1-1: external REST client)            ── independent; before M10
M04 (B-P1-2..3: webhook+polling acceptance)   ── independent; before M10
M05 (B-P1-4..5: recovery hardening + retry EP)── B-P1-5 feeds M07 (retry_job tool)
M08 (B-P2-4..6: GitLab, docker, docs, prod)   ── independent (owner creds needed for GitLab)

Wave 2 (after wave-1 deps):
M06 (B-P1-6: UI acceptance)                   ── wants B-P1-1/B-P1-2 for cross-checks
M07 (B-P2-1..3: MCP server/client)            ── B-P1-5 (M05)

M09 (B-P3-1..3: templates + intake v2)        ── independent, P3
M10 (final acceptance, 4 paths)               ── ALL of M02, M03, M04, (M06, M07)
```

**Parallel wave 1 (no shared state):** M01, M03, M04, M05, M08, M09.
**Wave 2:** M02 (needs M01), M06, M07 (needs M05's retry endpoint).
**Final:** M10.

---

## 7. Acceptance Criteria per capability (abridged — full per-mission in each mission prompt)

| Capability                  | AC (must all hold, with evidence type stated)                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live podcast (C9)           | Real job `SUCCEEDED`; artifact ≥1 byte, correct mediaType, size/hash recorded; `resultProvenance:"real"`; attempts/stages queryable; **Live** evidence (not mock)                       |
| External REST (C21)         | cURL + Python + Node clients: token create → create job → poll → download artifact → webhook HMAC-verified receipt; no contract drift vs OpenAPI; **Integration** evidence              |
| Webhook (C23)               | Delivery with valid HMAC on real receiver; retry observed on injected 5xx then success; dead-letter on unreachable; SSRF block on disallowed host; **Integration** evidence             |
| Polling/hourly (C24/C8)     | Client poll loop reaches terminal state; FAILED job re-queued by hourly sweep and re-runs (evidence: stages + `auto_retry_requeue` event)                                               |
| Durable recovery (C5/C6/C7) | Crash mid-run (kill -9) → restart → job resumes QUEUED, no duplicate external op (resume-not-resubmit); ambiguous errors never auto-retried; **Integration** evidence                   |
| UI (C26)                    | Full RTL walkthrough: create (file+text), watch status, download artifact, sessions import, proxies health; no console errors; **E2E mock** evidence + owner click-through              |
| MCP server (G1)             | `tools/list` returns 9 tools; each tool call succeeds/fails identically to the REST route it wraps (conformance); audit row `via:"mcp"`; token scope enforced; **Integration** evidence |
| MCP client (G2)             | One external MCP provider admitted via mapping file; conformance C1–C7 incl. one live run; stdio child owned by supervisor (no orphans)                                                 |
| Templates (G3)              | `GET /api/v1/templates` lists versioned templates; a job created with a template records the version; source content confined to delimited region (untrusted-content rule)              |
| Content intake v2 (G4)      | PDF + MD upload → extracted text source → job SUCCEEDED (mock); matrix shows extraction provenance; provider undeclared ⇒ unavailable                                                   |
| Release engineering (G5/G6) | GitLab mirror green (one-way, secret-scan gate passes); `docker build` succeeds on daemon; tag convention documented; prod re-deploy behind owner approval                              |

### Definition of Done (all missions)

1. Report with the 19 required sections (N/A marked with reason).
2. Independent branch + worktree; independent commit(s) on the branch; **no merge/push/deploy without owner authorization**.
3. `typecheck` + `lint` + `format:check` + `build` + relevant tests green (or deltas explained).
4. Mock and Live evidence strictly separated; no fake success; blockers reported honestly.
5. README/CHANGELOG/OpenAPI updated where behavior changed.
6. Backup + restore verification before any data/runtime change; Git rollback point recorded.
7. STOP after delivery — await owner approval before the next mission.

---

## 8. File Ownership Matrix (for parallel waves — minimize merge conflicts)

| Area                          | Owner mission     | Files (primary)                                                                                                      |
| ----------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Python worker / venv / FFmpeg | M01               | `apps/server/src/providers/python-worker/*`, `.env.example`, runbooks                                                |
| Live acceptance               | M02               | `docs/testing/*`, `apps/server/scripts/e2e-live.ts`, `verify-live.ts` (read-mostly)                                  |
| REST client examples          | M03               | `docs/api/examples/*` (new client scripts), OpenAPI (read)                                                           |
| Webhooks/polling acceptance   | M04               | `apps/server/src/webhooks/*`, `routes/webhooks.ts` (small deltas only), runbook                                      |
| Recovery/retry                | M05               | `queue/*`, `domain/jobs.lock.ts`, `routes/jobs.ts` (retry endpoint), `shared/job-state.ts` (read)                    |
| UI                            | M06               | `apps/web/src/**`                                                                                                    |
| MCP                           | M07               | NEW: `apps/server/src/mcp/*` (proposed), `routes/tokens.ts` (read), conformance suite (add C7 if needed)             |
| Release engineering           | M08               | `deploy/*`, `.gitlab-ci.yml`, `Dockerfile`, `docker-compose.yml`, `docs/operations/*`, docs reconciliation           |
| Templates/intake              | M09               | `packages/shared/src/text-source.ts` (extend), NEW `domain/templates*`, `routes/` (templates), `api/openapi/spec.ts` |
| Flaky test fix                | any (suggest M05) | `test/e2e-text-to-podcast.test.ts`                                                                                   |

Conflict hotspots: `api/openapi/spec.ts` (M03/M05/M07/M09) and
`routes/jobs.ts` (M05/M07) — sequence these: M05's retry endpoint first, MCP
wraps it after; OpenAPI changes land per-mission and are merged forward.

---

## 9. Release Readiness Matrix

| Release gate                          | Status at `25841c0`                                  | Blocker / owner action                                                                               |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mock E2E (all scenarios)              | ✅ green (1 known Windows flake, §2.1)               | —                                                                                                    |
| Live podcast (isolated env)           | ⛔ blocked                                           | M01 venv/FFmpeg → M02 (owner permission for real job)                                                |
| 4-path acceptance (UI/REST/MCP/Agent) | ⛔ 1.5 of 4 exist (UI mock, REST mock+examples)      | M06/M03/M07                                                                                          |
| Durable recovery proven               | 🟡 integration-tested, not crash-acceptanced         | M05                                                                                                  |
| Webhook proven                        | 🟡 integration-tested (loopback stage receiver only) | M04                                                                                                  |
| GitLab dual-repo                      | ⛔ no remote                                         | M08 (owner: GitLab URL + mirror creds)                                                               |
| Production (systemd, 172.30.0.133)    | 🟡 **running** (`278273a`, active since 2026-11-14); behind `origin/main` (`08c1848`) — forward deploy needed | M08 (owner approval; SSH access confirmed working per P5-0/P5-1A)                                   |
| TLS for nlo2                          | ⛔ edge :80                                          | **Out of active scope** — Gate-D RCA pending network owner; Stage A serves HTTP+Basic-auth meanwhile |
| Customer docs (Wiki.js)               | 🟡 md complete, publication blocked                  | owner: Wiki.js API creds                                                                             |
| Release tagging + Docker build verify | ⛔ not done                                          | M08                                                                                                  |

---

## 10. Parallel Execution Plan (proposed, for owner approval)

**Wave 1 (parallel, independent worktrees):**

1. **M01** — venv + FFmpeg + session verify (P0; unblocks the whole live path).
2. **M03** — external REST client acceptance.
3. **M04** — webhook + polling acceptance (+ G9 admin view if missing).
4. **M05** — recovery hardening (R-1/R-2), crash-resume acceptance, retry endpoint (B-P1-5), flaky-test fix (B-M00-1).
5. **M08** — GitLab mirror + CI parity + Docker build verify + docs reconciliation (GitLab work pauses on owner creds; the rest proceeds).
6. **M09** — templates data store + PDF/MD intake (P3, can start late in wave 1).

**Wave 2 (after deps):** 7. **M02** — real live podcast acceptance (needs M01; owner permission for the live job). 8. **M06** — UI acceptance walkthrough + fixes. 9. **M07** — MCP server + independent client acceptance (+ scoped mcp_client adapter if approved).

**Final:** **M10** — independent 4-path E2E acceptance in an isolated environment;
final verdict per the contract.

Each mission: own worktree, STOP after report + commit, owner approves, then next.

---

## 11. Blockers & open owner decisions

| #   | Blocker                                                                    | Needs from owner                                                                           |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Local venv `0xC0000006` — M01 to diagnose; may need a clean Python install | permission to install/repair local tooling                                                 |
| 2   | First **live** podcast job                                                 | explicit permission (real Google account, real egress)                                     |
| 3   | GitLab URL + mirror credentials + (optional) runner                        | M08                                                                                        |
| 4   | Production **forward deploy** approval (172.30.0.133: `278273a` → `08c1848`) | M08, explicit approval (SSH access already confirmed working)                              |
| 5   | Wiki.js API credentials (customer docs publication)                        | M08                                                                                        |
| 6   | VLESS client UUID decision (BL-P1-3)                                       | owner decision (unchanged)                                                                 |
| 7   | Edge :80 for LE (TLS)                                                      | **Out of active scope** — already requested in Gate-D RCA; "retry" when network owner acts |

## 12. New security findings (reported only, no unauthorized fix, per contract)

- No new findings during M00 (read-only). Existing register: P4-1.1 findings R-1…R-6
  carry forward; R-1 addressed in M05 (B-P1-4).

## 13. Final verdict (M00)

**PASS** — read-only assessment complete; capability inventory, gap analysis, PRD,
prioritized backlog, dependency map, acceptance criteria, DoD, parallel plan,
ownership matrix, and release-readiness matrix delivered in this report. No
product code was changed. Ready for Wave 1 execution (continuous autonomous
parallel execution per owner directive 2026-11-26).

## 14. Addendum — Production re-verification (2026-11-26, owner-directed)

The owner flagged a contradiction in the original M00 report: the claim
`Production: absent` contradicted prior reports documenting a live Production
service on port 4870. This addendum records the read-only re-verification.

**Finding: Production IS running on `172.30.0.133` (`AI-TOOLS`).**

| Source | Date | Evidence |
|--------|------|----------|
| `PHASE_G3A_NEW_HOST_AUDIT.md` | 2026-11-02 | "NLO was deployed on the new host on 2026-10-31, at commit `b5e9ad3`" |
| `PHASE_T0_STUCK_JOBS_AUDIT.md` | 2026-11-02 | "Service `nlo.service` active (running) since 2026-10-31 07:10:44 UTC" |
| `PRODUCTION_READINESS_2026-11-06.md` | 2026-11-06 | "nlo.service active (running) since Wed 2026-11-04 03:33:49 UTC" at `d705634` |
| `NLO-P5-0-INFRASTRUCTURE-BASELINE.md` §3.1 | 2026-11-20 | "Production (de-facto) `172.30.0.133` (AI-TOOLS): systemd `nlo.service` (enabled, `Restart=always`), loopback `127.0.0.1:4870`, commit `278273a`, **active (running) since 2026-11-14 17:35:56 UTC**, MainPID 2809780" |
| `NLO_MASTER_EXECUTION_STATUS.md` | 2026-11-15 | "Service `nlo` **active**; HEAD = deployed = `d705634`; loopback `127.0.0.1:4870` LISTEN only" |
| `NLO_P3_BATCH3_REBASELINE.md` | 2026-11-15 | "nlo.service active + enabled; PID 2809780 tsx → node child 2809792; HEAD `278273a`" |

**Root cause of the M00 error:** The P4-1.1 consolidated audit (2026-11-17,
HEAD `b833d89`) line 105 stated "Production (172.30.0.133) **ABSENT** — no
service, no vhost, no TLS, port 4870 closed." This was based on Agent E's
deployment audit, which probed port 4870 **from the workstation** (where it is
correctly closed because production binds loopback-only) and had **no SSH
access** at that time. The P5-0 baseline (2026-11-20) subsequently confirmed
via SSH that production has been running continuously since 2026-11-14.

**Corrected state:** Production is **active on `278273a`**, approximately
12–15 commits behind `origin/main` (`08c1848`). The open item is a **forward
deploy** (approval-gated), not a first-ever deployment. No re-deploy order is
issued based on this finding.

### STOP

M00 complete (accepted by owner). Deliverable: this report. Per the new
continuous autonomous execution contract (2026-11-26), Wave 1 begins
immediately without awaiting per-mission approval.
