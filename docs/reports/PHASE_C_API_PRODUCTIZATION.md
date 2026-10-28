# Phase C — API Productization (Report)

Date: 2026-10-28 (UTC)
Baseline at start: `main` @ `4be0a20` (Phase B report), tree clean.
Target at end: this phase's commits (see §2).
Status: **complete, local commit done — NO push, NO deploy** (per mission:
stop after the Phase C report and await Phase D approval).

## 1. Mission recap

Phase C scope (per master prompt: "Complete Phase C with tests and
documentation. After reporting Phase C, stop and wait for Phase D approval"):

- **C1** — Audit the existing API surface (~35 legacy `/api/*` routes,
  error envelope, loopback trust model). Done at phase start (findings:
  consistent envelope via `ApiCodes`, zod validation on all routes, app-level
  rate limit 300/min, no auth, no versioning, no machine-readable contract).
- **C2** — OpenAPI 3.x contract at `/api/openapi.json` + Swagger UI at
  `/api/docs`, with automatic **bidirectional** contract validation
  (spec ↔ live route table; drift fails the test suite).
- **C3** — Public API under `/api/v1/`, compatible migration, legacy
  endpoints never deleted or altered in behavior.
- **C4** — API tokens: create/revoke, scopes, per-token rate limiting,
  audit events, hash-only storage, no cross-user access, no secrets in logs.
- **C5** — Job API contracts: create/upload/list/details/status/outputs/
  download/retry/cancel; asynchronous; idempotency + correlation IDs.
- **C6** — SDK/examples (cURL + TypeScript + Python) hitting the REAL API
  (no mocks in the client).

Explicit non-goals honored: no push, no deploy, no s52 restart, no webhooks
(Phase G), no DNS/external publishing (Phase F), no Docker/deploy-script
changes, no live-test runs (manual gate only).

## 2. Commits (logical, reviewable)

| #   | Commit (message prefix)                                                | Scope                                                                 |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `feat(api): versioned /api/v1 surface with OpenAPI contract + docs`    | routes refactor to `base` param, v1 registration, spec, Swagger, docs |
| 2   | `feat(api): API tokens, scopes, per-token rate limiting, audit trail`  | migration 0005, `ApiTokensRepo`, token/audit routes, config           |
| 3   | `feat(api): idempotent job creation + correlation IDs (C5)`            | shared job-create core, idempotency, correlation                      |
| 4   | `fix(api): async v1 hooks + config override threading (bug fixes)`     | the two production bugs found by the new tests (§6)                   |
| 5   | `test(api): openapi-v1 contract + auth + idempotency suite (24 tests)` | `openapi-v1.test.ts`                                                  |
| 6   | `docs: Phase C API docs, wiki updates, CHANGELOG`                      | `docs/api/`, `docs/wiki/08+09`, `.env.example`, README                |
| 7   | `docs(reports): Phase C report`                                        | this file                                                             |

(Commit plan as executed; SHAs in `git log` after step 14 of this phase.)

## 3. Deliverables C1–C6 (with honest status labels)

| Item                                                                                | Status                                                                                                       | Evidence                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| C1 legacy API audit                                                                 | IMPLEMENTED_AND_VERIFIED                                                                                     | §1 + `docs/reports/PHASE_A_AUDIT.md` §7; regression suite `api.test.ts` (59 tests) still green |
| C2 OpenAPI at `/api/openapi.json` + Swagger `/api/docs` (mirrored under `/api/v1/`) | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | `spec.ts` + `v1.ts`; 24-test suite; bidirectional drift test                                   |
| C3 `/api/v1/*` versioned surface (52 ops), legacy unchanged                         | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "v1 mirrors the legacy surface" describe; legacy tests untouched                               |
| C4 tokens: create/list/enable/revoke, scopes, hash-only                             | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "token lifecycle", "enforced auth mode" describes                                              |
| C4 per-token rate limiting                                                          | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "per-token rate limiting" describe (429 + `retryAfterSeconds` + audit)                         |
| C4 audit trail (append-only, token-attributed, no secrets)                          | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "audit trail" describe; `api_audit_log` table                                                  |
| C5 idempotent job creation (`Idempotency-Key`, token-scoped)                        | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "idempotent job creation" describe                                                             |
| C5 correlation IDs (`x-correlation-id`)                                             | IMPLEMENTED_AND_VERIFIED (Unit/Integration/E2E-mock)                                                         | "correlation ids" describe                                                                     |
| C6 cURL + TypeScript + Python examples hitting the real API                         | IMPLEMENTED_AND_VERIFIED (examples reviewed against verified response shapes; not executed against live s52) | `docs/api/README.md`, `docs/api/examples/client.ts`                                            |
| Webhooks                                                                            | NOT_IMPLEMENTED (Phase G, by plan)                                                                           | —                                                                                              |
| External publishing / TLS / domain                                                  | NOT_IMPLEMENTED (Phase F, by plan)                                                                           | —                                                                                              |

## 4. New/changed files (by purpose)

**New (server):**

- `apps/server/src/api/v1.ts` — v1 group (child encapsulation):
  `onRequest` (correlation → token resolve → enforce → rate limit → scope) +
  `onResponse` (final-status audit), `TokenRateLimiter`, `bearerToken`,
  `correlationIdFor`, `requiredScope`, `hasScope`, `isExempt`, `audit()`,
  contract routes (`/api/openapi.json`, `/api/v1/openapi.json`, `/api/docs`,
  `/api/v1/docs` + Swagger HTML).
- `apps/server/src/api/openapi/spec.ts` — `buildOpenApiDocument(ctx)`:
  OpenAPI 3.x, 52 operations, `servers: [{url: "/api/v1"}]`, components
  (ErrorEnvelope, Job, JobList, ApiToken, AuditEvent), `apiKeyAuth` bearer
  scheme. Served verbatim.
- `apps/server/src/api/job-create.ts` — shared job-creation core used by
  BOTH surfaces (multipart drain, validation, archive init/rollback,
  idempotency lookup) — one implementation, so v1 cannot drift.
- `apps/server/src/api/request-augment.ts` — `FastifyRequest` augmentation
  (`apiToken`, `apiTokenAuthorized`, `correlationId`, `apiAuditRecorded`).
- `apps/server/src/api/routes/tokens.ts` — token management + audit query
  (always token-gated; defense in depth even in optional mode).
- `apps/server/src/domain/api-tokens.repo.ts` — `ApiTokensRepo`:
  `nlo_<slug>_<64hex>` plaintext, `tok_<24hex>` ids, SHA-256-only storage,
  `resolve()` (null on unknown/revoked/disabled), 30s-throttled
  `last_used_at`, append-only audit + `auditList`.
- `apps/server/src/db/migrations/0005_api_tokens.sql` — `api_tokens` +
  `api_audit_log` (FK `ON DELETE SET NULL` keeps audit attributable).
- `apps/server/test/openapi-v1.test.ts` — 24 tests, 9 describes (contract
  drift both directions, v1↔legacy mirror, optional/enforced auth, token
  lifecycle, rate limiting, idempotency, correlation, audit).
- `docs/api/examples/client.ts` — zero-dependency runnable TS client.

**Changed (server):**

- `apps/server/src/api/server.ts` — calls `registerV1Routes`.
- All 7 legacy route modules — `base` parameter (default `/api`; v1 passes
  `/api/v1`); no behavior change.
- `apps/server/src/config.ts` — `NLO_API_AUTH`,
  `NLO_API_RATE_LIMIT_MAX`, `NLO_API_RATE_LIMIT_WINDOW_MS`; `EnvGetter`
  threading fix (§6.2).
- `apps/server/src/domain/jobs.repo.ts` — `idempotencyKey`/`tokenId`
  columns + `findByIdempotencyKey`.
- `apps/server/src/app-context.ts` — wires `ApiTokensRepo` into context.
- `packages/shared/src/types.ts` — job fields for idempotency.

**Docs/config:**

- `docs/api/README.md` — rewritten: contract locations, error codes, auth
  model (optional/enforced), scopes, token lifecycle, rate limiting,
  idempotency, correlation, audit, cURL + TS + Python examples.
- `docs/wiki/08-api-authentication.md`, `docs/wiki/09-api-guide.md` —
  updated to implemented state (stale "planned" + wrong error codes fixed).
- `.env.example`, root `README.md` (docs link, env table, API section,
  honest status table), `CHANGELOG.md`.

## 5. Quality gate results (final tree, before commit)

| Gate                               | Result                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm test` (all workspaces)        | **PASS** — shared 44/44, server 83/83 (59 legacy + 24 new), web 25/25 = **152/152**                              |
| `npm run typecheck` (3 workspaces) | **PASS**                                                                                                         |
| `npm run lint`                     | **PASS**                                                                                                         |
| `npm run format:check`             | **PASS** (after prettier on the 8 code files + 3 doc files)                                                      |
| `npm run build`                    | **PASS** (vite web build ~6–15s)                                                                                 |
| Secret scan of staged diff         | **PASS** — placeholders only (`nlo_admin_<64hex>`, `vless://<uuid>@<node-host>`); no runtime/secret files staged |
| s52                                | **untouched** — no deploy, no restart (local-only phase)                                                         |

Verification level (honest): **Unit/Integration/E2E (in-process, mock
provider) passed.** Live verification was NOT performed (manual gate;
real Google accounts + real egress — out of phase scope).

## 6. Errors encountered and fixed (full disclosure)

### 6.1 CRITICAL production bug: v1 request hook deadlock (caught by tests)

Symptom: 18 of 24 new tests timed out (5000ms) on every `/api/v1/*` route;
legacy `/api/*` was fine. Diagnosis: bisected to a zero-plugin minimal
Fastify app — a **synchronous 2-arg `onRequest` hook** (no `next` call, no
returned Promise) deadlocks the request chain forever, because Fastify 5.12.7
`hookRunnerGenerator` only advances when the hook result is thenable or
`next` is called (`node_modules/fastify/lib/hooks.js`). The v1 child
encapsulation registered exactly such hooks → **every `/api/v1` request would
hang on a live server**, not just in tests. Fix: make both hooks `async`
(they await nothing extra; the returned Promise is what advances the chain).
Verified: all v1 routes respond in 0–2 ms; full suite green.

### 6.2 Product bug: `loadConfig(overrides)` silently ignored int/bool vars

`intEnv`/`boolEnv` read `process.env` directly, so `NLO_API_AUTH` and
`NLO_API_RATE_LIMIT_MAX` overrides (used by the tests and by any programmatic
config injection) were silently bypassed — enforced-auth tests got 200
instead of 401, rate-limit tests got 200 instead of 429. Fix: threaded an
`EnvGetter` (override map → `process.env`) through both helpers and all
call sites. Verified by the previously-failing describes now passing.

### 6.3 Contract-test parser bug (test-side, not product)

First `liveRoutes()` parser assumed a flat `printRoutes()` tree; the real
format uses merged common-prefix nodes (`pro` + `xies`), `/` separator
nodes, and dir labels with embedded slashes. Rewrote as a
chain-concatenation parser; the bidirectional drift test then passes with
52 spec operations = 52 live v1 operations.

### 6.4 Minor

- 415 vs 401 in a defense-in-depth test (payload without `content-type` —
  Fastify content-parsing 415s after `onRequest`); test now sends JSON
  content-type.
- Vite "Duplicate key" warnings: `/openapi.json` + `/docs` had been listed
  twice in the spec (contract section + old bottom block); deduplicated.
- ESLint unused `token` in a test destructure; prettier on 8 code + 3 doc
  files.

## 7. Security review of the new surface

- Tokens: SHA-256 hash only stored; plaintext generated from 32-byte CSPRNG,
  returned exactly once; `resolve()` rejects unknown/revoked/disabled;
  plaintext never in logs (shared redaction module also covers accidental
  logging).
- Scope matrix: `admin` implies all; unknown `POST` → `admin`; token/audit
  routes always require a token (401 in optional mode too — defense in depth).
- Auth-exempt set is minimal and GET-only: `/health`, `/health/ready`,
  `/openapi.json`, `/docs`.
- Audit: append-only; anonymous traffic never audited; no token values in
  any column (verified by test scanning all payloads).
- Rate limiting is per-token (sliding window) and cannot be exhausted across
  tokens (verified: second token unaffected).
- Loopback trust model unchanged; legacy surface never gated; enforced mode
  is opt-in and documented as "deploy behind an auth-capable reverse proxy".

## 8. Compatibility / migration

- Legacy `/api/*`: zero behavior change; the 59 legacy tests run
  unmodified and pass. Web app still consumes `/api/*`.
- `/api/v1/*`: identical resource model; the only new response header is
  `x-correlation-id` and (on replay) `x-idempotent-replay`.
- Idempotency on `/api/v1/jobs` is inert without a token, so anonymous
  loopback callers see exactly the legacy semantics.

## 9. Test suite (new, 24 tests)

Describes in `apps/server/test/openapi-v1.test.ts`:

1. OpenAPI contract (C2) — doc at both URLs equals `buildOpenApiDocument`;
   Swagger HTML at both docs URLs; **bidirectional** spec↔live drift check
   (≥50 operations).
2. v1 mirrors the legacy surface (C3) — cross-surface visibility both ways;
   same 404 envelope.
3. Optional auth mode (default) — anonymous 200; token-attributed audited,
   anonymous not; token/audit routes anonymous → 401.
4. Enforced auth mode (`NLO_API_AUTH=true`) — anonymous 401 +
   `auth_required` row; exempt GETs 200; invalid bearer 401 +
   `auth_failed` (`invalid_or_revoked_token`); legacy untouched; scope 403 +
   `missing_scope:jobs:write`; admin implies all; disabled/revoked → 401.
5. Token lifecycle (C4) — create (201, `nlo_...` one-time plaintext,
   `tok_<24hex>` id) → list (no plaintext) → use → disable → 401 →
   re-enable → 200 → revoke → 401 + `token_revoked` row; body validation.
6. Per-token rate limiting (C4) — budget 3 → 429 `rate_limited` +
   `details.retryAfterSeconds` + audit row; other token unaffected.
7. Idempotent job creation (C5) — replay 200 + `x-idempotent-replay` (one
   job); different token same key → new job; malformed key → 400; legacy
   ignores the header.
8. Correlation IDs (C5) — echoed or `cr_<32hex>`; absent on legacy.
9. Audit trail (C4) — queryable, `tokenId` filter exact, actions include
   `request` + `auth_failed`, no token plaintext anywhere.

## 10. Documentation delivered

- `docs/api/README.md` (rewritten, ~230 lines) — the API consumer manual.
- `docs/api/examples/client.ts` — runnable, dependency-free TS client
  (health → idempotent create → poll → artifact download → audit when a
  token is set; optional real audio file via `NLO_AUDIO_FILE`).
- `docs/wiki/08-api-authentication.md` — implemented status (Persian).
- `docs/wiki/09-api-guide.md` — corrected error codes, dual-surface note,
  v1 section with idempotency/correlation.
- Root `README.md` — docs link, 3 new env vars, API section, honest
  status-table rows updated to `implemented + tested`.
- `CHANGELOG.md` — Phase C entry (Added / Fixed / Verified / Unchanged).
- `.env.example` — `NLO_API_AUTH`, `NLO_API_RATE_LIMIT_MAX`,
  `NLO_API_RATE_LIMIT_WINDOW_MS` documented.

## 11. Deployment impact

- Migration 0005 is additive (two new tables, no data migration) — safe on
  next deploy; `deploy/deploy.sh` backs up the DB before restart as usual.
- No changes to `Dockerfile`, `docker-compose.yml`, or `deploy/`.
- s52 NOT touched this phase (local commit only). First deploy of this code
  happens in Phase D territory, behind approval.

## 12. Known limitations (honest)

- Examples in `docs/api/` were validated against the verified in-process
  shapes (tests), not executed against live s52 — that is a Phase D check.
- No live (`NLO_LIVE_TESTS`) run this phase; live behavior of v1 routes
  under the python-worker provider is untested (mock provider E2E covers the
  full request path).
- No webhooks (Phase G), no correlation-ID propagation into job archives,
  no idempotency for non-job POSTs (jobs only, by design for C5).
- Swagger UI uses CDN assets; on air-gapped s52 the UI shell loads but
  swagger-ui assets may not (the JSON contract is unaffected).

## 13. Next phase input (Phase D — deployment packaging)

- Deploy this commit via `deploy/deploy.sh` (DB backup automatic), then
  verify on s52: service active, `/api/health` + `/api/health/ready`,
  regression `npm test`, smoke the new endpoints (`/api/openapi.json`,
  create token, idempotent job create, audit query) against the real
  service with `NLO_PROVIDER=python-worker`.
- Decide s52 default for `NLO_API_AUTH` (recommendation: keep `0` until
  Phase F external publishing; tokens already usable on loopback).
- Docker image: no changes needed, but a docker-build smoke should re-run
  since `spec.ts`/`v1.ts` are new server files.

## 14. Evidence index

- Gate runs (this session, final tree): `npm test` 152/152; typecheck,
  lint, format:check, build all PASS (commands + outputs in session log).
- `git diff --stat HEAD` at commit time: 18 modified + 8 new files,
  +583/−269 (tracked) plus new files (v1.ts ~293 lines, spec.ts ~834,
  openapi-v1.test.ts ~790, api-tokens.repo.ts ~251, job-create.ts ~226,
  tokens.ts ~120, migration, request-augment.ts, client.ts ~110).
- Phase A baseline: `docs/reports/PHASE_A_AUDIT.md` (API surface §7,
  service state §2).
- Phase B governance: `docs/reports/PHASE_B_ENGINEERING_GOVERNANCE.md`.

## 15. Approval request

Phase C is **complete**: C1–C6 implemented, 24 new tests + full regression
green (152/152), docs + changelog + env example updated, local commit
prepared/done, no push, no deploy. Two real product bugs (v1 hook deadlock —
critical; config overrides ignored) were found by the new tests and fixed.

**Awaiting approval to start Phase D (deployment packaging).**
