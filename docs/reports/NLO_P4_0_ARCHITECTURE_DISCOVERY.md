# NLO-P4-0 Architecture Discovery — Final Report

**Mission:** NLO-P4-0 "Universal Modular Architecture & NotebookLM Ecosystem Discovery"
**Mode:** research + source-audit + architecture design — **no implementation, no runtime changes, no migrations, no pushes**
**Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f0376fdab59a6601842ca0fb39893943441` (origin: `https://github.com/saber13812002/notebooklm-orchestrator.git`)
**Companion docs:** 23 deliverables (list in §4) · ADRs ADR-001…ADR-007 in [`docs/architecture/decisions/`](../architecture/decisions/)

---

## 1. Executive summary (1 page)

**What this mission was.** Design the transformation of NLO — today a single-NotebookLM-method service (`nlo`, port 4870, with verified live Google connectivity and a real audio→text pipeline) — into a **modular platform**: multiple content engines, multiple connection methods, multiple Google accounts, multiple proxies, multiple MCP integrations (as client *and* server), with failover. The mission was strictly read-only: audit the source, research the ecosystem with dated evidence, and produce a complete, honest, cross-referenced design.

**Five headline findings.**
1. **There is no official API** for NotebookLM/Gemini Notebook (consumer or Enterprise) as of 2026-11-15. Google renamed the product to **Gemini Notebook** on 2026-07-16 (official blog, verified); hosts and the undocumented internal RPC surface are unchanged. Every programmatic access in the ecosystem — including NLO's own — rides on browser cookies or the Android backend.
2. **The ecosystem's strongest project (notebooklm-py, 20,238★, v0.8.6; NLO pins 0.8.5) already supports everything NLO's templates need** — audio, infographics, reels/shorts video, reports, quizzes — including deferred (`later=True`) task-id+poll generation, the same contract NLO already persists. T3/T4 are a **worker-surface gap, not a capability gap** (P4-5).
3. **No ecosystem project supports proxy/egress.** NLO's VLESS fail-closed egress (live-verified in P0/P2) is a differentiator; the current coupling (tunnel env var injected into the Python worker) is the main anti-seam the target architecture removes via the **Egress Gateway** (ADR-004).
4. **The hard parts are recovery semantics, not features.** The ecosystem proves the demand (roomi-fields v4.6.0 "retry without losing the id") but no project solves it. The design's core is the **UNKNOWN_EXTERNAL_STATE rule**: poll-first, adopt-don't-resubmit, settle-once, park-when-unverifiable — expressible with **no new job statuses** (ADR-007).
5. **One domain, four doors** (UI / REST / MCP / external E2E) is enforced by a four-path acceptance matrix with honest labels; a capability accepted on REST but broken on MCP is a P4 regression. MCP is a *thin anti-corruption layer over the domain services*, with **9 tools: 7 wrappers of existing routes + 1 wrapper of the P4-4 retry endpoint + `list_templates` the single genuinely new capability** (ADR-005).

**What was designed (all PROPOSED, none implemented):** Provider Registry + capability contracts + conformance suite C1–C7 (declared = tested, undeclared = unavailable) · Google Account Manager (4 credential kinds, scheduled keepalive K=240 min, 5-step routing) · Egress Gateway (`acquire/release`, per-provider policy, fail-closed preserved) · Universal Content Intake (PDF/MD/video/URL, untrusted-content rule, LLM enrichment best-effort) · Templates T1–T4 as versioned data · Manual Retry from last safe checkpoint (`/retry`, `/checkpoints`, `/recheck`) · Provider failover matrix per `FailureClass` · MCP server (Streamable-HTTP, per-tool scopes) and MCP client (`mcp_client` provider kind via static mapping files) · DDD bounded contexts (modular monolith, microservices explicitly *not* on the P4 path).

**How it gets built.** Eight sequentially-gated phases, **P4-1…P4-8**, ~72 SP, each an independently shippable, revertible, tested increment with its own acceptance gate across all four paths and a budgeted manual live gate (mock is never reported as live). P4-1 is a **pure refactor** of the live-proven provider path behind the registry — conformance green before/after is its acceptance proof.

**Risk posture.** The operational system is untouched by this mission (zero code changes). The top implementation risk is P4-1's refactor of a live path; it is gated by a full regression + conformance before/after comparison. Everything else is additive.

**Decision requested.** Owner approval to begin **P4-1** (foundations) per [`NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`](../roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md). No phase, push, or external action starts before approval.

---

## 2. The 25 discovery questions (with evidence-based answers)

### A. Current state of the operational system

**Q1. What exactly is implemented and verified in NLO at `76cd5f03`?**
The job engine (12-status state machine, 7-status restart recovery, in-process queue, worker supervisor with settle-once) is `IMPLEMENTED` + `INTEGRATION_TESTED` (24 server test files, 11 shared unit test files). Text→notebook and audio→podcast flows are `LIVE_VERIFIED` (P0/P2 acceptance reports). Fail-closed VLESS egress is `IMPLEMENTED` + `INTEGRATION_TESTED` + `LIVE_VERIFIED` (`fail-closed.test.ts`). Accounts/sessions (9-state machine, 10-min verification TTL) are `IMPLEMENTED` + `INTEGRATION_TESTED`. MCP, multi-account routing, universal intake, templates, checkpoint retry: `NOT_IMPLEMENTED`. Canonical table: [`NLO_P4_TARGET_ARCHITECTURE.md` §1](../architecture/NLO_P4_TARGET_ARCHITECTURE.md).

**Q2. What is the production-host situation?**
The legacy host **s52 (`172.20.1.52`) was decommissioned 2026-11-01** (unreachable). Re-deployment on `172.30.0.133` is the pending endpoint-migration addendum (Phases A–F audited, `docs/reports/SERVER_ENDPOINT_MIGRATION_*.md`). Local dev servers run on 4870/4871. P4 deliberately does not change deployment posture (systemd `nlo`, git-based `deploy/deploy.sh`).

**Q3. Where are the architectural seams for modularization?**
Dependency map (Mermaid) in [`NLO_P4_TARGET_ARCHITECTURE.md` §2](../architecture/NLO_P4_TARGET_ARCHITECTURE.md). Seams: the in-process queue interface, the worker protocol (JSON-lines over stdio), the provider boundary (python worker), the accounts/sessions repos. **Main anti-seam:** the proxy `tunnelEnv` env var injected into the Python worker — egress is coupled to provider internals; fixed by the Egress Gateway (ADR-004).

**Q4. What are the current system's honest limitations?**
No official API (cookies are the transport); browser required for login; single worker, single provider; no checkpoint retry (only `requeue` of parked jobs); no MCP; no multi-account rotation (single-account with `preferredAccountId` hint); intake limited to text/txt/docx/srt/audio; no templates; enrichment absent. All carried as explicit rows in the capability matrix.

**Q5. What risks does P4 pose to the operational system, and how are they gated?**
Top risk: P4-1's refactor of the live-proven provider path. Gates: pure-refactor rule, conformance C1–C6 green **before and after**, full regression suite green, git-based rollback to previous-good commit. Every other phase is additive (new routes, new tables with migrations, new worker ops behind capability declarations).

### B. Provider ecosystem

**Q6. Is there an official NotebookLM/Gemini Notebook API?**
**No** (verified 2026-11-15): no public REST/gRPC for consumer or Enterprise; the Enterprise docs URL 404s; no `notebooklm` GitHub org exists. The rebrand to *Gemini Notebook* (2026-07-16, Josh Woodward blog) changed neither. Evidence: [`NLO_PROVIDER_ECOSYSTEM_RESEARCH.md`](../research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md) §2.

**Q7. Which ecosystem projects are real, and what is their status?**
notebooklm-py — 20,238★, v0.8.6, pushed 2026-11-13, MIT (NLO pins 0.8.5); gemini-notebook-mcp-cli — 6,517★, v0.16.5 (55 tools, enterprise `EXPERIMENTAL`, protected storage, PSIDTS browser-bound); roomi-fields — 241★ (multi-account rotation, v4.6.0 retry-without-losing-id); abdallah-nasir/notebooklm-mcp — 0★, stale npm mirror of PleasePrompto (Patchright, `_provenance` envelope). All verified 2026-11-15 via GitHub API + READMEs.

**Q8. Which generation operations exist upstream vs. in the NLO worker?**
Upstream (nblpy): audio podcast (4 formats), infographics, video (4 formats × 8 styles), reports, quizzes, flashcards, slide decks — with deferred `later=True` generation (v0.8.6: "task id + poll", `scheduled` status). NLO worker: text→notebook + audio→podcast only. **T3/T4 gap = worker ops + artifact delivery, not a new library** (P4-5).

**Q9. Which design choices have ecosystem precedent?**
Retry that preserves identity (roomi v4.6.0); multi-account rotation at the routing layer (roomi-fields); untrusted-content tagging (PleasePrompto `_provenance` / "treat citations as untrusted input"); master-token self-healing, browser-free (nblpy); enterprise host config model (gemini-notebook-mcp-cli, `EXPERIMENTAL`). Adopted per ADR-002/003/005/006/007 with the deltas stated.

**Q10. Does any ecosystem project support proxy/egress?**
**No** — verified across all four projects (no proxy section in any README). NLO's VLESS fail-closed egress is unique in the ecosystem and is preserved + generalized (ADR-004).

### C. Google auth, sessions, accounts

**Q11. What credential mechanisms does Google actually expose?**
Browser cookie extraction (Playwright), cookie-file import, **master token** (Android backend, mints fresh web cookies on demand — "the auth model for servers, CI"), enterprise SSO against `notebook.cloud.google.com`. **There is no OAuth refresh token anywhere** — "refresh" everywhere means re-extract or re-mint. Evidence: [`NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md) §1–2.

**Q12. How long do sessions live, and what does refresh cost?**
Cookie lifetime 2–4 weeks; verification TTL 10 min (job admission). Keepalive design: scheduled re-verification every K=240 min with a failure budget of 3 (`degraded` → `needs_reauth`), browser-free for master-token kinds.

**Q13. What credential kinds should NLO support, and what is their risk ranking?**
`storage_state` (implemented), `cookie_file` (import path + `.google.com` domain-selection rule), `master_token` (**full-account credential** — highest value, dedicated account required, vault 0600, upstream `EXPERIMENTAL`), `enterprise_sso` (project-bound, upstream `EXPERIMENTAL`). Table + onboarding steps: [`NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md` §2](../architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md).

**Q14. What existing session machinery is preserved unchanged?**
The 9-state `AuthSessionState` machine, the 10-min verification TTL, `WAITING_FOR_ACCOUNT` parking, and "a DB status flag alone is NEVER evidence of authentication". The Account Manager is a *policy layer on top*, not a replacement (ADR-003).

**Q15. Is enterprise access real, and what is NLO's evidence?**
Ecosystem evidence: gemini-notebook-mcp-cli has enterprise support marked `EXPERIMENTAL` (live-verified by that project for the `global` deployment). NLO's own evidence: **none yet** — `NOT_TESTED`; a live run against a real GCP project is a precondition for claiming `IMPLEMENTED` (P4-3/P4-7).

### D. Proxy / egress

**Q16. How does NLO currently use proxies, with what evidence?**
VLESS tunnels via xray per node, supervisor-managed, env-injected into the Python worker; **fail-closed** (no verified tunnel ⇒ no direct egress) — `IMPLEMENTED` + `INTEGRATION_TESTED` (`fail-closed.test.ts`) + `LIVE_VERIFIED` (P0 audio, P2 stages). Evidence: [`NLO_PROXY_EGRESS_RESEARCH.md`](../research/NLO_PROXY_EGRESS_RESEARCH.md).

**Q17. What is wrong with the current coupling?**
`tunnelEnv` couples egress to provider internals (the provider *receives* its network). Target: `EgressGateway.acquire(jobCtx, policy) → EgressEndpoint { localPort, expectedEgressIp, nodeId, evidenceRef }` + `release`; per-provider policy (`must-tunnel`/`tunnel-preferred`/`direct-allowed`); fail-closed preserved (ADR-004).

**Q18. Do egress IPs behave differently against Google's bot checks?**
**Unknown — no measurement exists.** The design records `evidence` per check so the data accumulates; no routing decision is made on unmeasured assumptions.

**Q19. Is a session sensitive to egress-IP change (account↔node affinity)?**
Hypothesis, **NOT_TESTED**. Design provides account↔node affinity as a routing step with a **kill-switch**, so it can be enabled/disabled without a release.

**Q20. What are the multi-tunnel concurrency limits?**
**NOT_TESTED under load.** Supervisor tunnel map is in-memory; boot recovery re-creates tunnels lazily. C5 conformance (concurrency, wedge-free) covers the queue side in P4-1.

### E. Platform transformation

**Q21. How does NLO become multi-engine?**
**Modular monolith** (not microservices — ADR-001) with 8 bounded contexts, a shared kernel (job-state, retry, redaction, safe-name, ssrf, api-error), and the **Provider Registry as the core mechanism**: capability matrix as data, conformance C1–C7 as the admission gate, "undeclared = unavailable" enforced structurally. Microservices exit criteria are written down for the day the service outgrows single-process.

**Q22. How is universal content intake designed?**
Formats are **config + capability data** (never hardcoded per provider); extraction is a *translation* ("text out, provenance in"); the **untrusted-content rule** is a context-wide invariant (delimited `<<<SOURCE>>>` region, control block from validated inputs only, redaction on derived text); T1–T4 are **versioned data** in `content_templates`; LLM enrichment is best-effort and **never fails a job** (ADR-002 + intake spec).

**Q23. How is job recovery designed?**
Three failure modes (Unavailable / Operation Failed / **Outcome Unknown**); poll-first decision table (complete→adopt, running→keep polling, not found→resubmit once + `external_id_orphaned`, unverifiable→park `NEEDS_ATTENTION`); **settle-once** via DB job lock (at most one process may believe it is the submitter); manual retry = RETRY FROM LAST SAFE CHECKPOINT with `/checkpoints` + `/recheck`; failover matrix per `FailureClass`; cross-provider failover deferred to P4-7; **no new job statuses** (ADR-007 + manual retry spec).

**Q24. How is MCP integrated in both directions?**
**Server (ADR-005):** one domain, two front doors — thin ACL over domain services; Streamable-HTTP `/mcp` on the existing loopback Fastify; 9 tools (7 wrappers + `retry_job` + genuinely-new `list_templates`); existing API tokens with per-tool scopes + `via:"mcp"` audit; long ops return a job id; no secrets in schemas/results. **Client (ADR-006):** external MCP servers = `mcp_client` registry entries via **static mapping files** (capability honesty by mapping, not faith); `WorkerSupervisor` lifecycle for stdio children; `envSecretRefs` from the vault; C7 live spot-check **before** admission; `resultProvenance` honest.

**Q25. What is the implementation sequence, and what must each phase prove?**
P4-1 foundations (registry + gateway + DB lock + C1–C6 suite + secret-scan gate, pure refactor) → P4-2 intake + templates → P4-3 accounts + egress policy → P4-4 retry + UNKNOWN_EXTERNAL_STATE + failover (all 8 fault-injection scenarios F1–F8 green) → P4-5 T3/T4 worker ops → P4-6 MCP server (9 tools + four-path reference scenario) → P4-7 MCP client + Android gRPC + Enterprise transports → P4-8 hardening (full matrix re-run, parity report, standards audit, live-gate evidence bundle). ~72 SP total; per-phase acceptance is defined per path in the acceptance matrix and test strategy; each phase ends with owner approval. Full prompts: [`NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`](../roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md).

---

## 3. Final status table

Status vocabulary: `IMPLEMENTED` (+ test/live verification level) · `PROPOSED` (designed, approved-in-docs only) · `NOT_IMPLEMENTED` · `BLOCKED` (precondition named) · `NOT_TESTED`.

| Area | Current Status | Evidence | Remaining Work | Next Prompt |
|---|---|---|---|---|
| Job engine & state machine | `IMPLEMENTED` + `INTEGRATION_TESTED` (restart recovery, settle-once) | 24 server + 11 shared test files; `job-state.ts` | DB job lock for multi-writer growth path; F9/F10 scenarios | P4-1 |
| NotebookLM provider integration | `IMPLEMENTED` + `LIVE_VERIFIED` (text P1, audio P0) | `podcast-lifecycle.test.ts`, `e2e-text-to-podcast.test.ts`, P0/P1/P2 reports | move behind Provider Registry (pure refactor); conformance before/after | P4-1 |
| Capability matrix & honesty | `PARTIAL` (per-provider input-format matrix exists; no registry API) | `input-capabilities.ts` + tests; `/api/providers`-class routes | registry API `GET /api/v1/capabilities`; C1–C7 conformance suite in CI | P4-1 |
| Content intake & formats | `IMPLEMENTED` text/txt/docx/srt/audio (+`LIVE_VERIFIED` audio) | `document-sources.test.ts`, `from-text.test.ts`, P0/P1 evidence | pdf/md extraction; video (audio-track); URL (SSRF-guarded); untrusted-content rule | P4-2 |
| Templates T1–T4 | T1/T2 `IMPLEMENTED`-equivalent (`podcast.format` exists) · T3/T4 `NOT_IMPLEMENTED` | `job-create.ts:258` `promptVersion`; `types.ts` `podcast.format` | `content_templates` table + seed; 3-region renderer; `GET /api/v1/templates`; create-with-template; capability gate at create | P4-2 |
| Google accounts & sessions | `IMPLEMENTED` + `INTEGRATION_TESTED` (9-state machine, storage_state, 10-min TTL) | `accounts.repo.test.ts`, `session-gate.test.ts`; P2 stage-2 report | 4 credential kinds (master_token, enterprise_sso = `NOT_TESTED`); keepalive K=240 + budget 3; 5-step routing; affinity kill-switch | P4-3 |
| Proxy / egress | `IMPLEMENTED` + `INTEGRATION_TESTED` + `LIVE_VERIFIED` (fail-closed VLESS) | `fail-closed.test.ts`; P0/P2 stage-3/4 reports | Egress Gateway `acquire/release`; per-provider policy; node selection + concurrency cap; env-injection removed | P4-3 |
| Retry / failover / recovery | `NOT_IMPLEMENTED` (only `requeue` for parked jobs) | P1 acceptance matrix; `JOB_RECOVERY_RUNBOOK.md` | `/retry` + `/checkpoints` + `/recheck`; UNKNOWN_EXTERNAL_STATE poll-first; failover matrix; F1–F8 scenarios green | P4-4 |
| T3/T4 content engines (infographic, reels/shorts) | `NOT_IMPLEMENTED` (upstream library supports both — VERIFIED 2026-11-15) | nblpy README feature table; `NLO_PROVIDER_CAPABILITY_CONTRACTS.md` §5 | worker ops `generate.infographic` / `generate.video`; artifact types PNG/mp4; C3 conformance; live gate | P4-5 |
| MCP server (NLO as server) | `NOT_IMPLEMENTED` | — | 9 tools, Streamable-HTTP, per-tool scopes, envelope mapping, parity harness, four-path reference scenario | P4-6 |
| MCP client / external providers | `NOT_IMPLEMENTED` (no ecosystem proxy support; adapter designed) | MCP comparison doc; ADR-006 | `mcp_client` kind + static mapping files; stdio lifecycle via WorkerSupervisor; C-suite incl. C7 before admission | P4-7 |
| New transports (Android gRPC, Enterprise host) | `NOT_IMPLEMENTED` (upstream `EXPERIMENTAL`) | nblpy Android backend docs; gemini-notebook-mcp-cli enterprise (live-verified by that project) | thin adapters, live-verified before enablement; master-token cookie-free path | P4-7 |
| Webhooks | `IMPLEMENTED` + `INTEGRATION_TESTED` (exactly-once, HMAC) | `webhooks.test.ts`; webhook runbook | P4 event types (`unknown_external_state_*`, `failover_*`, `retry_*`, `template_applied`) | P4-4/5/6 |
| Security invariants | `IMPLEMENTED` + `UNIT_TESTED` (redaction, SSRF, safe names, loopback default) | shared unit tests; `SECURITY.md` | CI secret-scan hard gate; file-permission assertions; MCP schema no-secrets unit; untrusted-content invariants | P4-1 (scan), P4-2 (intake), P4-6 (MCP) |
| Testing infrastructure | `IMPLEMENTED` (4-level discipline, 13 `E2E_*` codes, four-path matrix P1) | `E2E_TEST_STRATEGY.md`, `ACCEPTANCE_MATRIX.md`, `nlo-e2e` runner | P4 matrix rows; C1–C6 suite; F1–F10 fixtures; MCP harness; live-gate budget enforcement | P4-1…P4-8 |
| Deployment & operations | `IMPLEMENTED` (systemd `nlo`, git deploy, backups; s52 decommissioned, 133 pending) | `deploy/deploy.sh`; migration-phase reports | no change in P4 (posture preserved); runbook extensions per phase | P4-3, P4-8 |

---

## 4. Deliverables (23 documents, all created in this mission)

| # | Document | Role |
|---|---|---|
| 1 | [`docs/research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md`](../research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md) | Ecosystem map, official-API negative finding, transports |
| 2 | [`docs/research/NLO_NOTEBOOKLM_MCP_COMPARISON.md`](../research/NLO_NOTEBOOKLM_MCP_COMPARISON.md) | 4-project comparison, tool mapping, adoptable patterns |
| 3 | [`docs/research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md) | Credential mechanisms, lifetimes, `account_credentials` schema |
| 4 | [`docs/research/NLO_PROXY_EGRESS_RESEARCH.md`](../research/NLO_PROXY_EGRESS_RESEARCH.md) | Proxy survey (negative finding), egress open questions |
| 5 | [`docs/architecture/NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md) | Target architecture, dependency map, 8 contexts, migration path |
| 6 | [`docs/architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md) | Capability model, operation interface, conformance C1–C7 |
| 7 | [`docs/architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`](../architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md) | Account Manager, 4 credential kinds, keepalive, routing, egress |
| 8 | [`docs/architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md`](../architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md) | Universal intake pipeline, untrusted-content rule, templates-as-data |
| 9 | [`docs/architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`](../architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md) | 3 failure modes, UNKNOWN_EXTERNAL_STATE, manual retry, failover matrix, F1–F8 |
| 10 | [`docs/architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md`](../architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md) | MCP server (9 tools) + client (`mcp_client`) design |
| 11 | [`docs/architecture/decisions/ADR-001-modular-architecture.md`](../architecture/decisions/ADR-001-modular-architecture.md) | Modular monolith + bounded contexts + Provider Registry as core mechanism |
| 12 | [`docs/architecture/decisions/ADR-002-content-intake.md`](../architecture/decisions/ADR-002-content-intake.md) | Intake context, untrusted-content rule, templates-as-data, best-effort enrichment |
| 13 | [`docs/architecture/decisions/ADR-003-account-session.md`](../architecture/decisions/ADR-003-account-session.md) | 4 credential kinds, keepalive, routing policy, 9-state machine preserved |
| 14 | [`docs/architecture/decisions/ADR-004-egress-gateway.md`](../architecture/decisions/ADR-004-egress-gateway.md) | Egress Gateway API, per-provider policy, fail-closed, node selection |
| 15 | [`docs/architecture/decisions/ADR-005-mcp-server.md`](../architecture/decisions/ADR-005-mcp-server.md) | NLO as MCP server: 9 tools, ACL-over-domain, scopes, envelope |
| 16 | [`docs/architecture/decisions/ADR-006-mcp-client-external-providers.md`](../architecture/decisions/ADR-006-mcp-client-external-providers.md) | NLO as MCP client: mapping files, lifecycle, provenance discipline |
| 17 | [`docs/architecture/decisions/ADR-007-retry-failover.md`](../architecture/decisions/ADR-007-retry-failover.md) | Poll-first, settle-once, checkpoint retry, failover matrix, no new statuses |
| 18 | [`docs/product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md`](../product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md) | Product spec: intake surface, validation guarantees, T1–T4 catalog |
| 19 | [`docs/product/NLO_MANUAL_RETRY_SPEC.md`](../product/NLO_MANUAL_RETRY_SPEC.md) | Product spec: safe checkpoint, retry semantics, operator UX |
| 20 | [`docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md`](../testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md) | 13-row × 4-path matrix, reference scenario, per-phase gates |
| 21 | [`docs/testing/NLO_P4_FUTURE_TEST_STRATEGY.md`](../testing/NLO_P4_FUTURE_TEST_STRATEGY.md) | 14-category strategy matrix, F1–F10, live budget, standards audit |
| 22 | [`docs/roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`](../roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md) | P4-1…P4-8 implementation prompts, SP estimates, acceptance, deliverables |
| 23 | this report | 25 questions, final status table, executive summary, quality gates |

---

## 5. Quality gates (A–F)

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| **A — Source audit** | Every major runtime module read; dependency map + coupling analysis produced; baseline status table with honest labels | **PASS** | target-arch §1 (baseline table) + §2 (Mermaid dependency map); audit todos 2–6 complete at `76cd5f03` |
| **B — Ecosystem research integrity** | Every ecosystem fact verified 2026-11-15 with a named source (GitHub API / README / official blog); no invented address, token, or setting | **PASS** | 4 research docs, each fact carries a verification date + source; 404s and UNKNOWNs recorded honestly (no silent guesses) |
| **C — Design completeness** | All 10 design work items covered; 23 deliverables exist; 7 ADRs with context/decision/alternatives/evidence | **PASS** | deliverable table §4; ADR-001…007 each contain Context, Decision, Alternatives, Consequences, Evidence with file links |
| **D — Cross-reference consistency** | ADR numbering, phase-name mapping (P4-1…P4-8), companion links consistent across all docs | **PASS** | grep-verified after ADR reconciliation (ADR-001 umbrella incl. Provider Registry; ADR-005/006 split) and phase-drift fixes (target-arch §7; account/arch + auth-research P4-4→P4-3 refs; MCP comparison retry ref) |
| **E — Repository hygiene** | Only mission docs added; the 2 pre-existing untracked P3-batch3 reports preserved; `data/tmp-nlo-research-*` cleaned; no secrets in any new doc (secret scan) | **PASS** (verified 2026-11-15 15:12 UTC) | `git status` at commit step: exactly 23 new mission docs + 4 modified master docs staged via explicit paths (no `git add -A`); `docs/reports/NLO_P3_BATCH3_BACKUP_ROLLBACK.md` + `NLO_P3_BATCH3_REBASELINE.md` left untracked (preserved); all 23 `data/tmp-nlo-research-*` files deleted; secret scan across `docs/` — hits only in pre-existing reports (self-references of earlier scans), zero in mission docs |
| **F — No runtime change** | Zero code/config/DB changes in this mission; baseline test suite still green | **PASS** (verified 2026-11-15 15:12 UTC) | diff is docs-only (23 new `.md` + 4 modified master `.md`; the 4 cross-reference fixes are inside the new mission docs); `npm test` re-run at commit step: **426/426 tests passed** — shared 110/110 (11 files), server 286/286 (24 files), web 30/30 (4 files); identical to the pre-mission baseline at `76cd5f03` |

---

## 6. Open questions carried forward (honestly, each with an owner-phase)

1. `get_artifact` body-vs-URL — P4-6 decision (ADR-005 open questions).
2. MCP server→client notifications — deferred (polling + webhooks are the P4 contract).
3. stdio child env isolation — spec'd in P4-7 (ADR-006).
4. External MCP server versioning — `serverVersionRange` ⇒ `degraded`, decided in the P4-7 mapping format.
5. PDF extraction library (JS vs Python-side) — decided in P4-2 (content-intake doc §5).
6. URL fidelity (no JS rendering) — stated limit; headless rendering is P4-later.
7. Enrichment language quality — `NOT_TESTED` until the internal LLM proxy is available.
8. Video container whitelist — starts `mp4/mov/webm`; config-only extension after ffmpeg probing.
9. T3/T4 param surface — zod schema drafted in P4-5.
10. Cross-provider auto-failover — proposed in P4-7, enabled only with per-provider stage mapping + conformance parity.

---

## 7. Mission conclusion

The NLO-P4-0 mission is **complete**: the codebase was audited source-first at `76cd5f03`, the ecosystem was researched with dated, sourced evidence, the full target architecture was designed (8 bounded contexts, Provider Registry, Egress Gateway, Account Manager, universal intake, templates, recovery/failover, MCP both directions), 7 ADRs record the decisions, product specs and the four-path acceptance + test strategy define *how* success is measured, and an 8-phase implementation prompt roadmap (~72 SP) sequences the work so each phase is independently shippable, revertible, and honestly verified. Nothing was implemented, migrated, pushed, or changed at runtime.

**FINAL STATUS: NLO_P4_0_RESEARCH_COMPLETE — WAITING_FOR_OWNER_APPROVAL**
