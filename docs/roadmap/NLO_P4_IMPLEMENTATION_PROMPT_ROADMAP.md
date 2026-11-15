# NLO-P4 Implementation Prompt Roadmap

Mission: **NLO-P4-0** (research/design only — this roadmap is the *output* of that mission). Baseline: `main @ 76cd5f03`.
Companion docs: target architecture [`NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md) · acceptance [`NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md`](../testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md) · test strategy [`NLO_P4_FUTURE_TEST_STRATEGY.md`](../testing/NLO_P4_FUTURE_TEST_STRATEGY.md) · ADRs [`decisions/`](../architecture/decisions/) ADR-001…ADR-007.

**How to use this document.** Each phase below is a self-contained *implementation prompt* — copyable verbatim into a fresh agent session or human work order. Phase discipline per AGENTS.md §9: each phase ends with tests run, evidence presented, changed files + commits reported, remaining limitations stated, and **owner approval requested before the next phase**. Nothing destructive or externally visible (push, publish, DNS, proxy) happens inside a phase not approved for it.

**Standing invariants for every phase (inherited, do not re-negotiate):**
1. Read-only baseline check first: `git status` clean (except the two preserved untracked P3-batch3 reports), HEAD reachable from `origin/main`.
2. Source-first, honest status labels (`IMPLEMENTED` / `CODE_VERIFIED` / `UNIT_TESTED` / `INTEGRATION_TESTED` / `LIVE_VERIFIED` / `PARTIAL` / `EXPERIMENTAL` / `NOT_IMPLEMENTED` / `BLOCKED` / `NOT_TESTED` / `PROPOSED`).
3. Mock is never reported as live. Live runs are a manual gate with the budget in [`NLO_P4_FUTURE_TEST_STRATEGY.md` §4](../testing/NLO_P4_FUTURE_TEST_STRATEGY.md).
4. Tests + docs + CHANGELOG entry + one clear commit per phase (message states goal + scope). No `git add -A`.
5. The pre-commit checklist (AGENTS.md §10) is a hard gate: typecheck, lint, format:check, `npm test`, build all green.
6. **Phase name mapping is canonical** (target-arch §7 and all downstream docs agree on this): P4-1 foundations/registry · P4-2 intake+templates · P4-3 accounts/egress · P4-4 retry/failover · P4-5 T3/T4 content engines · P4-6 MCP server · P4-7 MCP client + new transports · P4-8 hardening.

**SP scale** (story points, single-developer, includes tests + docs + report): 2 = small slice · 5 = one focused workstream · 8 = workstream with a live gate or a second workstream · 13 = workstream + hardening + evidence bundle. Totals are planning estimates, not commitments.

---

## P4-1 — Foundations: Provider Registry + Egress Gateway interface + conformance suite

**Goal.** Make the Provider Registry (ADR-001) and the Egress Gateway (ADR-004) *real interfaces* with the existing NotebookLM python-worker provider moved behind them as a **pure refactor** — zero behavior change, conformance green before/after. Add the DB job lock (settle-once arbiter for the multi-worker growth path) and the CI secret-scan gate.

**Scope (in):**
- `packages/shared`: `ProviderDescriptor` type + descriptor registry module (kind `native` | `mcp_client`; capability matrix with the existing 5 `CapabilityLevel` values; egress policy enum `must-tunnel` | `tunnel-preferred` | `direct-allowed`; `maxConcurrent`; `verifiedAt`).
- `apps/server`: existing python-worker provider wrapped in a `ProviderDescriptor` + adapter implementing the operation interface (create→add→generate→poll→fetchArtifact); `GET /api/v1/capabilities` (per-provider × per-operation matrix, honest levels — the matrix *data* for the UI view).
- **Egress Gateway interface** over the existing proxy manager: `acquire(jobCtx, policy) → EgressEndpoint { localPort, expectedEgressIp, nodeId, evidenceRef }` + `release`; the `tunnelEnv` env-injection coupling is **removed** (worker gets `EgressEndpoint`, not an env var). Fail-closed behavior preserved (`fail-closed.test.ts` must stay green and is extended to the gateway API).
- **DB job lock** (single-writer settle-once mechanism; acceptance scenario F9: two workers, one submitter).
- **Conformance suite C1–C6 infrastructure** (per [`NLO_PROVIDER_CAPABILITY_CONTRACTS.md` §4](../architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md)) as a CI-runnable test target: C1 declaration lint, C2 capability honesty (a `c2:<provider>:<op>` test per declared op; undeclared ops rejected cleanly), C3 lifecycle, C4 failure classes, C5 concurrency, C6 egress. Run green against the existing adapter.
- ESLint boundary rule: contexts may not import another context's repos directly (context boundaries per ADR-001).
- CI: add the secret-scan gate (hard fail; AGENTS.md §2).

**Out of scope (deferred, stated):** multi-worker mode (single worker stays — growth path target-arch §6); N in-process workers; any new provider; any format/template/retry/MCP work.

**Acceptance (per path — from the matrix):**
- REST: `GET /api/v1/capabilities` `INTEGRATION_TESTED`; all existing endpoints byte-identical in behavior (regression suite green = refactor proof).
- External E2E: contract check vs OpenAPI extended with the capabilities route; C1–C6 green in CI.
- UI: no visible change (capability view is P4-2); component tests unaffected.
- MCP: n/a (P4-6).
- Test strategy rows: §2 rows 1, 2, 3 (lock), 10 (suite), 14 (scan gate); scenarios F9, F10.

**Deliverables:** changed files + commit list; before/after conformance run evidence; refactor regression report (same test outcomes, no new failures); capabilities API example response; secret-scan gate evidence; phase report in `docs/reports/NLO_P4_1_*.md` with remaining limitations.

**SP estimate: 8** (pure refactor of a live-proven path + new infrastructure + CI gate; the risk is the refactor, the points are the evidence).

---

## P4-2 — Universal Content Intake + Templates T1–T4

**Goal.** Universal file intake (PDF/MD/video/URL on top of the existing text/txt/docx/srt/audio) with the untrusted-content rule, and templates T1–T4 as **versioned data** with `GET /api/v1/templates` + create-with-`template`. Spec: [`NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md`](../product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md); ADR-002.

**Scope (in):**
- Migration: `content_templates` table (id/version/display_name/description/input_kinds/prompt/params/capabilities/artifacts/status) + seed rows T1 `t1_deep_dive@1`, T2 `t2_debate@1`, T3 `t3_infographic@1`, T4 `t4_reels@1` (T3/T4 status `available` only after P4-5 — listed with reason `worker op not implemented` until then).
- Intake: `pdf` + `md` extraction (library choice decided here: JS `pdfjs-dist` vs Python-side in the existing venv — whichever keeps the worker protocol simplest); video containers `mp4`/`mov`/`webm` (ffmpeg audio-track extraction via existing `media/transcode.ts`, container metadata recorded, **video without audio track rejected at validation** with `invalid_input`); URL inputs (`from-text` with `source: { url }`) — SSRF `assertSafe` before dialing, size-capped, `text/html`+`text/plain` only, **no JS rendering** (stated limit).
- **Untrusted-content rule** (context-wide invariant): `<<<SOURCE>>>…<<<END SOURCE>>>` delimited region; control block built only from validated inputs; `sourceProvenance { kind, originalName, sha256, fetchedFrom?, extractedVia? }` on every source; derived text passes the existing redaction module.
- 3-region prompt renderer (control block / source region / output contract); **capability gate at create**: a template requiring an undeclared op ⇒ 400 with the clean error (honest, pre-run).
- `GET /api/v1/templates` (per-provider `availableFor` + reason + param schemas); create payload accepts `template` + `templateVersion` (default = active; `null` = baseline behavior, `promptVersion` "v1"/"custom" semantics unchanged for non-template jobs).
- LLM metadata enrichment (best-effort via existing `internal-llm.ts`, one zod-validated call per job, `enrichment: null` + `metadata_enrichment_skipped` event on failure — **never fails a job**).
- UI: upload fields for the new kinds + template picker.

**Out of scope:** T3/T4 worker ops (P4-5); MCP exposure of templates (P4-6 `list_templates`); enrichment quality improvements beyond schema (NOT_TESTED, honest).

**Acceptance (per path):**
- REST: all new intake paths `INTEGRATION_TESTED` (format × limit boundary × safe name matrix); `GET /api/v1/templates` + create-with-template incl. `unknown template` / `version mismatch` / `capability gap` 4xx.
- UI: upload fields + template picker component tests (`CODE-VERIFIED`) + recorded manual-browser evidence (PDF upload, template picker) in the phase report.
- External E2E: new scenarios `pdf`, `video`, `url`, `template-t1`, `template-t2` (mock).
- MCP: n/a.
- Live gate (manual): one PDF + one URL + one T1 run within budget — upgrades those rows to `LIVE-VERIFIED` for the executed paths.
- Test strategy rows: 6, 7; injection fixture ("ignore previous instructions…" source) with no control-field mutation.

**Deliverables:** migration + seed; extraction units; untrusted-content invariant tests + fixture; template renderer tests; multipart route tests; UI component tests; E2E scenarios; live-gate evidence (run ids, digests, no secrets); phase report `docs/reports/NLO_P4_2_*.md`.

**SP estimate: 8** (four new input kinds + migration + renderer + UI; the extraction library choice is the main technical risk).

---

## P4-3 — Account Manager: credential kinds + keepalive + routing + Egress policy

**Goal.** Multi-account, multi-credential, multi-proxy routing per [`NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`](../architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md) and ADR-003/ADR-004.

**Scope (in):**
- 4 credential kinds: `storage_state` (existing) + `cookie_file` (import path with the `.google.com` domain-selection rule) + `master_token` (vault-stored, dedicated-account requirement documented, browser-free mint on demand via upstream mechanism — `EXPERIMENTAL` upstream, `NOT_TESTED` until a live run) + `enterprise_sso` (org SSO login, project-bound — live-verified against a real GCP project **before** claiming `IMPLEMENTED`).
- Migration: `account_credentials` (per [`NLO_GOOGLE_AUTH_SESSION_RESEARCH.md` §4.1](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md)); DB stores refs + metadata only.
- **Scheduled keepalive**: in-process timer, K=240 min (configurable), failure budget 3 → `degraded` → `needs_reauth`, events `account_keepalive_ok|fail|exhausted` → webhook outbox; job admission TTL (10 min) unchanged.
- **Routing policy** (5-step: explicit → affinity → quota → priority → rotation) evaluated at `WAITING_FOR_ACCOUNT`; existing 9-state `AuthSessionState` machine **preserved unchanged**.
- **Per-provider egress policy** wired into `acquire(jobCtx, policy)`; 5-step node selection; per-node concurrency cap; **account↔node affinity** (kill-switch, `NOT_TESTED` — egress-IP drift alerting per the proxy research open question).
- UI: accounts/sessions/proxies views extended (credential kind, status, keepalive state).

**Out of scope:** new transports (P4-7); failover matrix enforcement (P4-4 — this phase provides the *selection* substrate); enterprise live verification (manual gate, may complete `BLOCKED`-honestly).

**Acceptance (per path):**
- REST: credential-kind round-trip per kind `INTEGRATION_TESTED`; session-gate per kind; keepalive tick with injected clock (budget 3 → state transitions + events).
- UI: accounts/sessions views `CODE-VERIFIED` + manual evidence.
- External E2E: session-gate scenarios (expired/valid/rotated) + negative proxy scenarios (`E2E_PROXY`).
- MCP: n/a.
- Live gate: master-token + enterprise runs only if the real preconditions exist (dedicated account / GCP project) — else `BLOCKED` with what is missing.

**Deliverables:** migration; state-machine + routing + keepalive units; gateway policy/selection/cap/affinity tests; C6 egress per adapter; session-gate E2E; phase report `docs/reports/NLO_P4_3_*.md` (state explicitly which credential kinds reached `LIVE-VERIFIED` vs `NOT_TESTED`).

**SP estimate: 8** (stateful timer + 4 kinds + policy engine; two kinds are `BLOCKED`-prone on real preconditions).

---

## P4-4 — Manual Retry (checkpoint) + UNKNOWN_EXTERNAL_STATE + Provider Failover

**Goal.** The recovery product per [`NLO_MANUAL_RETRY_SPEC.md`](../product/NLO_MANUAL_RETRY_SPEC.md) and ADR-007: RETRY FROM LAST SAFE CHECKPOINT, the UNKNOWN_EXTERNAL_STATE poll-first rule, and the per-FailureClass failover matrix. **No new job statuses** — the existing 12-state machine expresses everything.

**Scope (in):**
- `GET /api/v1/jobs/:id/checkpoints` (derived, never stored: per stage `{ stage, externalOperationId?, status, safeForRetryFrom }`).
- `POST /api/v1/jobs/:id/retry`: `mode: from_checkpoint` (default) | `from_start`; optional `accountId`, `nodeId`; `discardExternal: true` to force a fresh start; `from_start` with existing external ids ⇒ `409 E2E_JOB_HAS_EXTERNAL_STATE`. Retry = **new attempt, same job id**; upstream stages trusted as recorded (their external ids are **polled first — adopt, not redo**).
- `POST /api/v1/jobs/:id/recheck` (poll-only alias — the "Re-check now" operator action).
- **UNKNOWN_EXTERNAL_STATE rule**: poll-first decision table (complete→adopt / running→keep polling / not found→resubmit once + `external_id_orphaned` / unverifiable→park `NEEDS_ATTENTION` + `ambiguous`); settle-once via the DB job lock (from P4-1); events `unknown_external_state_entered` / `_resolved_by_poll` / `_resolved_manual` carrying the external id (redacted); `NEEDS_ATTENTION` counted in `/api/health/ready` diagnostics.
- **Failover matrix** per `FailureClass` (8 values): Unavailable ⇒ node/account switch allowed; Operation Failed ⇒ retry same op; Outcome Unknown ⇒ park, never auto-transfer. Mid-job node switch legal only while no external id exists; account switch auto before notebook creation, manual-only after (with re-poll of the old notebook). **Cross-provider auto-failover: deferred to P4-7** (per-provider stage mapping + conformance parity); a job stays bound to its provider.
- Webhook events: `retry_requested`, `retry_adopted_external_result`, `external_id_orphaned`, `unknown_external_state_*`, `failover_node`, `failover_account` (existing HMAC envelope).
- UI: retry button + checkpoint view + NEEDS_ATTENTION state.

**Out of scope:** cross-provider failover (P4-7); MCP `retry_job` tool (P4-6); auto cross-provider manual retry (not offered — a new job on another provider is the honest path).

**Acceptance (per path):**
- REST: all 5 retry semantics `INTEGRATION_TESTED` (incl. `409`, `discardExternal`); `/checkpoints`, `/recheck`.
- UI: retry button + checkpoint view `CODE-VERIFIED` + manual evidence.
- MCP: n/a (tool arrives P4-6, this endpoint is its backing).
- External E2E: scenarios `retry-checkpoint`, `retry-unknown-state`, `failover-node`, `failover-account`, `unknown-external-state` (worker-kill fixture).
- Live gate: operator recheck of a real ambiguous job (on demand; never auto-retried).
- Test strategy: **all of F1–F8 green** (the 8 fault-injection scenarios) + rows 4, 5, 13.

**Deliverables:** retry/checkpoints/recheck API tests (5 semantics, 3 non-goals); F1–F8 scenarios; UNKNOWN_EXTERNAL_STATE parking tests; webhook tests per new event; phase report `docs/reports/NLO_P4_4_*.md` with the failover-matrix evidence table.

**SP estimate: 8** (stateful engine behavior + 3 endpoints + 8 fault scenarios; highest correctness risk in P4 — the poll-first discipline).

---

## P4-5 — Content Engines: T3 Vertical Infographic + T4 Reels/Shorts (worker ops)

**Goal.** Extend the python worker surface with `generate.infographic` (PNG, 9:16 vertical) and `generate.video` (short-form mp4; 4 formats × 8 styles per the pinned upstream library nblpy 0.8.5), deliver the new artifact types, and flip T3/T4 from `unavailable` to `available` **where the provider matrix declares the capability**. Spec rows: [`NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md` §3](../product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md); ADR-002.

**Scope (in):**
- `nbl_worker.py`: new ops for infographic + short-form video generation (upstream library calls — the capability exists upstream, VERIFIED 2026-11-15; the delta is NLO worker ops + protocol + stages, not a new library).
- Worker protocol + engine stages for the two new ops (task-id + poll contract, same as audio); capability matrix declarations (`implemented_tested` after conformance, `unavailable` before — never guessed).
- Artifact delivery: new artifact types (PNG / mp4) through the existing artifact download route (ETag=sha256, size/MIME/hash validation, `source: "provider"`); multi-artifact delivery for a single job.
- Template param surface: zod schema for T3/T4 `params` (styles, aspect ratios, durations) as **data** in `content_templates`.
- Capability gate at create now admits T3/T4 for declaring providers (P4-2's 400 path flips to success).
- UI: artifact views for the new types.

**Out of scope:** new image/video *vendors* (no first-party API exists; external engines arrive via MCP in P4-7); any change to T1/T2.

**Acceptance (per path):**
- REST: T3/T4 job create→poll→artifacts `INTEGRATION_TESTED` (mock); capability matrix shows the new ops at honest levels.
- UI: artifact views `CODE-VERIFIED` + manual evidence.
- MCP: n/a (`get_artifact` surfaces them from P4-6).
- External E2E: scenarios `t3`, `t4` (mock in CI).
- Conformance: **C3 lifecycle green against the new worker ops** (admission gate).
- Live gate (manual, budget): one T3 + one T4 run — `LIVE-VERIFIED` for the executed path only; artifact sha256 recorded.

**Deliverables:** worker ops + protocol; C3 conformance for the new ops; artifact validation tests (new types); E2E `t3`/`t4`; live-gate evidence; phase report `docs/reports/NLO_P4_5_*.md` (state which of T3/T4 reached `LIVE-VERIFIED`).

**SP estimate: 8** (two new worker ops + artifact types + a mandatory live gate; worker-protocol risk).

---

## P4-6 — MCP Server: 9 tools on the existing loopback Fastify

**Goal.** NLO as an MCP **server** (ADR-005): one domain, two front doors — a thin anti-corruption layer over the domain services (not over HTTP routes), Streamable-HTTP `/mcp`, same API-token auth with **per-tool scopes** + `via: "mcp"` audit.

**Scope (in):**
- 9 tools: `create_job`, `get_job`, `list_jobs`, `retry_job` (backed by the P4-4 endpoint), `cancel_job`, `get_artifact`, `list_templates` (**the one genuinely new capability**), `list_providers`, `get_provider_health`.
- Auth: existing API tokens; per-tool scopes (`jobs:read` / `jobs:write` / `providers:read`); token without scope ⇒ 403 with `via: "mcp"` audit record.
- Error envelope: the existing `{ error: { code, message } }` with the 13 `E2E_*` contract codes preserved across MCP.
- **Long operations return a job id, not a promise** (`create_job → { job, status }`; agents poll or subscribe to webhooks — the push channel agents actually use).
- Untrusted-content rule applies to tool *inputs* (descriptions state it); **no secrets in schemas or results** (health snapshots redacted; unit-tested).
- `get_artifact` body-vs-URL decision (default: direct body with `mediaType`, config-capped sizes — the open P4-6 decision, recorded in the report).
- MCP client test harness in CI: one integration scenario per tool + **parity assertion vs the equivalent REST call**; `nlo-e2e --mcp` mode mirroring REST scenarios.

**Out of scope:** stdio *server* mode (Streamable-HTTP only — deliberate, per ADR-005 alternatives); resources/prompts (deferred); server→client notifications (deferred, polling+webhooks are the contract).

**Acceptance (per path — the four-path gate):**
- MCP: all 9 tools `INTEGRATION_TESTED` (harness) + scope 403s + envelope mapping.
- **Reference scenario path-equivalence** (the canonical acceptance flow, [`NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` §4](../testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md)): "T1 podcast from a PDF, recovered from a mid-generation crash" executed on all four paths (UI clicks / raw REST / MCP tools / `nlo-e2e`) — job records **identical in stages, events, artifacts, webhook payloads** (modulo `via:` metadata).
- Live gate: one live run on an MCP path (or E2E path) — upgrades *that path only* to `LIVE-VERIFIED`.
- Test strategy row 11 in full.

**Deliverables:** MCP server + harness; per-tool scenarios; parity report (the path-equivalence evidence); schema secret-scan unit; `get_artifact` decision recorded; phase report `docs/reports/NLO_P4_6_*.md`.

**SP estimate: 8** (9 tools are mostly wrappers, but the parity gate + harness + auth scopes are the real work).

---

## P4-7 — MCP Client + New Transports: external providers, Android gRPC, Enterprise host

**Goal.** NLO as an MCP **client** (ADR-006): external MCP servers admitted as `mcp_client` provider registry entries — plus the two remaining NotebookLM transports (Android gRPC, Enterprise host) as thin adapters, each **live-verified before enablement**.

**Scope (in):**
- **External-MCP client adapter**: `ContentProvider` mapping via a **static mapping file** (versioned data: `serverVersionRange`, tool→operation map); capability honesty by mapping, not faith — C1–C7 gate **before admission** (C7 = live spot-check); `WorkerSupervisor` lifecycle for stdio children (start/stop/crash-respawn, no orphans); `envSecretRefs` resolved from the vault (never in logs, never in process args); egress policy honored by the child; `resultProvenance: "real"` only if verified, else `"unknown"`.
- **stdio child env isolation spec** (which env the supervisor passes: PATH + vault-injected secrets only) — the open P4-7 question, decided and tested here.
- **Android-gRPC transport adapter** (nblpy backend, bearer + master token — cookie-free at request time; `EXPERIMENTAL` upstream, dedicated account required) — declared `experimental` in the matrix until a live run.
- **Enterprise-host adapter** (`notebook.cloud.google.com`, project-qualified) — live-verified against a real GCP project before claiming `IMPLEMENTED`.
- **Cross-provider auto-failover** becomes expressible here (per-provider stage mapping + conformance parity) — *proposed* in this phase's report; enabling it is a P4-8+ decision, not assumed.

**Out of scope:** adopting specific third-party image/video MCP servers (each is a per-server mapping file + conformance pass, repeatable *after* this phase ships the adapter); MCP server→client push (not consumed in P4 — polling only).

**Acceptance (per path):**
- REST: providers route reflects admitted `mcp_client` + new transports at honest levels; C1–C6 green for each admitted provider (CI).
- External E2E: conformance-driven scenarios via the registry for at least one fake external MCP server fixture (admission proof without a live dependency).
- Live gate: **C7 live spot-check before each real provider/transport is admitted** (budget: 1 per key operation); Android + Enterprise each need their live run to leave `NOT_TESTED`/`EXPERIMENTAL`.
- UI: provider view shows the new entries.
- Test strategy row 12 in full.

**Deliverables:** mapping-file linter + fixture; stdio lifecycle tests; `envSecretRefs` tests (vault hit, no log leak); Android/Enterprise adapters + conformance; C7 evidence bundle; phase report `docs/reports/NLO_P4_7_*.md` (state per transport/provider: admitted / `EXPERIMENTAL` / `BLOCKED` with what is missing).

**SP estimate: 13** (a new provider *kind* + two upstream-`EXPERIMENTAL` transports + 3 live gates; the broadest integration surface in P4).

---

## P4-8 — Hardening: full four-path matrix, parity report, standards audit, live-gate evidence bundle

**Goal.** The phase that makes P4 *claimable*: re-run everything, record evidence, close the loop on honest status for every P4 capability. No new features (bug-fixes to reach green only).

**Scope (in):**
- **Full four-path matrix re-run** (every row, every path that consumes it) → the final state of [`NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` §3](../testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md), filled with achieved levels + evidence per cell.
- **Four-path parity report** (reference scenario path-equivalence re-confirmed).
- **Fault-injection suite re-run** (F1–F10).
- **Recorded performance observations** (queue depth, p95 latency under N parallel mock jobs) — observations, **no SLA, no scores** (test strategy §5).
- **Standards audit** with per-item evidence: secrets (CI scan gate, no `.env`/tokens/UUIDs in git), egress (fail-closed, SSRF, loopback default), files (whitelist, safe names, `0700`/`0600`), untrusted content (invariant tests), MCP (no secrets in schemas/results). A summary ratio may be derived *only* by counting evidenced items.
- **Live-gate evidence bundle**: run ids, account ids (no secrets), proxy node ids, artifact digests — recorded for the P4 live runs (P4-2/4/5/6/7 gates).
- Docs: runbook extensions (`docs/operations/`), README/CHANGELOG final P4 sections, OpenAPI updated if any contract changed.
- Open-questions register closed or explicitly deferred (each doc's open questions reviewed; deferred ones carry a phase pointer).

**Acceptance:**
- Matrix: every claimed P4 row at its target level on all consuming paths, with evidence; every non-achieved row honestly `BLOCKED`/`NOT TESTED`/`NOT IMPLEMENTED` with the missing precondition named.
- Full regression suite + build green; pre-commit checklist (AGENTS.md §10) green.
- Final P4 report: `docs/reports/NLO_P4_FINAL.md`.

**Deliverables:** filled matrix; parity report; fault-injection report; performance observations; standards-audit checklist; live evidence bundle; final report.

**SP estimate: 13** (no new code, maximum evidence work; the phase that converts "implemented" into "verified").

---

## Sequencing & dependency summary

```
P4-1 (registry, gateway, lock, C-suite, scan)
 └─> P4-2 (intake, templates)        ─┐
      └─> P4-3 (accounts, egress)     ├─ (P4-2 ∥ P4-3 may overlap; P4-3 consumes the P4-1 gateway)
           └─> P4-4 (retry, failover)─┘ (consumes P4-1 lock; P4-3 routing)
                └─> P4-5 (T3/T4 worker ops)   (consumes P4-2 templates)
                     └─> P4-6 (MCP server)     (wraps P4-4 retry, P4-2 templates)
                          └─> P4-7 (MCP client + new transports)  (consumes registry + conformance)
                               └─> P4-8 (hardening, evidence)
```

**Total planning estimate: 72 SP** (8+8+8+8+8+8+13+13) — a multi-month program at one workstream at a time; phases 2/3 may be parallelized if owned by two developers. Each phase is independently shippable (git-based deploy, previous-good rollback) and independently revertible without touching earlier phases' data.

**What P4 deliberately does NOT claim (carried from the research):** no official Google API exists (all transports ride undocumented internals); no ecosystem project has proxy support (NLO's egress story is its differentiator, preserved); microservices are *not* on the P4 path (ADR-001); browser is used for login/enterprise flows only, never at request time (except where a transport's upstream requires it, stated per adapter).
