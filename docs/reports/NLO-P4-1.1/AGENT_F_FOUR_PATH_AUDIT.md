# Agent F — Four-Path Acceptance Audit (NLO-P4-1.1)

- **Agent role:** Four-Path Acceptance (DeepSeek)
- **Mode:** independent audit (code reads + contract checks); executed sequentially in a separate
  context (no true subagents — see CONSOLIDATED §parallelism). No live job was executed from any path
  in this audit (mock-level integration tests were re-run green by Agent D; live gates are manual).
- **Executed:** 2026-11-17 ~16:25–16:40 UTC, repo HEAD `b833d89`.

The four paths (per `docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` §2):

| Path                   | Implementation                                                                    | Auth                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Human UI**           | `apps/web` (React + react-router)                                                 | none (loopback single-user); talks to the legacy `/api` surface                  |
| **REST API**           | `/api/v1` (token-auth) + legacy `/api`                                            | `Authorization: Bearer nlo_…` (optional by default, `NLO_API_AUTH=1` to enforce) |
| **MCP server**         | —                                                                                 | same API tokens (per-tool scopes, planned)                                       |
| **External E2E agent** | `apps/server/scripts/nlo-e2e.ts` (+ `e2e-live.ts`, `verify-live.ts` manual gates) | token                                                                            |

---

## 1. Is the MCP server really implemented? — **NOT-IMPLEMENTED (in code)**

Verified across the whole tree at HEAD:

- **No MCP route exists**: no `/mcp` handler in `apps/server/src/api/*`; `server.ts` registers cors,
  rate-limit, multipart, error handler and the route modules — none serves MCP (Streamable-HTTP or
  otherwise). **CODE-VERIFIED.**
- **Only design-level artifacts exist**:
  - OpenAPI `kind` enum `["native","mcp_client"]` (`api/openapi/spec.ts:1188`) — a _descriptor field_
    for external MCP providers, not a server.
  - Registry comment "MCP client under evaluation" (`providers/registry.ts`).
  - ADR-005 (MCP server), ADR-006 (external MCP client), `NLO_MCP_INTEGRATION_ARCHITECTURE.md`,
    `NLO_NOTEBOOKLM_MCP_COMPARISON.md` — design docs only.
- **Are the MCP tools real?** No — the 9 planned tools (`list_providers`, `create_job`, `get_job`,
  `get_artifact`, `retry_job`, `list_templates`, `get_provider_health`, …) exist only as a design
  table in the four-path matrix doc; there is no tool registry, no JSON-RPC handler, no MCP client
  harness in the test suite.
- **Auth for MCP** would reuse API tokens with per-tool scopes — designed (ADR-005), not built.

**Status: NOT-IMPLEMENTED** (honest label per the matrix's own discipline; planned as an owner-stated
P4 phase — numbering note in §5).

## 2. Per-capability matrix (what each path can do at HEAD)

Legend: test type — **U** unit, **I** in-process integration (mock provider), **C** component test
(web), **M** manual/live gate (NOT re-run in this audit), **n/a** not applicable.

| Capability                          | Human UI                                                                       | REST `/api/v1`                                                                                                                                          | MCP                                                 | External E2E (`nlo-e2e`)                                             |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **Job create** (text/audio/podcast) | ✅ CreateJob page → `POST /api/jobs` / `/api/notebooks/from-text` — C + manual | ✅ `POST /jobs`, `POST /notebooks/from-text` — I (`api.test.ts`, `from-text.test.ts`, `provider-audio.test.ts`)                                         | ⬜ NOT-IMPLEMENTED                                  | ✅ scenarios `text`/`audio`/`podcast` — I-level (mock); live: M only |
| **Job status**                      | ✅ JobDetails/JobHistory → `GET /api/jobs/:id`, `/events`, `/attempts` — C     | ✅ `GET /jobs/:id`, `/events`, `/attempts` — I                                                                                                          | ⬜ `get_job` designed                               | ✅ `--scenario monitor --job-id j_…` (polls status/events)           |
| **Artifacts list + download**       | ✅ `GET /api/jobs/:id/artifacts[/id]`, audio download — C                      | ✅ `GET /jobs/:id/artifacts[/:artId]` — I (`artifact-download.test.ts`, `artifact-storage.test.ts`)                                                     | ⬜ `get_artifact` designed                          | ✅ downloads artifact, verifies digest (script L1–22 contract)       |
| **Cancel**                          | ✅ `POST /api/jobs/:id/cancel` — C                                             | ✅ `POST /jobs/:id/cancel` — I (`job-lifecycle.test.ts`)                                                                                                | ⬜ designed                                         | ⬜ (monitor scenario is observe-only)                                |
| **Requeue / retry**                 | ✅ `POST /api/jobs/:id/requeue` — C                                            | ✅ `POST /jobs/:id/requeue` — I                                                                                                                         | ⬜ `retry_job` designed                             | ⬜ (requeue exists in API; scenario coverage = manual)               |
| **Accounts / sessions**             | ✅ Accounts page (login, verify, import, cookie-import, logout) — C            | ✅ `/api/v1`? no — accounts live on legacy `/api` (by design, documented) — I (`session-gate.test.ts`, `sessions-404.test.ts`, `accounts.repo.test.ts`) | n/a (no MCP surface in design)                      | session-gate scenarios (I)                                           |
| **Proxies / egress**                | ✅ Proxies page (add/validate/health/ping/runtime) — C                         | ✅ legacy `/api/proxies*` (by design) — I                                                                                                               | ⬜ `get_provider_health` designed                   | proxy-failure negative scenarios (I)                                 |
| **Capabilities / providers**        | provider info view (`/api/provider`) — C                                       | ✅ **P4-1A** `GET /api/capabilities` (registry matrix `{version, providers, activeId}`) — I (`api.test.ts`)                                             | ⬜ `list_providers` designed                        | contract check vs OpenAPI (I: `openapi-v1.test.ts`)                  |
| **Webhooks**                        | ⬜ no UI surface (by design — outbox is API/ops-side)                          | ✅ endpoints CRUD + deliveries + dead-letter — I (`webhooks.test.ts`)                                                                                   | agents subscribe (design: primary MCP push channel) | webhook delivery scenarios (I)                                       |
| **Tokens / auth**                   | ⬜ (UI is token-less by design)                                                | ✅ create/disable/revoke/audit — I                                                                                                                      | per-tool scopes (design)                            | token passed via env, never printed (script L21)                     |
| **Health / readiness**              | settings/dashboard poll `/api/health/ready` — C                                | ✅ open (health/openapi/docs exempt from auth) — I                                                                                                      | n/a                                                 | n/a                                                                  |
| **Orchestrator (radio RAG)**        | ⬜ no UI                                                                       | ✅ `POST /api/v1/orchestrator/ask` — I (`orchestrator.test.ts`)                                                                                         | n/a                                                 | n/a                                                                  |

**Matrix honest limits** (from the matrix doc §6, re-confirmed here): UI rows are CODE-VERIFIED via
component tests + manual browser runs — never silently `PASS` without a recorded manual run;
"External E2E" in CI is mock-level, never live.

## 3. UI surface inventory (what the "real visible UI deliverable" contains today)

[`apps/web/src/app/app.tsx`](apps/web/src/app/app.tsx) — pages: **Dashboard** (`/`), **Create job**
(`/new`), **Job history** (`/jobs`), **Job details** (`/jobs/:id`), **Accounts** (`/accounts`),
**Proxies** (`/proxies`), **Settings** (`/settings`). RTL shell, toast system, no login screen
(loopback-only single-user model — documented in-file).

API client [`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts) (688+ lines) covers: jobs
(list/get/create/from-text/events/attempts/artifacts/audio/cancel/requeue), accounts (CRUD + health +
default), proxies (CRUD + manual + validate + health + ping-all + runtime + connectivity), sessions
(login/browser-import/verify/refresh/import/logout), settings, secrets list, provider info,
health/ready.

**Finding F-1 (P2, documentation/consistency):** the UI talks **exclusively to the legacy `/api`
surface** — none of its calls hit `/api/v1`. That is the documented default-mode design (legacy surface
never token-gated; single-user loopback), and it works — but the four-path matrix doc §2 describes UI
auth as "session + token", which overstates: the UI sends no token today. Minor doc drift; the
capability itself is correct. Also: P4-1A's new `GET /api/capabilities` has **no UI view** (matrix row
says `NOT IMPLEMENTED (view)` — confirmed: no capabilities call in `api.ts`).

**Finding F-2 (INFO):** web test suite = 4 files / 30 tests (`lib/api.test.ts`, `jalali.test.ts`,
`utils.test.ts`, setup) — component-level only, consistent with the matrix's "UI acceptance is the
hardest to automate" note. The running local instance (port 4871, mock provider) is a manually-driven
acceptance surface; its `/api/health` returned 200 during this audit (live probe, no job created).

## 4. Error understandability (per mission question)

- **Consistent envelope** on both surfaces: `{ "error": { "code", "message" } }` via `ApiCodes`
  (`@nlo/shared/api-error.ts`); Fastify error handler maps zod → 400, ApiError → its status, 429 →
  `rate_limited` with `retryAfterSeconds` (Agent C §7–8). **CODE-VERIFIED** + I (`api.test.ts`
  exercises 404/400/429/409 classes).
- **Machine-readable failure classes** on jobs: `errorClass`/`errorClass` values (`auth`,
  `rate_limit`, `timeout`, `connectivity`, `ambiguous`, `proxy`, …) with `ambiguous` + `needsReauth`
  flags — an external agent can classify without parsing messages. **CODE-VERIFIED** (`providers/types.ts`).
- **E2E contract codes**: `nlo-e2e` uses the shared `E2E_*` contract codes (`@nlo/shared/e2e-contract.ts`),
  exit codes 0/1/2/3 with distinct meanings (PASS vs MOCK-verified vs FAIL vs BLOCKED vs usage), and
  emits a machine-readable report; the token is never printed. **CODE-VERIFIED** (script read).
- **Limitations:** the legacy `/api` surface's error shape predates the envelope standard in places
  (404s on unknown sessions use the same envelope — `sessions-404.test.ts` asserts it); webhook
  dead-letter reasons are machine-readable strings (`ssrf_blocked:<reason>`, `http 404 (client
rejected)`). No user-facing i18l error catalog — messages are English technical strings.

## 5. Phase-numbering discrepancy (flagged for the consolidated report)

The owner's mission statement (P4-2…P4-8) and the in-repo roadmap doc disagree on phase numbers:

| Capability                          | Owner's numbering (mission) | In-repo docs (`NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` §3/§5, `NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`)  |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Content intake + prompt templates   | **P4-2**                    | P4-2 ✅ (matches)                                                                                     |
| Multi-account session mgmt          | **P4-3**                    | P4-3 ✅ (matches)                                                                                     |
| Proxy pool & egress failover        | **P4-4**                    | split: egress policy = P4-3/4; failover matrix = **P4-4** (retry/checkpoints/UNKNOWN state also P4-4) |
| Manual retry & durable recovery UI  | **P4-6**                    | **P4-4** (in-repo)                                                                                    |
| MCP server + external MCP providers | **P4-5**                    | **P4-6** (server) + **P4-7** (external client)                                                        |
| Webhook & artifact delivery         | **P4-7**                    | distributed across P4-4/5/6 rows                                                                      |
| Four-path live acceptance           | **P4-8**                    | P4-8 (hardening/full re-run) ✅ roughly                                                               |

This is a **documentation-alignment issue, not a capability gap** — every capability exists in some
numbered phase in the in-repo docs; the NEXT_PROMPT_PLAN must pick one canonical numbering (the owner's
mission numbering is authoritative for the next prompts) and the in-repo docs must be updated to match.
Backlog item F-BL-02 (P2).

## 6. Findings summary (Agent F)

| #       | Sev           | Finding                                                                                                                                                                                 | Evidence |
| ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-BL-01 | P1 (planning) | **MCP path is NOT-IMPLEMENTED** — the four-path contract has only 3 of 4 doors; P4-5 (owner numbering) must build the server + 9 tools + harness before four-path parity can be claimed | §1       |
| F-BL-02 | P2            | Phase numbering mismatch between owner's mission P4-2…P4-8 and in-repo roadmap/matrix docs                                                                                              | §5       |
| F-BL-03 | P2            | UI uses only the legacy `/api` surface (by design) but the matrix doc says "session + token"; capabilities view for P4-1A's `/api/capabilities` missing in UI                           | §3, F-1  |
| F-BL-04 | INFO          | Error envelope consistent, machine-readable failure classes, honest E2E exit codes — external agents can operate the API without message parsing                                        | §4       |
| F-BL-05 | INFO          | All non-MCP capabilities that exist are reachable from ≥2 paths (UI + REST + E2E) with mock-level integration evidence re-verified green (Agent D)                                      | §2       |

## 7. What this agent did NOT do

- No live job from any path (mock level only; live gates manual and cost-bearing).
- No MCP client harness runs (there is no MCP server to harness — that is the point of F-BL-01).
- No browser-automation run of the UI (component tests + the running 4871 instance's health probe
  only).
