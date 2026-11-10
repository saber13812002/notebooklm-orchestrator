# NLO — Full Project Audit & Session Reference (2026-11-10)

**Purpose:** durable, self-contained reference so that any future agent session has
immediate access to: the entire source-code map, project goals, documentation index,
production environment identification, and the full git connectivity map
(local repo ↔ GitHub ↔ GitLab mirror ↔ production host clone).

**Method:** full read-only inspection of the local working tree at
`c:/Users/s.tabatabaei/Documents/saberprojects/notebooklm-orchestrator`, git
inspection, fresh test-suite run, local health checks, and fresh local SQLite
inventory. All evidence below was re-verified on **2026-11-10** (UTC) unless a
date is explicitly noted. The audit itself made **no code changes**; in the
follow-up the pre-existing uncommitted Phase 3.3 change was completed (tests +
CHANGELOG), committed, and pushed (see §3.1).

**Verification level:** Local code + local dev server (4871) verified fresh.
Production (172.30.0.133) facts are carried from read-only audits dated
2026-11-04…2026-11-06 (see §11) — NOT re-verified live in this session.

---

## 1. What NLO is (mission & goals)

**NotebookLM Orchestrator (NLO)** is an operational, single-user, loopback-only
service (systemd service name `nlo`, port **4870** in production, **4871** in
local dev) that orchestrates real NotebookLM jobs:

> audio/text + prompt → real NotebookLM (via Google accounts + VLESS proxy
> tunnel) → answer/artifacts

Key goals (from `docs/ROADMAP_MASTER.md` and `AGENTS.md`):

1. **API-first product:** the REST API (`/api` legacy + `/api/v1` token-auth) is
   the primary contract; the frontend is just one consumer. Long operations are
   async jobs with trackable IDs (`j_<hex32>`), events, attempts, artifacts.
2. **Operational integrity:** verified real NotebookLM connectivity and
   real audio→text processing exist. Never rewrite working operational
   capability without a test and a stated technical reason.
3. **Honest status labels everywhere:** `Implemented + Unit Tested`,
   `Live Verified`, `Blocked`, `Not tested`. Never describe planned
   capability as ready.
4. **Security invariants:** no secrets in git/logs; loopback-only bind;
   fail-closed egress (no verified proxy tunnel → no live traffic);
   AES-256-GCM vault; zod validation on all routes.
5. **Dual-repository policy:** GitHub = public source of truth; GitLab
   (`git.ai.ismc.ir`) = one-way internal mirror (currently **inactive**).
6. **Phase discipline:** work proceeds in phases (A→G) with per-phase reports
   and user approval gates. No unapproved destructive or externally visible
   action.

Standing rules for every change are in `AGENTS.md` (root): inspect-before-touch,
dual-repo policy, API-first, mandatory proportional testing, documentation
rules, security invariants, deployment rules (git-based via
`deploy/deploy.sh` only), phase discipline, pre-commit checklist
(typecheck + lint + format:check + test + build + docs + CHANGELOG).

---

## 2. Monorepo layout (npm workspaces)

`package.json` (root) — workspaces: `packages/*`, `apps/*`.
Node >= 22.5.0 (local runtime: Node v24.14.0; prod: v22.23.4).

| Workspace         | Package       | Stack                                                                  | Role                                                                                                             |
| ----------------- | ------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/server`     | `@nlo/server` | Node + Fastify 5 + TypeScript, `tsx` runtime, `node:sqlite` (built-in) | The service: REST API, queue, providers, proxy manager, web static serving                                       |
| `apps/web`        | `@nlo/web`    | React 19 + Vite + Tailwind v4                                          | Persian-RTL single-page frontend (built to `apps/web/dist`, served by server)                                    |
| `packages/shared` | `@nlo/shared` | TypeScript                                                             | zod schemas, job state machine, error codes, SRT/title/input-capability/retry/redaction/SSRF/safe-name utilities |

Root scripts: `dev`, `build`, `test`, `typecheck`, `lint`, `format:check`
(forwarded to workspaces). CI: `.github/workflows/ci.yml` (lint → typecheck →
test → build). `.gitlab-ci.yml` mirrors the same checks (no runner configured —
mirror inactive).

Deployment artifacts: `Dockerfile` + `docker-compose.yml` (local single-user
Docker only), `deploy/deploy.sh` (production git-based deploy),
`deploy/systemd/nlo.service`, `deploy/nginx/*` (staged HTTPS templates).

---

## 3. Git connectivity map (what connects to what)

### 3.1 Local repository (this machine)

Verified fresh 2026-11-10:

- **Branch:** `main`
- **HEAD:** `e973451` — "phase 3.1: unified input capability matrix +
  DOCX/SRT/TXT document sources" (23 files, +1547/−79; adds
  `packages/shared/src/input-capabilities.ts`, `srt.ts`, `title.ts`,
  `apps/server/src/domain/docx.ts`, `apps/server/test/document-sources.test.ts`)
- **Upstream:** `origin/main` = `b56ec9b` ("docs(phase2-closeout): … VERIFIED-COMPLETED")
  → local was **1 commit ahead** (Phase 3.1, committed, not yet pushed at audit time).
- **Working tree (at audit time):** one modified file, uncommitted (Phase 3.3
  WIP), since completed and committed:
  `apps/server/src/api/job-create.ts` — audio-job title now falls back to the
  cleaned filename when no user title is given
  (`title = userOverride || cleanFilename(audio.filename)`); prompt-only jobs
  keep null title; 3 new tests + CHANGELOG entry added in the follow-up. The
  working tree is now clean (no uncommitted/untracked files of consequence).
- **Remote:** `origin` →
  `https://github.com/saber13812002/notebooklm-orchestrator.git`
  (fetch + push). No other remotes configured locally.

### 3.2 GitHub (public source of truth)

- `saber13812002/notebooklm-orchestrator`
- `origin/main` = `b56ec9b`. **Does not yet contain** the local `e973451`
  (Phase 3.1) — push pending.
- GitHub Actions CI runs here.
- Published 2026-10/11 per `docs/reports/PHASE_1_GITHUB_PUBLICATION.md`.

### 3.3 GitLab internal mirror (`git.ai.ismc.ir`)

- Policy: **one-way mirror, GitHub → GitLab** (`docs/operations/gitlab-sync.md`).
  Commits are never created first on GitLab; GitLab never pushes back.
- **Status: INACTIVE.** No maintainer PAT provisioned, no NLO project ever
  created, no runner. Setup procedure is fully documented and ready to execute
  once a PAT (api scope) is provided. Nothing on GitLab today.

### 3.4 Production host clone (172.30.0.133)

- Clone at `/home/saber/saberprojects/notebooklm-orchestrator` on the prod host.
- Its `origin` also points to **GitHub** (same repo).
- **Last deployed commit: `d705634`** (deployed 2026-11-04 03:33 UTC via
  `deploy/deploy.sh`).
- The host clone is **behind** `origin/main` (`b56ec9b`), and `origin/main` is
  behind local HEAD (`e973451`). Delta `d705634..4ae25da` was 12 mission
  commits at audit time (P0 audio recovery + H1 text-to-notebook); since then
  2 more docs commits landed on origin.
- Deploy path is strictly git-based: only commits reachable from `origin/main`
  may be deployed (deploy script refuses to run otherwise and refuses a dirty
  tree). Rollback = re-deploy the previous-good commit; DB restore from
  `data/backups/` if ever needed.

### 3.5 Connectivity diagram

```
local worktree (main @ e973451 + Phase-3.3 commit; 2 ahead of b56ec9b)
    │  push (PENDING at audit time — now pushed in the follow-up)
    ▼
GitHub  saber13812002/notebooklm-orchestrator   (origin/main = b56ec9b, source of truth)
    │  one-way mirror (BLOCKED: no PAT / no project / no runner)
    ▼
GitLab  git.ai.ismc.ir                           (INACTIVE — nothing there yet)
    ▲
    │  pull on prod host (origin = GitHub) + deploy/deploy.sh
    │
prod host 172.30.0.133 : /home/saber/saberprojects/notebooklm-orchestrator
    deployed @ d705634 (2026-11-04), systemd service "nlo", loopback 127.0.0.1:4870
```

---

## 4. Complete source-code map

### 4.1 `apps/server/src/` (the service)

Root-level:

| File              | Role                                                                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`         | Entrypoint: `loadDotEnv()` → `loadConfig()` → `createAppContext()` → `buildApp()` → serve web `dist/` (SPA fallback) → listen; graceful shutdown; warns on non-loopback bind                                                                                                                   |
| `config.ts`       | `AppConfig` + `loadConfig()` + `loadDotEnv()` + `dataPaths()`; all env vars documented (§12)                                                                                                                                                                                                   |
| `app-context.ts`  | `createAppContext()`: wires Db, SecretVault, 5 repos, proxy runtime, egress, ProxyManager (fail-closed tunnel fetch), provider selection (**explicit**, no silent fallback), JobRunner (session gate for python-worker), Queue; `recoverInFlight()` resets non-terminal jobs to QUEUED at boot |
| `internal-llm.ts` | Client for the internal LiteLLM proxy (`NLO_INTERNAL_API_BASE_URL`, default `http://172.30.0.133:4000/v1`); OpenAI-compatible, Bearer auth; key **not yet provisioned**                                                                                                                        |

`api/`:

| File                  | Role                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.ts`           | `buildApp()`: CORS loopback-only, global rate limit 300/min, multipart limits (32 fields / 4 files), error envelope `{error:{code,message,details?}}` with secret redaction, SPA not-found fallback, registers all route modules + v1                                                                                                                              |
| `v1.ts`               | `/api/v1` surface: `TokenRateLimiter` (per-token sliding window), bearer-token auth, correlation IDs (`x-correlation-id`), scope mapping per route, `isExempt()` (health/openapi/docs GETs), redacted audit log, re-registers every legacy route module under `/api/v1`, plus `/api/v1/tokens`, `/api/v1/tokens/audit`, `/api/openapi.json`, `/api/docs` (Swagger) |
| `job-create.ts`       | `POST /api/jobs` (audio); Phase 3.3: title = user override \|\| cleaned filename (prompt-only jobs keep null)                                                                                                                                                                                                                                                      |
| `job-create-text.ts`  | `POST /api/jobs/from-text` (H1 text-to-notebook)                                                                                                                                                                                                                                                                                                                   |
| `request-augment.ts`  | Shared request augmentation helpers                                                                                                                                                                                                                                                                                                                                |
| `openapi/spec.ts`     | OpenAPI 3 spec builder (1017 lines; **54 operations** live-verified on 4871)                                                                                                                                                                                                                                                                                       |
| `routes/health.ts`    | `/api/health`, `/api/health/ready`                                                                                                                                                                                                                                                                                                                                 |
| `routes/jobs.ts`      | Job list/get/events/attempts/artifacts/download/cancel/requeue                                                                                                                                                                                                                                                                                                     |
| `routes/accounts.ts`  | Google account CRUD + status/verify                                                                                                                                                                                                                                                                                                                                |
| `routes/proxies.ts`   | Proxy node CRUD + health checks                                                                                                                                                                                                                                                                                                                                    |
| `routes/sessions.ts`  | Auth session verify (python-worker gate)                                                                                                                                                                                                                                                                                                                           |
| `routes/providers.ts` | Provider capabilities/status (capability matrix)                                                                                                                                                                                                                                                                                                                   |
| `routes/settings.ts`  | Settings get/put                                                                                                                                                                                                                                                                                                                                                   |
| `routes/tokens.ts`    | API token management (first-admin bootstrap enforced)                                                                                                                                                                                                                                                                                                              |

`db/`:

| File                                              | Role                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `db.ts`                                           | `node:sqlite` wrapper, migration runner, WAL                                                                                   |
| `migrations/0001_initial.sql`                     | accounts, proxy_nodes, proxy_health(+history), jobs, job_events, job_attempts, artifacts, secrets, settings, schema_migrations |
| `migrations/0002_real_runtime.sql`                | real-runtime columns                                                                                                           |
| `migrations/0003_account_default.sql`             | default account flag                                                                                                           |
| `migrations/0004_session_profile_per_account.sql` | session profile per account                                                                                                    |
| `migrations/0005_api_tokens.sql`                  | api_tokens + audit tables                                                                                                      |

`domain/` (repositories + services): `accounts.repo.ts`, `api-tokens.repo.ts`,
`auth-sessions.repo.ts`, `jobs.repo.ts` (`recoverInFlight()` at line ~300),
`proxies.repo.ts`, `archive.ts` (per-job archive under `data/jobs/<job-id>/`),
`docx.ts` (Phase 3.1 DOCX text extraction), `first-admin.ts` (one-shot offline
bootstrap: `npm run bootstrap:admin --workspace @nlo/server`; no public
token-issuing endpoint).

`providers/`:

| File                                      | Role                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                | `NotebookLMProvider` interface: `capabilities()`, `inputCapabilities()` (Phase 3.1), `validateConfiguration()`, `getAccountStatus()`, `runJob()`, `cancel()`; `ProviderJobRequest` (jobId, accountId, credentialRef, prompt, audioPath, textPath, textTitle, notebookTitle, tunnel, egress, signal, onProgress); `capabilityMatrix()` |
| `mock-provider.ts`                        | Safe default provider (no live traffic)                                                                                                                                                                                                                                                                                               |
| `python-worker/python-worker-provider.ts` | Live provider: supervises `nbl_worker.py`, JSON-line stdin protocol, settle-once contract (Phase 1 fix)                                                                                                                                                                                                                               |
| `python-worker/worker.ts`                 | Worker process supervisor (spawn/restart/health)                                                                                                                                                                                                                                                                                      |
| `python-worker/protocol.ts`               | Typed protocol frames (ASCII-only)                                                                                                                                                                                                                                                                                                    |
| `python-worker/nbl_worker.py`             | 736-line Playwright worker. Ops: `ping`, `validate`, `verify`, `login`, `browser-import`, `job` (audio, line ~403), `job_text` (line ~503, mirrors `job` with `summary.enabled=false`)                                                                                                                                                |

`proxy/`:

| File               | Role                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `egress.ts`        | EgressGuard + `MockProviderEgress` — fail-closed: no verified tunnel ⇒ no live traffic                                  |
| `proxy-manager.ts` | Staged health checks (SSRF → config → runtime → tunnel → real traffic), 10-min TTL, node selection (preferred/priority) |
| `runtime.ts`       | Xray runtime (vendor binary `data/vendor/xray`) or mock                                                                 |
| `connect-proxy.ts` | Tunnel fetch plumbing                                                                                                   |

`queue/`:

| File            | Role                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue.ts`      | Durable SQLite-backed in-process queue                                                                                                       |
| `job-runner.ts` | 640 lines; 12-stage pipeline; session preflight gate at pickup; retries w/ backoff (policy in shared `retry.ts`); attempts + events recorded |

`secrets/vault.ts` — file-based vault, AES-256-GCM, key file `0600` at
`data/vault.key`.

Server scripts (`apps/server/scripts/`): `bootstrap-first-admin.ts`
(first-admin CLI), `e2e-live.ts` + `verify-live.ts` (**manual gate only,
never in CI** — real Google accounts, real egress, cost), plus two legacy
helpers `_add-nodes.py`, `_recheck-nodes.py`.

Server tests (`apps/server/test/`): `api.test.ts`, `accounts.repo.test.ts`,
`config-internal-api.test.ts`, `document-sources.test.ts` (Phase 3.1, 490
lines), `fail-closed.test.ts`, `first-admin.test.ts`, `from-text.test.ts`,
`internal-llm.test.ts`, `job-lifecycle.test.ts`, `openapi-v1.test.ts`,
`session-gate.test.ts`, `sessions-404.test.ts`,
`worker-nonascii-protocol.test.ts`, `worker-queue-recovery.test.ts`,
`worker-supervisor.test.ts`, `helpers.ts`, `fixtures/fake-worker.mjs`.

### 4.2 `apps/web/src/` (frontend)

- `app/app.tsx` — routes: `/` Dashboard, `/new` CreateJob, `/jobs` JobHistory,
  `/jobs/:id` JobDetails, `/accounts`, `/proxies`, `/settings`; wrapped in
  `AppLayout` + `ToastProvider`
- `app/app-layout.tsx` — RTL shell/sidebar
- `features/dashboard/dashboard.tsx` — queue/job stats overview
- `features/jobs/create-job.tsx` — audio or text job creation (Phase 3.1
  unified input capability UI) + `create-job.test.tsx`
- `features/jobs/job-details.tsx` — events/attempts/progress/artifacts
- `features/jobs/job-history.tsx` — paginated job list
- `features/accounts/accounts.tsx` — Google accounts + session verify
- `features/proxies/proxies.tsx` — VLESS nodes + health
- `features/settings/settings.tsx`
- `lib/api.ts` (725 lines) — full typed API client (only talks to `/api/*`)
  - `api.test.ts`; `lib/jalali.ts` (+test) — Jalali calendar dates;
    `lib/utils.ts` (+test)
- `components/ui/` — 16 shadcn-style primitives (button, card, dialog, table,
  toast, tabs, …); `components/shared/` — empty-state, error-banner,
  relative-time, status-badge
- `styles/globals.css` — Tailwind v4, Persian-RTL
- `test/setup.ts` — vitest setup; 4 web test files total (30 tests)

### 4.3 `packages/shared/src/` (shared library)

| File                    | Role                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`              | zod schemas / shared DTO types                                                                                                                                                                       |
| `job-state.ts`          | **The** job state machine: CREATED → VALIDATING → QUEUED → WAITING_FOR_ACCOUNT → WAITING_FOR_PROXY → RUNNING → (RETRY_WAIT) → SUCCEEDED \| FAILED \| NEEDS_ATTENTION \| CANCEL_REQUESTED → CANCELLED |
| `api-error.ts`          | `ApiCodes` — consistent error envelope codes                                                                                                                                                         |
| `input-capabilities.ts` | Phase 3.1 unified input capability matrix                                                                                                                                                            |
| `srt.ts`                | SRT parsing (Phase 3.1 document source)                                                                                                                                                              |
| `title.ts`              | `cleanFilename()` — title derivation (Phase 3.1/3.3)                                                                                                                                                 |
| `text-source.ts`        | text source normalization                                                                                                                                                                            |
| `safe-name.ts`          | server-generated safe names (no user path components)                                                                                                                                                |
| `ssrf.ts`               | SSRF guard for URL-based ops                                                                                                                                                                         |
| `redaction.ts`          | secret redaction for logs/error envelope                                                                                                                                                             |
| `retry.ts`              | retry policy (backoff, attempt caps)                                                                                                                                                                 |
| `vless-uri.ts`          | VLESS URI encode/decode                                                                                                                                                                              |
| `index.ts`              | barrel                                                                                                                                                                                               |

Shared tests: input-capabilities, job-state, redaction, retry, safe-name, srt,
ssrf, text-source, title (85 tests).

---

## 5. Data model (SQLite, `data/nlo.sqlite`)

Migrations 0001–0005 (see §4.1). Tables:

- **accounts** — `id, label (unique), display_email, status
(ACTIVE|DEGRADED|RATE_LIMITED|AUTH_REQUIRED|DISABLED|UNKNOWN), enabled,
auth_secret_ref, last_success_at, last_error, quota_note, created_at, updated_at`
- **proxy_nodes** — `id, name (unique), server, port, uuid_secret_ref,
transport (tcp|ws|grpc), security (none|tls|reality), sni, ws_host, ws_path,
pbk, sid, spx, flow, encryption, alpn, extra_json, enabled, priority,
preferred, created_at, updated_at`
- **proxy_health** (+ `proxy_health_history`) — last check, ok, egress_ip,
  latency_ms, error
- **jobs** — `id (j_<hex32>), status, input_json, account_id, node_id,
attempt, max_attempts (3), progress, progress_note, error_class,
error_message, answer_markdown, result_provider_meta_json,
config_snapshot_json, created_at, updated_at, finished_at`
- **job_events** — append-only timeline per job
- **job_attempts** — per-attempt account/node/outcome/detail
- **artifacts** — `source IN (provider, application)` — native NotebookLM
  outputs kept separate from prompt-generated outputs
- **secrets** — `ref → ciphertext` (AES-256-GCM via vault)
- **settings** — `key, value_json, updated_at`
- **api_tokens** + audit (migration 0005) — `nlo_...` tokens, scopes,
  rate-limit counters, audit trail
- **auth_sessions** — `id, account_id, provider, profile, email, state,
last_verified_at, last_error, …`
- **schema_migrations**

Per-job archive on disk: `data/jobs/<job-id>/` (uploads, outputs, worker
logs). `data/` is git-ignored and must survive any deploy/checkout.

---

## 6. API surface

Two coexisting surfaces (v1 re-registers every legacy route module under
`/api/v1` with auth added):

- **`/api` (legacy, loopback-trust):** health/ready, jobs (create incl.
  `from-text`, list, get, events, attempts, artifacts, download, cancel,
  requeue), accounts, proxies, sessions, providers, settings.
- **`/api/v1` (token auth):** bearer `nlo_...` tokens with scopes
  `admin`, `jobs:read`, `jobs:write`, `jobs:cancel`, `jobs:download`,
  `meta:read`; per-token sliding-window rate limit (default 120/60s);
  `x-correlation-id`; idempotency-key support; redacted audit trail;
  token management under `/api/v1/tokens`.
- **Docs:** `/api/openapi.json` (OpenAPI, **54 operations** verified live on
  4871, 2026-11-10) and `/api/docs` (Swagger UI).
- **Error envelope (all routes):** `{ "error": { "code", "message",
"details?" } }` — codes from `packages/shared/src/api-error.ts`, values
  redacted.
- **Auth bootstrap:** first admin is created offline via
  `npm run bootstrap:admin --workspace @nlo/server` (one-shot); there is no
  public token-issuing endpoint.

Route modules (both surfaces): `health`, `jobs` (+`job-create`,
`job-create-text`), `accounts`, `proxies`, `sessions`, `providers`,
`settings`, `tokens`.

---

## 7. Providers & worker protocol

- `NotebookLMProvider` interface (§4.1). Provider is chosen **explicitly** by
  `NLO_PROVIDER` (`mock` | `python-worker`); no silent fallback.
- **MockProvider** — default; deterministic; safe for CI/tests; never touches
  network.
- **PythonWorkerProvider** — spawns `nbl_worker.py` (Playwright, venv under
  `data/venv`), communicates over stdin JSON-line protocol (ASCII-only frames;
  a non-ASCII protocol regression test exists). Ops: `ping`, `validate`,
  `verify`, `login`, `browser-import`, `job` (audio), `job_text` (H1
  text-to-notebook). Settle-once contract (Phase 1 worker-wedge fix): a job
  result is delivered exactly once.
- Job pipeline (job-runner): validate → pick account → ensure session
  (preflight gate for python-worker) → pick proxy node → verify tunnel
  (fail-closed) → run provider job via tunnel → record answer/artifacts →
  terminal state. Retries with backoff; max 3 attempts; job timeout 30 min.
- Capability honesty: `capabilities()` + `inputCapabilities()` declared per
  provider; the API never reports an unsupported operation as successful.

---

## 8. Proxy architecture (VLESS → NotebookLM)

- EgressGuard → ProxyManager → Xray runtime (vendor binary
  `data/vendor/xray`) → VLESS node → Google/NotebookLM.
- **Fail-closed:** provider traffic never goes direct without a verified proxy
  tunnel (tested in `fail-closed.test.ts`); `NLO_ALLOW_DIRECT_EGRESS` exists
  but is off by default.
- Staged health checks: SSRF guard → config validation → runtime health →
  tunnel fetch → (periodic) real-traffic check; 10-minute TTL; history table
  retained.
- Node selection: `preferred` first, then `priority`.
- SSRF guards (`packages/shared/src/ssrf.ts`) for all URL-based operations.

---

## 9. Frontend (Persian-RTL web app)

Pages: Dashboard, CreateJob (audio **or** text — Phase 3.1 unified), Job
History, Job Details, Accounts, Proxies, Settings. Talks **only** to
`/api/*` via `lib/api.ts` (725 lines). Jalali calendar dates, Tailwind v4
RTL theme, shadcn-style component set. Served by the server as static files
with SPA fallback (single-port deployment).

---

## 10. Documentation index (where to look)

| Area                         | Files                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Master mission & roadmap** | `docs/ROADMAP_MASTER.md` (18 phases + endpoint-migration addendum s52→172.30.0.133), `AGENTS.md` (permanent rules), `CONTRIBUTING.md`                                                                                                                                                                                                                                          |
| **Status checkpoint**        | `docs/reports/NLO_MASTER_EXECUTION_STATUS.md` (phase table, blockers B1–B10, 2026-11-09 reconciliation)                                                                                                                                                                                                                                                                        |
| **Change history**           | `CHANGELOG.md` (944 lines, honest-labeled per-phase entries)                                                                                                                                                                                                                                                                                                                   |
| **Architecture**             | `docs/architecture/overview.md` (Persian), `provider-evaluation.md`, `proxy-design.md`, `h1-text-to-notebook.md`                                                                                                                                                                                                                                                               |
| **Deployment**               | `docs/deployment/s52-deploy.md` (host-agnostic canonical procedure), `deploy/nginx/README.md` (staged HTTPS), `deploy/deploy.sh`                                                                                                                                                                                                                                               |
| **Operations**               | `docs/operations/gitlab-sync.md`, `docs/operations/README.md`                                                                                                                                                                                                                                                                                                                  |
| **API**                      | `docs/api/README.md`, `docs/api/examples/` (client.ts, from-text.md/.py), live `/api/docs`                                                                                                                                                                                                                                                                                     |
| **Testing**                  | `docs/testing/README.md` (test levels: unit / feature / E2E-mock / live-manual)                                                                                                                                                                                                                                                                                                |
| **Security**                 | `SECURITY.md`, `docs/security/threat-model.md`                                                                                                                                                                                                                                                                                                                                 |
| **Customer docs (Wiki)**     | `docs/wiki/01…14-*.md` (14 pages, published to Wiki.js when credentials allow)                                                                                                                                                                                                                                                                                                 |
| **Phase reports**            | `docs/reports/` — 35+ reports: Phase 0 reconciliation, Phase 1 (GitHub publication, local Swagger, stabilization), Phase 2 (API auth, audio live, stages 0–5), Phases A/B/C, G1–G3a (endpoint migration, new-host audit), H0/H1 (text-to-notebook), P0 (audio recovery), R/R1 (reconciliation, artifact recovery), T0 (stuck-jobs audit), `PRODUCTION_READINESS_2026-11-06.md` |

---

## 11. Production environment (identified)

**Canonical production host: `172.30.0.133`** (hostname AI-TOOLS).

Facts (from read-only audits `PHASE_G3A_NEW_HOST_AUDIT.md`,
`PRODUCTION_READINESS_2026-11-06.md`, `PHASE_T0_STUCK_JOBS_AUDIT.md`;
dates 2026-11-04…06 — **not** re-verified live today):

- **OS/host:** Ubuntu 24.04.4, OpenSSH 9.6p1, host key
  `SHA256:BP+9ekCAA+LaalRmqt84JQydR+PUwx0GQ8a33t4U7WY`; access via `saber`
  user publickey (no passwordless sudo — blocker B5).
- **NLO service:** systemd unit `nlo`; app at
  `/home/saber/saberprojects/notebooklm-orchestrator`; **deployed commit
  `d705634`** (2026-11-04 03:33 UTC); **loopback-only 127.0.0.1:4870**;
  provider `python-worker` configured; xray available; service active and
  ready at audit time (`/api/health`, `/api/health/ready` both green).
- **Runtime on host:** Node v22.23.4 at `/home/saber/.local/node22/bin`
  (custom install), Python 3.12.3 (venv under `data/venv`), FFmpeg 6.1.1,
  Docker 29.1.3.
- **Data:** `data/` (DB `data/nlo.sqlite`, archives, vault, sessions, vendor
  xray, venv, backups ×5 retention) — git-ignored, intact, must survive any
  deploy.
- **Jobs on prod (T0 audit):** 3 total, all terminal — 2 SUCCEEDED (real
  NotebookLM), 1 FAILED (auth). Nothing stuck.
- **Deploy path:** git-based `deploy/deploy.sh` (refuses dirty tree; backs up
  DB + `.env` with 5× retention; `git reset --hard <commit>`; conditional
  `npm ci` / venv sync; `sudo systemctl restart nlo`; verifies health/ready/
  port/journal; prints previous-good commit for rollback).
- **Nginx/HTTPS:** Stage A (HTTP + 301 + ACME location) **live** on prod;
  Stage B (full HTTPS) **pending certbot — blocked by DNS**: `nlo.ai.ismc.ir`
  currently points to edge `185.213.10.25`, not `172.30.0.133` (blocker
  related to B6/B7).
- **LiteLLM (distinct service, same host):** `http://172.30.0.133:4000/v1`
  — internal LLM proxy, LiteLLM v1.101.0, bound 0.0.0.0:4000, Bearer auth,
  **key NOT provisioned**. `172.30.0.133:4000` is LiteLLM — **NOT NLO**.
  NLO consumes it via `NLO_INTERNAL_API_BASE_URL` (currently no key ⇒ feature
  dormant).
- **Legacy host:** s52 (`172.20.1.52`) **decommissioned 2026-11-01**
  (unreachable). The endpoint-migration addendum (Phases G1–G3) moved
  everything to 172.30.0.133.

---

## 12. Configuration (env vars — `apps/server/src/config.ts`, `.env.example`)

| Var                                     | Default                    | Meaning                                                  |
| --------------------------------------- | -------------------------- | -------------------------------------------------------- |
| `NLO_HOST`                              | `127.0.0.1`                | bind address (loopback-only by policy)                   |
| `NLO_PORT`                              | `4870`                     | port (local dev convention: 4871)                        |
| `NLO_DATA_DIR`                          | `data`                     | DB, archives, vault, sessions, vendor, venv              |
| `NLO_VAULT_KEY`                         | —                          | path to AES-256-GCM key file (0600)                      |
| `NLO_PROVIDER`                          | `mock`                     | `mock` \| `python-worker` (explicit, no silent fallback) |
| `NLO_PROXY_RUNTIME`                     | `mock`                     | `mock` \| `xray`                                         |
| `NLO_MAX_UPLOAD_BYTES`                  | 200 MB                     | upload size limit                                        |
| `NLO_ALLOWED_AUDIO_EXTENSIONS`          | `wav,mp3,m4a,ogg,flac`     | audio whitelist                                          |
| `NLO_ALLOWED_DOCUMENT_EXTENSIONS`       | `txt,docx,srt`             | Phase 3.1 document whitelist                             |
| `NLO_HEALTH_ALLOWLIST`                  | —                          | extra health paths                                       |
| `NLO_PYTHON_BIN`                        | python3                    | worker python                                            |
| `NLO_LOGIN_BROWSER`                     | headless                   | login browser mode                                       |
| `NLO_JOB_TIMEOUT_MS`                    | 30 min                     | per-job timeout                                          |
| `NLO_LIVE_TESTS`                        | off                        | manual live-gate opt-in (never in CI)                    |
| `NLO_ALLOW_DIRECT_EGRESS`               | off                        | fail-closed override (do not enable)                     |
| `NLO_API_AUTH`                          | off locally                | enable token auth for v1                                 |
| `NLO_API_RATE_LIMIT_MAX` / `_WINDOW_MS` | 120 / 60000                | per-token rate limit                                     |
| `NLO_INTERNAL_API_BASE_URL`             | `http://172.30.0.133:4000` | internal LiteLLM (key not provisioned)                   |
| `NLO_MAX_TEXT_CHARS`                    | 200000                     | text input cap                                           |

---

## 13. Test suite & fresh verification evidence (2026-11-10)

Fresh run on local dev (Node v24.14.0, repo root, `npm test`):

- **278/278 passing** across 3 workspaces (fresh re-run after Phase 3.3 landed):
  - `packages/shared`: **85** (job-state, redaction, retry, safe-name, ssrf,
    text-source, title, srt, input-capabilities)
  - `apps/server`: **163** (api surface, job lifecycle, fail-closed, session
    gate, worker supervisor/recovery/non-ascii, first-admin, openapi-v1,
    document-sources, from-text, internal-llm, config, accounts repo)
  - `apps/web`: **30** (api client, jalali, utils, create-job)
- Up from 227/227 on 2026-11-09 → **Phase 3.1 added 48 tests**.
- Local dev server **4871**: `/api/health` → `{"ok":true}`;
  `/api/health/ready` → `ready:true`, provider `python-worker` configured,
  xray available. Port **4870** locally: connection refused (expected —
  4870 is the prod convention; local dev uses 4871).
- OpenAPI on 4871: **54 operations** (spec grew from 53 at `4ae25da` with
  Phase 3.1).
- E2E-live scripts (`apps/server/scripts/e2e-live.ts`, `verify-live.ts`)
  exist but are **manual gates** (real Google accounts, real egress, cost) —
  not run in this session.

---

## 14. Roadmap & phase status (as of 2026-11-10)

From `docs/ROADMAP_MASTER.md` + `NLO_MASTER_EXECUTION_STATUS.md` (2026-11-09
reconciliation, re-confirmed today):

- **Phase 0 (reconciliation):** completed.
- **Phase 1 (governance/stabilization, GitHub publication, local Swagger):**
  VERIFIED-COMPLETED (incl. worker-wedge fix, settle-once).
- **Phase 2 (API authentication + audio-live reliability):**
  VERIFIED-COMPLETED (close-out committed at `b56ec9b`; live audio accepted;
  sessions, proxies, retries verified in code + recorded live evidence).
- **Phase 3 (unified text/audio workflow):**
  - **3.1 (unified input capability matrix + DOCX/SRT/TXT document sources):
    COMMITTED at `e973451`** — 48 new tests green; pushed in the follow-up.
  - **3.3 (audio title fallback = user override || cleaned filename):
    COMMITTED** (3 new tests + CHANGELOG entry); pushed in the follow-up.
  - Next: Phase 4, then 5 (webhooks — needs B8), 6.
- **Endpoint-migration addendum (Phases G1–G3):** complete on the new host
  (deployed, healthy, Stage A nginx live; Stage B blocked on DNS).
- **H1 (text-to-notebook):** implemented + live-verified (on prod since
  `d705634`).
- **P0 (audio recovery):** implemented + live-verified (on prod).

### Open blockers (carried from preflight, renumbered 2026-11-09)

| #     | Blocker                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| B1    | GitLab mirror inactive (needs maintainer PAT, api scope; then 4-step setup per `docs/operations/gitlab-sync.md`) |
| B5    | No passwordless sudo on prod host (deploys need the sudo password)                                               |
| B6/B7 | DNS: `nlo.ai.ismc.ir` → 185.213.10.25 (edge), not 172.30.0.133 — blocks certbot / nginx Stage B HTTPS            |
| B8    | Webhooks — deferred to Phase 5                                                                                   |
| B9    | LiteLLM API key not provisioned (internal LLM feature dormant)                                                   |
| B10   | Wiki.js publish credentials not provided (customer docs stay in `docs/wiki/`)                                    |

(Full table with details: `docs/reports/NLO_MASTER_EXECUTION_STATUS.md` §7.)

---

## 15. Local development environment (fresh inventory, 2026-11-10)

- **Local server:** port **4871**, up and healthy (provider `python-worker`
  configured, xray available). Port 4870 not bound locally.
- **Local `data/`:** `nlo.sqlite`, `vault.key`, `venv/`, `vendor/`,
  `backups/`, `jobs/`, `sessions/` — all present.
- **Local DB inventory (fresh read-only query today):**
  - **accounts (3):**
    - `acc_9ef8fd4d431c49fc` "sas" — `saber.tabataba@gmail.com` — AUTH_REQUIRED
    - `acc_315776aeb5b74e33` "صابر" — `saber.tabatabaee@gmail.com` — **ACTIVE**
    - `acc_f95b0872c0d344cc` "صابر1404" — `sabar.tabatabaei1404@gmail.com` — AUTH_REQUIRED
  - **proxy_nodes (2):** "france1-SeyedSaber", "England_1" (both enabled,
    priority 100, none preferred)
  - **api_tokens:** 0 (local)
  - **settings:** empty
  - **auth_sessions (3):** one AUTHENTICATED (account "صابر", python-worker,
    last verified 2026-11-06T23:07:51), two AUTH_REQUIRED
  - **jobs (22 total):** 5 SUCCEEDED, 12 FAILED, 5 CANCELLED — all terminal,
    none in flight. Most recent: `j_367ea5ba…` SUCCEEDED 2026-11-06 23:15
    (the live-verified real audio job from the 2026-11-09 reconciliation).
  - **migrations:** 5 applied (0001–0005).

---

## 16. Quick reference for future sessions

```bash
# Run everything
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build

# Local dev (port 4871 by .env)
npm run dev

# Health (local dev)
curl http://127.0.0.1:4871/api/health
curl http://127.0.0.1:4871/api/health/ready

# OpenAPI / Swagger (local dev)
curl http://127.0.0.1:4871/api/openapi.json
# browser: http://127.0.0.1:4871/api/docs

# First-admin bootstrap (offline, one-shot)
npm run bootstrap:admin --workspace @nlo/server

# Manual live gates (NEVER in CI)
apps/server/scripts/e2e-live.ts  /  verify-live.ts   (NLO_LIVE_TESTS=1)

# Production deploy (on 172.30.0.133, as saber; needs sudo password)
cd /home/saber/saberprojects/notebooklm-orchestrator
bash deploy/deploy.sh            # deploys origin/main
ROLLBACK=1 bash deploy/deploy.sh <previous-good-commit>

# Prod health (on host, loopback)
curl http://127.0.0.1:4870/api/health
systemctl status nlo
```

**Do-not list:** never push force; never commit secrets (`.env`, cookies,
tokens, VLESS UUIDs, vault keys, sessions); never enable
`NLO_ALLOW_DIRECT_EGRESS`; never bind non-loopback without an
auth-capable reverse proxy; never `git reset --hard` on prod to a foreign
tree; never delete `data/`; never run live scripts in CI.

---

## 17. Honest capability status (summary)

| Capability                                                                                | Status                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| REST API (legacy + v1 token auth), OpenAPI/Swagger, rate limiting, audit, correlation IDs | Implemented + unit/feature tested; live surface verified on prod (read-only, 2026-11-06) |
| Audio jobs (real NotebookLM via proxy)                                                    | Implemented + **live-verified** (local dev 2026-11-06; prod 2× SUCCEEDED real jobs)      |
| Text-to-notebook (H1)                                                                     | Implemented + **live-verified** (deployed on prod since `d705634`)                       |
| Document sources TXT/DOCX/SRT (Phase 3.1)                                                 | Implemented + unit tested (48 new tests); committed + pushed; **not live-verified**      |
| Audio title from filename (Phase 3.3)                                                     | Implemented + unit tested (3 new tests); committed + pushed; **not live-verified**       |
| Proxy tunneling (xray/VLESS, fail-closed)                                                 | Implemented + tested; live-verified on local dev                                         |
| Webhooks                                                                                  | Planned (Phase 5, blocked by B8)                                                         |
| GitLab mirror                                                                             | Blocked (B1 — no PAT)                                                                    |
| HTTPS Stage B                                                                             | Blocked (B6/B7 — DNS)                                                                    |
| Internal LiteLLM integration                                                              | Code present; dormant (B9 — no key)                                                      |
| Wiki.js publishing                                                                        | Blocked (B10 — no credentials)                                                           |

---

## 18. Integrity statement

This audit made **no changes** to the working tree, no pushes, no deploys, no
live calls. All statements are from: direct file reads, git inspection, fresh
local `npm test` (initially 275/275; 278/278 after Phase 3.3 landed), local health endpoints, and a fresh read-only
SQLite inventory — dated 2026-11-10. Production facts are carried verbatim
from the cited read-only reports (2026-11-04…06) and are explicitly marked as
not re-verified live in this session.
