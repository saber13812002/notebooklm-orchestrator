# Changelog

All notable changes to the NotebookLM Orchestrator are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is commit-based (no semantic versions yet — tags are the next
step in the API productization phase).

Honesty rule: an entry may say "implemented" only with tests; "live-verified"
only with a recorded live run; otherwise "planned".

## [2026-11-02] — Endpoint-migration addendum, Phase G3-A (new production host secure access + read-only audit)

### Verified (read-only)

- **SSH access to the new production host `172.30.0.133` (`AI-TOOLS`) is
  provisioned and verified:** publickey login as `saber` (local `id_ed25519`),
  host key `ssh-ed25519 SHA256:BP+9ekCAA+LaalRmqt84JQydR+PUwx0GQ8a33t4U7WY`
  pinned; OpenSSH 9.6p1 (host) ↔ OpenSSH_for_Windows 9.5p2 (client), KEX
  `curve25519-sha256`. Passwordless sudo: **no** (firewall state therefore
  unverified — recorded limitation).
- **Host:** Ubuntu 24.04.4 LTS, kernel 6.8.0-147-generic, 20× Xeon Gold 6458Q,
  78 GiB RAM, 686 GiB disk (37 % used), uptime 2 days; Node v22.23.4 at
  `/home/saber/.local/node22/bin` (not on default PATH), Python 3.12.3,
  Docker 29.1.3, ffmpeg 6.1.1, git 2.43.0; systemd `degraded` due to one
  unrelated failed unit (`llmhub-feedback.service`).
- **NLO is already deployed and running on the new host** (found, not assumed):
  `nlo.service` active since 2026-10-31 07:10 UTC, bound **loopback-only**
  `127.0.0.1:4870`, deployed commit `b5e9ad3` (clean ancestor of `50b31e7`),
  `/api/health` + `/api/health/ready` OK (python-worker configured, xray
  runtime available, live egress disabled).
- **LiteLLM on `127.0.0.1:4000` (on-host, read-only):** liveliness + readiness
  healthy, `info.version = 1.101.0`, `/v1/models` 401 without key; **LLM key
  not provisioned** (no key/token/secret lines in the on-host `.env`); no
  inference sent.
- **Legacy s52 data already migrated and intact:** `data/` with `nlo.sqlite`
  (164 K), 5 DB + 5 `.env` backups (0600), `vault.key` (0600), `sessions/`
  (0700, 1 account), `vendor/xray` (40 M), `venv` (198 M, Python 3.12.3),
  3 historical job dirs. No copy/delete/migrate performed; no cookie or
  session contents printed.
- **Deployment prep:** `deploy.sh` (host-agnostic, already prepends
  `node22/bin`) and `nlo.service` (paths + Node PATH verified identical on
  host) require **no adaptation**; advancing to `50b31e7` is a clean
  fast-forward from `b5e9ad3`. On-host `.env`: loopback host/port,
  `NLO_ALLOW_DIRECT_EGRESS=1`, `NLO_INTERNAL_API_BASE_URL` absent (compiled
  default is correct).
- **Security findings (read-only):** live `.env` perms `0664` (recommend
  `0600` in G3-B); firewall unverified (no sudo); LiteLLM binds `0.0.0.0`
  (property of the LLM-proxy service, not NLO); no secrets in repo or on-host
  `.env`.

### Added

- `docs/reports/PHASE_G3A_NEW_HOST_AUDIT.md` — full audit: SSH verification +
  fingerprint, host inventory, running NLO state, LiteLLM verification,
  legacy data inventory (sizes/ownership/permissions only), deploy-file
  review, security findings, and the G3-B deploy/backup/rollback plan.

### Notes

- **Mandatory STOP honored:** no install, deploy, restart, `.env` change, DB
  migration, or firewall/proxy/TLS change was made. Awaiting explicit
  approval for G3-B (deploy to `50b31e7`).

## [2026-11-02] — Endpoint-migration addendum, Phases G1+G2 (live endpoint verification + production readiness)

### Verified (read-only)

- **G1 — live probes from the authorized company network:** TCP
  `172.30.0.133:4000` connected (112 ms); `GET /` 200 (LiteLLM Swagger UI);
  `GET /openapi.json` 200 (1,517,449 B; `info.version = "1.101.0"`);
  `/health/liveliness` 200 (3 ms); `/health/readiness` 200
  (`{"status":"healthy","db":"connected"}`, 2–6 ms over 5 calls);
  `GET /v1/models` without key → deterministic **401** `auth_error`
  ("No api key passed in.") — i.e. **TCP and unauthenticated HTTP are
  live-verified; authenticated `/v1/models` is NOT verified** (LLM key not
  provisioned; no inference request sent).
- **G1 negative control:** `172.30.0.133:4870` refused (NLO still not on the
  new host); DNS `nlo.ai.ismc.ir` A → `172.30.0.133` (TTL 600).
- **G2:** SSH port 22 open (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20`,
  15 ms; banner only, **no login attempted**); local ssh config/known_hosts
  audited (only legacy s52/jump53 entries — no new-host entry); deploy path
  (`deploy.sh` + `nlo.service`) host-agnostic and ready; `data/` + backups
  absent locally (fresh-host scenario).
- **G2 config sweep:** `NLO_INTERNAL_API_BASE_URL` default
  `http://172.30.0.133:4000` equals the live-verified endpoint; local `.env`
  does not set it; Docker/CI unaffected; client not yet wired into routes
  (Phase E scope). No configuration change made.
- **Regression:** `npm test` on `0e5b8b8` — **175/175** (shared 44 + server
  106 + web 25), including `config-internal-api` (5) and `internal-llm` (6,
  in-process mock — NOT live).

### Added

- Reports:
  [`docs/reports/PHASE_G1_ENDPOINT_LIVE_VERIFICATION.md`](docs/reports/PHASE_G1_ENDPOINT_LIVE_VERIFICATION.md)
  and
  [`docs/reports/PHASE_G2_PRODUCTION_READINESS.md`](docs/reports/PHASE_G2_PRODUCTION_READINESS.md)
  (initial state, commands+results, connectivity evidence, auth status
  without secrets, deployment SHA, config findings, missing credentials,
  backup/rollback readiness, risks, next action).
- [`docs/ROADMAP_MASTER.md`](docs/ROADMAP_MASTER.md) addendum table: G split
  into G1/G2 (done) + G3 (pending, hard approval gate).

### Notes

- Level: **Live (unauthenticated) + Unit/Integration** — mock suite 175/175;
  the live part never sent credentials or inference.
- **Mandatory STOP honored:** no production change, no restart, no `.env`
  change, no deployment, no DNS/proxy/TLS change. G3 is blocked on:
  (1) SSH access to `172.30.0.133` (user + credential, secure channel),
  (2) LLM API key via secret store, (3) on-host fact confirmation
  (paths, Node/Python, `data/` continuity). Awaiting explicit approval.

## [2026-11-01] — Endpoint-migration addendum, Phase F (local verification)

### Verified

- 4871 dev server restarted onto the full addendum tree
  (`3f796a6` + `30b03cd` + `6b9a3ab`, all on `origin/main`):
  `/api/health` and `/api/health/ready` pass (`ready:true`, provider
  `python-worker` configured, proxy runtime `xray` available, live tests
  disabled); web UI served (HTTP 200).
- Full regression on the final tree: **175/175** (shared 44 + server 106 +
  web 25).

### Notes

- Level: **local process verification + Unit/Integration — NOT live.** No
  live provider/egress or real `/v1/models` calls (LLM key still pending).
- Diagnostic: per-readiness worker `spawn → SIGTERM` in the 4871 log was
  investigated and confirmed as the designed transient-probe lifecycle of
  `validateConfiguration()` (clean exit, empty stderr) — not a regression.
- No deployment, DB, or runtime-config change; Phase G (production
  migration on `172.30.0.133`) remains a hard approval gate.
- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_F.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_F.md).
- Phase E commit `6b9a3ab` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase E (integration tests)

### Added

- New module
  [`apps/server/src/internal-llm.ts`](apps/server/src/internal-llm.ts):
  minimal client for the internal LLM proxy (LiteLLM, OpenAI-compatible).
  Every request targets `config.internalApiBaseUrl`
  (`NLO_INTERNAL_API_BASE_URL`) — no hardcoded host; only `/v1/...` paths are
  accepted; Bearer key sent only when provided; error messages contain only
  the target host, HTTP status, and the upstream `error.message` — never the
  key, never a stack.
- New tests
  [`apps/server/test/internal-llm.test.ts`](apps/server/test/internal-llm.test.ts)
  (6 tests, in-process `node:http` mock on 127.0.0.1 ephemeral ports):
  default base URL is the new host with no reference to the legacy
  `172.20.1.52` (string-level, no network); `GET /v1/models` with correct
  Bearer header + parsed 200 body; proxy down → `llm_unreachable` (clean
  message, no stack, no key); exact LiteLLM 401 envelope → `llm_error` with
  upstream message but no key/header leak; accept-but-never-respond →
  `llm_timeout` (AbortController); non-`/v1` paths (incl. traversal) rejected
  before any network call.

### Tests

- Level: **Unit/Integration — in-process mock HTTP, NOT live.** Full suite
  175/175 (shared 44 + server 106 + web 25).
- Live `/v1/models` against the real proxy remains a manual gate pending an
  LLM API key via secret store (carried to Phase F/G).

### Unchanged (explicit non-goals)

- No route/API surface, provider, DB, or deployment change — the client is a
  standalone module not yet wired into any route.
- No network traffic to any real endpoint from CI.

### Notes

- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_E.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_E.md).
- Phase D commit `30b03cd` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase D (documentation migration)

### Changed

- Migrated all **current operational** references to the legacy production
  host s52 (`172.20.1.52`) in: [`AGENTS.md`](AGENTS.md),
  [`README.md`](README.md), [`docs/operations/README.md`](docs/operations/README.md),
  [`docs/deployment/s52-deploy.md`](docs/deployment/s52-deploy.md),
  [`docs/wiki/13-developer-guide.md`](docs/wiki/13-developer-guide.md),
  [`docs/wiki/14-deployment-operations.md`](docs/wiki/14-deployment-operations.md),
  [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/api/README.md`](docs/api/README.md)
  (annotated), [`deploy/deploy.sh`](deploy/deploy.sh) (comment),
  [`deploy/systemd/nlo.service`](deploy/systemd/nlo.service) (comment).
- Phrased honestly per the migration state: legacy host s52 decommissioned
  (unreachable); **NLO is not yet running on the new host `172.30.0.133`**
  (re-deployment pending, addendum Phase G); GitLab/Wiki.js already re-homed;
  LiteLLM (`172.30.0.133:4000`) is the internal LLM proxy, **not** NLO.
- Dead guidance removed: standing s52 SSH tunnel (port 14870) no longer
  presented as working access.

### Unchanged (explicit non-goals)

- All `docs/reports/*` + historical CHANGELOG entries (class ② — verbatim
  historical records).
- Other-service references (class ③): `git.ai.ismc.ir`, `docs.ai.ismc.ir`,
  edge `80.191.92.189`, jump53.
- Every `4870` that is the **app's own port** (config default, Dockerfile,
  compose, CI smoke, vite, scripts) — untouched.
- `docs/deployment/s52-deploy.md` **filename kept** (links from
  `docs/operations/README.md`, wiki 14, README, CONTRIBUTING stay valid);
  content notes the filename is historical.
- No code, config, or runtime behavior change — docs/comments only.

### Notes

- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_D.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_D.md).
- Phase C commit `3f796a6` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase C (centralized config)

### Added

- `NLO_INTERNAL_API_BASE_URL` (default `http://172.30.0.133:4000`) in
  [`apps/server/src/config.ts`](apps/server/src/config.ts) →
  `config.internalApiBaseUrl`. Documented as the **internal LLM proxy
  (LiteLLM, OpenAI-compatible)** — verified 2026-11-01 (read-only) to be an
  LLM API endpoint, not the NLO web address/SSH/proxy. Normalized (trailing
  slashes stripped) and validated (http/https scheme required, fail fast).
- Unit tests: `apps/server/test/config-internal-api.test.ts` (default value,
  override + normalization, https, scheme validation).
- `.env.example` + README env-var table updated.

### Notes

- No runtime consumer yet — the prompt-engine phase (roadmap Phase 9) will
  read `config.internalApiBaseUrl`; no requests are made in this change.
- Audit + connectivity evidence: `docs/reports/SERVER_ENDPOINT_MIGRATION_AUDIT.md`,
  `docs/reports/SERVER_ENDPOINT_CONNECTIVITY.md`; mission: `docs/ROADMAP_MASTER.md`.

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

## [2026-10-29] — Phase 2 (API Authentication — first-admin bootstrap)

### Added

- **First-admin bootstrap (closes F2):** the token chicken-and-egg
  (`POST /api/v1/tokens` requires an `admin` token, so the first token
  could not be created through the API) is solved by an **offline,
  host-only CLI** — deliberately with **no** unauthenticated (or any)
  network endpoint:
  `npm run bootstrap:admin --workspace @nlo/server`
  (`apps/server/src/domain/first-admin.ts` +
  `apps/server/scripts/bootstrap-first-admin.ts`).
- One-shot: refuses while ANY active (enabled, not-revoked) token exists;
  documented recovery = revoke all active tokens → re-run the CLI (name is
  auto-suffixed `first-admin-2`, … if a revoked row still holds the name).
- Secret hygiene: plaintext (`nlo_<slug>_<64hex>`, 32-byte CSPRNG) shown
  exactly once to the operator; only the SHA-256 hash is stored (same as
  `ApiTokensRepo.create`).
- Attributable, secret-free audit row `first_admin_bootstrapped`
  (`method: CLI`, token id only).
- Tests: `apps/server/test/first-admin.test.ts` — unit (format,
  hash-only storage, one-shot gate, rejection with an active API-created
  token, recovery, name collision/suffix, custom name+scopes, audit row)
  - integration/API-level with `NLO_API_AUTH=true` (chicken-and-egg
    proven: even `POST /api/v1/tokens` is 401 anonymously; bootstrap
    unblocks enforced auth; admin creates scoped tokens via API; revocation
    invalidates the token and re-opens recovery; legacy `/api` untouched).
- Docs: root README (API section + feature-status table),
  `docs/api/README.md` (new "First token (bootstrap)" section),
  `docs/wiki/08-api-authentication.md`, `SECURITY.md` (§1 trust model —
  replaced the stale "no API token" statement), `.env.example`.

### Fixed

- (Found by the new tests) the documented "revoke all → re-run" recovery
  would have failed on the UNIQUE `api_tokens.name` constraint once a
  revoked row still held the name; the bootstrap now auto-suffixes the
  name.

### Verified

- `npx vitest run test/first-admin.test.ts` → 12/12 passing (unit +
  integration, in-process, mock provider). Full gate (`npm test`,
  `typecheck`, `lint`, `format:check`, `build`) green.
- Verification level: **Unit/Integration passed.** No deploy, no
  production restart, and **no** enforced auth activation on s52 in this
  phase (production activation procedure is in
  `docs/reports/PHASE_2_API_AUTHENTICATION.md` and awaits explicit
  approval).

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
