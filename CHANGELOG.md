# Changelog

All notable changes to the NotebookLM Orchestrator are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is commit-based (no semantic versions yet — tags are the next
step in the API productization phase).

Honesty rule: an entry may say "implemented" only with tests; "live-verified"
only with a recorded live run; otherwise "planned".

## [2026-10-28] — Phase C (API productization)

### Added

- OpenAPI 3.x contract: `/api/openapi.json` (and `/api/v1/openapi.json`) +
  Swagger UI at `/api/docs` (and `/api/v1/docs`), auth-exempt. Spec lives in
  `apps/server/src/api/openapi/spec.ts` and is asserted against the live
  route table in **both directions** by `apps/server/test/openapi-v1.test.ts`
  (no spec↔live drift in either direction).
- Versioned surface `/api/v1/*` mirroring the legacy resource model (52
  operations); the legacy `/api/*` surface is unchanged and un-gated.
- API tokens (C4): create/list/enable/disable/revoke at `/api/v1/tokens`,
  scopes (`jobs:read`, `jobs:write`, `jobs:cancel`, `jobs:download`,
  `meta:read`, `admin`), SHA-256-only storage, plaintext shown exactly once.
  Optional by default (loopback keeps working); `NLO_API_AUTH=1` enforces
  tokens on non-exempt v1 routes (401 + `auth_required`/`auth_failed` audit
  rows). Token management is always `admin`-gated (defense in depth).
- Per-token sliding-window rate limiting
  (`NLO_API_RATE_LIMIT_MAX`, `NLO_API_RATE_LIMIT_WINDOW_MS`) →
  `429 rate_limited` with `details.retryAfterSeconds` + audit row.
- Append-only audit trail (`api_audit_log`) queryable via
  `GET /api/v1/audit` (admin); anonymous traffic is never audited; token
  plaintexts never appear in the log.
- Idempotent job creation (C5): `Idempotency-Key` honored only with a
  resolved token (per-token scoped); replay → `200` +
  `x-idempotent-replay: true`, no duplicate job/archive.
- Correlation IDs: every `/api/v1` response carries `x-correlation-id`
  (echoed or generated `cr_<32hex>`).
- Docs: `docs/api/README.md` rewritten (auth model, scopes, cURL +
  runnable TypeScript client `docs/api/examples/client.ts` + Python
  example), `docs/wiki/08-api-authentication.md` and
  `docs/wiki/09-api-guide.md` updated, `.env.example` + root README
  updated.
- Migration `0005_api_tokens.sql` (api_tokens + api_audit_log tables).

### Fixed

- **Production bug (found by the new tests):** the v1 child-encapsulation
  `onRequest`/`onResponse` hooks were synchronous 2-arg functions;
  Fastify 5's hook runner only advances on a returned Promise or an explicit
  `next` call, so **every `/api/v1` request deadlocked** on a live server.
  Hooks are now async.
- `loadConfig(overrides)`: `NLO_*` integer/boolean vars were read from
  `process.env` directly, silently ignoring overrides (tests and any
  programmatic config injection were bypassed). `intEnv`/`boolEnv` now
  honor the override map.

### Verified

- `npm test` all workspaces green (152 tests: shared 44, server 83 incl. 24
  new, web 25); `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run build` all clean.
- Verification level: **Unit/Integration/E2E (in-process, mock provider)
  passed.** Live (`NLO_LIVE_TESTS`) remains a manual gate only.
- No push, no deploy: s52 continues serving from its current commit until
  a reviewed deploy is requested (Phase D territory).

### Verified (2026-10-28 — live acceptance, `b5e9ad3` deployed on s52 at 13:43Z)

- **Production smoke (s52):** `/api/health` + `/api/health/ready` 200;
  `/api/openapi.json` (52 operations) + `/api/docs` (Swagger UI) live-verified;
  legacy + v1 surfaces green; Web UI (index/asset/SPA fallback) 200; single
  service instance; 3 jobs intact (no data loss); rollback `80a9e66` ready.
- **Deployed-code feature checks** (sandbox, deployed code, mock provider,
  `NLO_API_AUTH=true`): enforced auth (401/403/429 + audit), scopes,
  revoked/disabled tokens, idempotent replay (`x-idempotent-replay`, no
  duplicate job), correlation IDs (echo/generate), and the runnable
  TypeScript client + Python client from `docs/api/README.md`.
- **Not performed (honest):** the one controlled live audio-to-text job —
  session re-verify failed at the NotebookLM region/anti-abuse gate
  (`location=unsupported`, both egress nodes); mock results were never
  reported as live. Full report:
  `docs/reports/PHASE_C_LIVE_ACCEPTANCE.md`.

### Unchanged

- Legacy `/api/*` behavior, loopback trust model, queue/provider/proxy
  internals, docker/compose, deploy scripts.
- Webhooks remain **planned** (Phase G).

## [Unreleased]

### Added (governance & documentation)

- `AGENTS.md` — permanent development rules for all agents/contributors.
- `CONTRIBUTING.md` — how to propose and land changes.
- `SECURITY.md` — security policy + vulnerability reporting channel.
- `CHANGELOG.md` — this file.
- `docs/` restructured by topic: `architecture/`, `development/`,
  `deployment/`, `security/`, `api/`, `testing/`, `operations/`, `reports/`,
  `wiki/`.
- `docs/wiki/` — customer documentation source (Markdown; published to
  Wiki.js when API credentials are authorized).
- CI: GitHub Actions workflow (lint, typecheck, tests, build) and a ready
  `.gitlab-ci.yml` for the internal GitLab (`git.ai.ismc.ir`).

### Unchanged (explicit non-goals of this change)

- No API changes: no versioning, no new auth, no webhooks — those are Phase C.
- No production restart; s52 continues serving from its current commit until
  a reviewed deploy is requested.

## [2026-10-27] — P3 (repository & deployment audit)

### Added

- `deploy/deploy.sh` — reproducible git-based deployment with DB+env backup
  (5 retained), preflight checks, post-restart health/ready/port/journal
  verification, regression test run, and `ROLLBACK=1` rollback.
- `deploy/systemd/nlo.service` — secret-free production unit (tracked).
- `docs/deployment/s52-deploy.md` — canonical deployment procedure.

### Fixed

- `deploy.sh`: PATH-hardened dependency install + repo-local vitest for
  non-interactive SSH shells.

### Removed

- Tracked Python bytecode cache (`__pycache__/*.pyc`) — regenerable artifact.

## [2026-10-26] — P2 (deployed & live-verified)

### Fixed

- Proxy: probe curl candidates at startup so a broken distro curl is skipped.
- Runner: clear stale error fields when a job succeeds; cancel-vs-late-success
  race; worker cancel/redaction; Windows worker stdin.
- Worker: honor shutdown via stdin EOF + loop signal handlers.

### Verified

- Real NotebookLM job (audio → grounded answer) executed end-to-end through
  the Python worker and Xray tunnel (live-verified; evidence in
  `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md`).

## [2026-10-25] — P1 (foundation, deployed)

### Added

- Monorepo (npm workspaces): `apps/server` (Fastify + node:sqlite),
  `apps/web` (React + Vite, Persian RTL), `packages/shared`.
- Job state machine (shared, tested), durable queue with restart recovery,
  job archives (manifest, timeline, attempts, artifacts).
- Provider abstraction: `NotebookLMProvider` interface; MockProvider
  (default) + PythonWorkerProvider (explicit opt-in) with capability matrix.
- Proxy runtime: VLESS URI parser, masking, MockRuntime + Xray adapter;
  fail-closed egress guard (tested).
- Secrets: file vault AES-256-GCM (0600 key), log redaction, safe names,
  SSRF guard (all unit-tested).
- REST API: jobs (create/list/get/events/attempts/artifacts/cancel/requeue),
  accounts + sessions, proxies, settings, secrets (redacted), provider,
  health/readiness.
- Docker: `Dockerfile` (self-contained live-mode image) +
  `docker-compose.yml` (loopback-only, `./data` persistence).
