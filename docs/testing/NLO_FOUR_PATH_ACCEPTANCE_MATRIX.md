# NLO-P4 Four-Path Acceptance Matrix

Mission: **NLO-P4-0** · The acceptance contract for **every** P4 capability across all four consumer paths: **Human UI** (`apps/web`), **REST API** (`/api/v1`), **MCP server** (`/mcp`), **External E2E agent** (`nlo-e2e` runner + `e2e-live.ts`).
Extends the P1 baseline [`ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md) (which established the four paths and the label discipline) to the P4 surface.
Status labels as defined in [`NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md).

---

## 1. Label discipline (inherited, non-negotiable)

- **PASS** — executed in this phase, evidence recorded (test name / command / run id).
- **CODE-VERIFIED** — the code + contract exist and unit/integration tests pass; not executed against a live provider.
- **INTEGRATION-VERIFIED** — exercised end-to-end in-process (mock provider) through the real API/queue/worker path.
- **LIVE-VERIFIED** — executed against real NotebookLM (manual gate only, never CI; real Google account + working proxy; costs money).
- **BLOCKED** — environment/precondition missing (state what is missing).
- **NOT TESTED** — exists but not yet executed.
- **NOT IMPLEMENTED** — capability absent; reported, never faked.

**Rule (AGENTS.md §5): a mock result is never reported as live.** Every row below names its _level of verification achieved_; P4 rows start at the baseline level and are filled in per phase (P4-1…P4-8).

---

## 2. The four paths (definitions)

| Path                   | What it exercises                                                      | Auth                              | Tooling                                            |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------- |
| **Human UI**           | `apps/web` against a running NLO (ports 4870/4871 dev)                 | session + token                   | browser; vitest for components only                |
| **REST API**           | `/api/v1/*` direct                                                     | `Authorization: Bearer nlo_...`   | integration tests (in-process Fastify) + `nlo-e2e` |
| **MCP server**         | `/mcp` Streamable-HTTP, 9 tools (P4-6)                                 | same API tokens (per-tool scopes) | MCP client test harness + `nlo-e2e` MCP mode       |
| **External E2E agent** | `apps/server/scripts/nlo-e2e.ts` scenarios + `e2e-live.ts` (live gate) | token                             | scenario runner with the 13 `E2E_*` contract codes |

**One domain, four doors:** all four paths must be accepted against the _same_ underlying capability. A capability accepted on REST but broken on MCP is a P4 regression — the matrix is how that is caught.

---

## 3. P4 capability matrix (all four paths)

Rows are P4 capabilities; columns are paths. _Baseline_ = status at `76cd5f03`. _P4 target_ = status the phase must achieve before it is "done" (per its acceptance gate in the roadmap).

| Capability (P4 phase)                                                | Baseline (all paths)                                                                         | UI                                | REST                                              | MCP                                             | External E2E                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Provider Registry + capability matrix `GET /api/capabilities` (P4-1) | matrix exists per-provider for input formats (`/api/providers`-class); no registry API       | `NOT IMPLEMENTED` (view)          | `CODE-VERIFIED` (target: INTEGRATION-VERIFIED)    | `NOT IMPLEMENTED` → `list_providers` (P4-6)     | contract check vs OpenAPI                                                  |
| Conformance suite C1–C6 (P4-1)                                       | n/a                                                                                          | n/a                               | n/a (dev gate)                                    | n/a                                             | n/a — **not a consumer path; it is a provider admission gate** (run in CI) |
| Universal intake: PDF/MD/video/URL (P4-2)                            | `NOT IMPLEMENTED` (text/txt/docx/srt/audio are INTEGRATION-VERIFIED, audio LIVE-VERIFIED P0) | `NOT IMPLEMENTED` (upload fields) | `PROPOSED` (multipart + `from-text` url)          | `create_job` source ref (P4-6)                  | new scenarios `pdf`, `video`, `url`                                        |
| `GET /api/v1/templates` + create with `template` (P4-2)              | `NOT IMPLEMENTED` (in-code `promptVersion v1/custom` only)                                   | `NOT IMPLEMENTED` (picker)        | `PROPOSED`                                        | `list_templates` (P4-6)                         | scenario `template-t1`, `template-t2`                                      |
| T3/T4 worker ops (infographic, video) (P4-5)                         | `NOT IMPLEMENTED`                                                                            | artifact views                    | artifacts endpoint (exists)                       | `get_artifact` (P4-6)                           | scenarios `t3`, `t4` (mock in CI, **live in manual gate**)                 |
| Account credential kinds + keepalive (P4-3)                          | storage-state `IMPLEMENTED`+`INTEGRATION_TESTED`; live-verified                              | accounts/session views exist      | accounts/sessions routes `INTEGRATION_TESTED`     | n/a (no MCP surface for sessions in P4-6 scope) | session-gate scenarios                                                     |
| Egress Gateway acquire/release + per-provider policy (P4-3/4)        | fail-closed proxy `IMPLEMENTED`+`INTEGRATION_TESTED` (`fail-closed.test.ts`), LIVE-VERIFIED  | proxies view exists               | proxies/health routes `INTEGRATION_TESTED`        | `get_provider_health` (P4-6)                    | proxy-failure negative scenarios                                           |
| Manual retry + checkpoints + recheck (P4-4)                          | `NOT IMPLEMENTED` (requeue exists: `POST /jobs/:id/requeue` — baseline P1 matrix)            | retry button + checkpoint view    | `PROPOSED` (`/retry`, `/checkpoints`, `/recheck`) | `retry_job` (P4-6)                              | scenarios `retry-checkpoint`, `retry-unknown-state`                        |
| UNKNOWN_EXTERNAL_STATE parking + events (P4-4)                       | partial (podcast resume-never-resubmit `INTEGRATION_TESTED`)                                 | NEEDS_ATTENTION view              | `PROPOSED` (events + status)                      | `get_job` shows mode (P4-6)                     | scenario `unknown-external-state` (worker kill fixture)                    |
| Provider failover matrix (P4-4)                                      | `NOT IMPLEMENTED` (parking only)                                                             | —                                 | `PROPOSED` (events `failover_*`)                  | —                                               | scenarios `failover-node`, `failover-account`                              |
| MCP server: 9 tools (P4-6)                                           | `NOT IMPLEMENTED`                                                                            | n/a                               | n/a (MCP is the 3rd door)                         | `PROPOSED` → INTEGRATION-VERIFIED (harness)     | MCP-mode scenarios mirroring REST scenarios                                |
| MCP client adapter (external MCP provider) (P4-7)                    | `NOT IMPLEMENTED`                                                                            | provider view                     | providers route (registry)                        | n/a                                             | conformance C-suite incl. C7 live spot-check                               |
| Webhook events for new flows (P4-4/5/6)                              | webhooks `INTEGRATION_TESTED` (exactly-once, HMAC)                                           | —                                 | webhooks routes                                   | agents subscribe (primary MCP push channel)     | webhook delivery scenarios                                                 |

**Reading the matrix:** a P4 phase is _done_ only when every row it claims reaches its target level on **all four paths that consume it** (a phase that adds only a REST capability still needs the External E2E contract check; MCP rows are consumed from P4-6 onward).

---

## 4. Reference scenario (the canonical P4 acceptance flow)

**Scenario: "T1 podcast from a PDF, recovered from a mid-generation crash" — executed on all four paths, mock provider in CI, one live run in the manual gate.**

Steps and the _required observed outcome_ at each (the acceptance criteria a P4-5 acceptance run must show):

| #   | Step (every path performs the equivalent)                                                   | Required observed outcome                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create job: `template=t1_deep_dive@1`, source = `sample.pdf` (≤ limit), language `fa`       | `202 { job: j_… }`; job `QUEUED`; **no** `E2E_PROVIDER` (provider matrix declares `generate.audio`)                                                                                                                     |
| 2   | Poll until notebook + source stages complete                                                | stages `create_notebook`/`add_source` `COMPLETED` with `externalOperationId` recorded (visible in `/events`)                                                                                                            |
| 3   | **Crash injection** (fixture): kill the worker after audio-op submit, before result persist | job leaves `RUNNING`; no status corruption (state machine invariant holds — no illegal transition)                                                                                                                      |
| 4   | Restart the app (or in CI: supervisor respawns the fixture worker)                          | boot recovery: job → `QUEUED` with `restart_recover` event; **first engine action is a poll of the external audio op** (evidence: `poll_external_op` event _before_ any submit event)                                   |
| 5   | Mock external op reports "complete"                                                         | engine **adopts**: artifact fetched + validated (size/MIME/hash per `artifact-validate`), stage `generate_audio` `COMPLETED`, job `SUCCEEDED`, `resultProvenance: "real"` (mock: `"mock"`)                              |
| 6   | Download artifact (audio + SRT transcript) on all 4 paths                                   | identical bytes, same `sha256`, `source: "provider"`; UI link, REST route, MCP `get_artifact`, E2E digest check all match                                                                                               |
| 7   | Webhook verification                                                                        | `job.succeeded` delivered exactly-once, HMAC `t=<unix>,v1=hex(hmac(secret, t+"."+rawBody))` valid                                                                                                                       |
| 8   | **Negative variant** (same scenario, step 5' = poll returns "unverifiable")                 | job → `NEEDS_ATTENTION`, `errorClass: "ambiguous"`, event `unknown_external_state_entered` with op id; **no second submit** (settle-once); manual `POST /retry` (mode `from_checkpoint`) re-polls and adopts on success |

**Path-equivalence check (the actual four-path gate):** steps 1–8 are run as (a) UI clicks through the web app, (b) raw REST calls, (c) MCP tool calls (`create_job`→`get_job`→`get_artifact`→`retry_job`), (d) `nlo-e2e --scenario p4-reference` (mock) — and the job records produced by (a)–(d) are **identical in stages, events, artifacts, and webhook payloads** (modulo `via:`/path metadata). One live run (c or d) in the manual gate upgrades the verdict to LIVE-VERIFIED _for that path only_ — the report must say so.

---

## 5. Per-phase acceptance gates (summary — detail in the roadmap)

| Phase | Matrix rows that must reach target level                                                      |
| ----- | --------------------------------------------------------------------------------------------- |
| P4-1  | registry + capabilities (REST, E2E contract); conformance suite green in CI                   |
| P4-2  | intake formats + templates (UI, REST, E2E); `list_templates` REST parity                      |
| P4-3  | credential kinds + keepalive (UI, REST, E2E session-gate); egress policy (REST, E2E negative) |
| P4-4  | retry/checkpoints/recheck + UNKNOWN_EXTERNAL_STATE + failover (all four where applicable)     |
| P4-5  | T3/T4 ops (UI artifact views, REST, E2E mock; **live in manual gate**)                        |
| P4-6  | all 9 MCP tools INTEGRATION-VERIFIED + reference scenario path-equivalence                    |
| P4-7  | external-MCP provider admitted via C-suite (E2E + C7 live spot-check)                         |
| P4-8  | hardening: full matrix re-run, four-path parity report, live-gate evidence recorded           |

## 6. What this matrix deliberately does NOT claim

- UI acceptance is the _hardest_ to automate (no running instance in CI); UI rows are `CODE-VERIFIED` (component tests) + manual-browser evidence in the phase report — never silently `PASS` without a recorded manual run.
- "External E2E" ≠ "live": the `nlo-e2e` agent in CI runs against the **mock** provider; the live gate (`e2e-live.ts`) is manual, cost-bearing, and reported separately as `LIVE-VERIFIED`.
