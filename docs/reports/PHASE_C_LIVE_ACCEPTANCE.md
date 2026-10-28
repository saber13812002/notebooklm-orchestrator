# Phase C — Live Acceptance (Report)

Date: 2026-10-28 (UTC)
Mission: **"Phase C Live Acceptance — Safe Release, Production Deployment and
API Verification"** (9 steps, then STOP for approval).

| Item                 | Value                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| GitHub commit (main) | `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9` (pushed: `4be0a20..b5e9ad3`, 3 Phase C commits)               |
| Deployed on s52      | `b5e9ad3` via `deploy/deploy.sh origin/main`, service `nlo`, port `4870` (loopback)                      |
| Deploy timestamp     | **2026-10-28T13:43Z** (backup `data/backups/20261028T134316Z-b5e9ad3`)                                   |
| Rollback target      | `80a9e667b283f440cf7e69de159b91251b28df15` (previous good; `ROLLBACK=1 bash deploy/deploy.sh 80a9e66`)   |
| Status               | **Complete — all 9 steps executed; local commit done; STOP for approval (no further push/deploy/work).** |

## 1. Verification levels (honest, as required by the mission)

| Level                                                                                                                 | Result                                     | Scope                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Unit/Integration/E2E (in-process, **mock** provider)                                                                  | **PASS 152/152** (local + re-run on s52)   | shared 44, server 83 (59 legacy + 24 Phase C), web 25                                                                              |
| CI (GitHub Actions)                                                                                                   | not re-run here                            | no push of this acceptance commit yet; Phase C commits (`35998c1`, `2e5a601`, `b5e9ad3`) already ran CI on push                    |
| **Production smoke** (s52, deployed `b5e9ad3`)                                                                        | **PASS**                                   | health/ready, OpenAPI/Swagger, legacy + v1 surfaces, Web UI, read-only + validation cURL examples, data integrity, single instance |
| **Deployed-code feature checks** (sandbox instance: deployed code, **mock** provider, `NLO_API_AUTH=true`, port 4871) | **PASS**                                   | enforced auth (401/403/429 + audit), scopes, revoked/disabled tokens, idempotency, correlation, TS + Python third-party clients    |
| **Live NotebookLM**                                                                                                   | **NOT PERFORMED**                          | no valid session: re-verify failed at the region/anti-abuse gate (§9.1). Mock results were never reported as live evidence         |
| Live manual gate scripts (`e2e-live.ts` / `verify-live.ts`)                                                           | **NOT RUN** (would have been the live job) | blocked by the same root cause; not bypassed, not faked                                                                            |

**Bottom line:** the deployed API product is verified end-to-end at
local/CI/production-smoke/deployed-code levels. The one live-NotebookLM audio
job the mission allows "if provider + valid session" was **not** performed
because the session could not be re-verified (environmental region gate,
§9.1). Everything not verified is labeled as such below.

## 2. Step 1 — Git state reconciliation

- Local `main` clean at `b5e9ad3` (Phase C complete, committed, unpushed).
- `origin/main` (GitHub) was at `4be0a20` (Phase B).
- s52 was serving `80a9e667b283f440cf7e69de159b91251b28df15` (previous good
  deployment, 2026-10-27), healthy.
- Pushed `4be0a20..b5e9ad3` to `origin/main`: `35998c1` (feat: /api/v1 +
  OpenAPI + tokens + idempotency), `2e5a601` (test: openapi-v1 suite),
  `b5e9ad3` (docs: Phase C report + consumer manual). No force-push, no
  history rewrite.

## 3. Step 2 — Pre-deployment safety

- Reviewed [`deploy/deploy.sh`](../../deploy/deploy.sh): git-based, pulls only
  commits reachable from `origin/main`, automatic DB + `.env` backup (5
  retained), preflight checks, post-restart health/ready/port/journal checks,
  regression `npm test` hook, `ROLLBACK=1` rollback support.
- Pre-deploy live state: `systemctl status nlo` active (single instance),
  `/api/health` + `/api/health/ready` 200, port 4870 bound loopback,
  3 jobs in DB (2 SUCCEEDED real, 1 FAILED unknown), 2 proxy nodes.
- Rollback target verified present: `80a9e667b283f440cf7e69de159b91251b28df15`
  (local + origin), with backup `data/backups/20261027T084302Z-80a9e66`.

## 4. Step 3 — Deployment

- Command (on s52): `bash deploy/deploy.sh origin/main`.
- Output: **`DEPLOY SUCCESS: b5e9ad3`** at 2026-10-28T13:43Z.
- Post-deploy: service active, single instance, port 4870, migration 0005
  (`api_tokens` + `api_audit_log`) applied additively at startup,
  `/api/health` 200, `/api/health/ready` 200.

## 5. Step 4 — OpenAPI/Swagger live verification (production)

| Check                               | Result                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/openapi.json`             | 200, valid JSON, **41 path items (52 operations)**                                                       |
| `GET /api/v1/openapi.json`          | 200, identical document                                                                                  |
| `GET /api/docs`, `GET /api/v1/docs` | 200 — Swagger UI HTML loads (CDN assets)                                                                 |
| Spec ↔ live route table             | agreement confirmed (bidirectional drift test in `openapi-v1.test.ts` + live probe of all v1 operations) |
| Hangs / timeouts                    | none (all probes responded < 1 s)                                                                        |
| Legacy surface                      | unchanged — all legacy routes 200, 3 jobs intact                                                         |

**F1 (cosmetic, pre-existing in Phase C code):** the legacy
`/api/openapi.json` copy declares `servers[0].url = "/api/v1"`
(`apps/server/src/api/openapi/spec.ts`), so a client using the _legacy_ URL as
the base would be misdirected. No functional impact (the spec is the same
document on both surfaces; the v1 URL is the intended base). Left unchanged —
no speculative product fix inside an acceptance phase.

## 6. Step 5 — API authentication verification

**Production policy (documented, not changed):** s52 keeps **default optional
mode** — `NLO_API_AUTH` is not set in production. Rationale: the service is
loopback-only single-user; the web app consumes the **legacy** `/api` surface
which is _never_ gated by design; global enforcement is a Phase F concern
(auth-capable reverse proxy + external publishing). Enforced mode remains
opt-in via `NLO_API_AUTH=true` and is fully documented in
[`docs/api/README.md`](../api/README.md) and `docs/wiki/08-api-authentication.md`.

Enforced-mode checks were executed on a **sandbox instance running the exact
deployed code** (`NLO_API_AUTH=true`, mock provider — the auth stack is
provider-agnostic):

| Check                                                                                  | Expected                                                 | Observed |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| Non-exempt v1 GET without token                                                        | 401 `unauthorized` + `auth_required` audit row           | ✅       |
| Invalid bearer token                                                                   | 401 + `auth_failed` audit row                            | ✅       |
| Valid token                                                                            | 200 + `request` audit row                                | ✅       |
| Revoked token                                                                          | 401                                                      | ✅       |
| Disabled token                                                                         | 401                                                      | ✅       |
| `jobs:read` token → `POST /jobs`                                                       | 403 `forbidden` (`missing_scope:jobs:write`) + audit     | ✅       |
| Rate limit exhausted (small budget)                                                    | 429 `rate_limited` + `details.retryAfterSeconds` + audit | ✅       |
| `GET /api/v1/audit` (admin)                                                            | 200; filterable; **no token plaintext in any field**     | ✅       |
| Token/audit routes, anonymous (even in optional mode)                                  | 401 (defense in depth)                                   | ✅       |
| Exempt GETs under enforced mode (`/health`, `/health/ready`, `/openapi.json`, `/docs`) | 200                                                      | ✅       |
| Legacy `/api/*` under enforced mode                                                    | untouched — never gated                                  | ✅       |

Token values were never printed in any output, log, or this report (only
`tok_…` ids and redacted references).

**F2 (bootstrap gap, pre-existing):** a fresh instance switched to enforced
mode has **no API mechanism for creating the first admin token** (token
creation itself requires an existing `admin` token). Bootstrapping requires
out-of-band DB/CLI seeding (that is how the sandbox token was created).
Documented as a limitation; suggested follow-up: a one-time bootstrap command
or an env-seeded initial token. Not fixed here (acceptance scope, no product
code changes).

## 7. Step 6 — Idempotency + correlation verification

Deployed-code checks (same sandbox, `NLO_API_AUTH=true`):

| Check                                     | Observed                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| First `POST /jobs` with `Idempotency-Key` | 201, job A created                                                                                 |
| Replay — same token + same key            | **200 + `x-idempotent-replay: true`**, same job id; job count unchanged (no duplicate job/archive) |
| Same key, **different** token             | new job (key is token-scoped)                                                                      |
| With vs. without key; no token            | legacy semantics — fresh job each time                                                             |
| Malformed key (too short / bad chars)     | 400 `validation_error`                                                                             |
| Supplied `x-correlation-id`               | echoed in response                                                                                 |
| Absent `x-correlation-id`                 | generated `cr_<32hex>`                                                                             |
| Legacy surface                            | header ignored, no correlation header (unchanged)                                                  |

All sandbox jobs were cleaned up on teardown; the production job count
remained 3 before and after (no data loss).

## 8. Step 7 — Third-party client examples + live attempt

### 8.1 Session re-verify (supported workflow)

- `POST /api/sessions/acc_5a03a60bbda24085/verify` against production
  (the supported re-verify path; session had expired the 10-minute
  `isUsable` TTL from its last verification).
- Result: **HTTP 500 `internal_error`**. `journalctl -u nlo` shows the
  Python worker was spawned and **both** egress nodes were attempted
  (`England_1`, `france1-SeyedSaber`); the provider raised `ValueError`:
  **region/anti-abuse gate — `location=unsupported`** (NotebookLM redirects
  the request to the `notebook.google` marketing page for this egress
  region/IP).
- Session state stayed `AUTHENTICATED` (no invalid transition), but
  `sessionUsable: false`.
- **F6 (pre-existing behavior, same root cause as F3):** a provider _throw_
  during verify surfaces as `500 internal_error` instead of a structured
  `{ ok: false }` result — the route only maps `status.ok === false` to
  `AUTH_REQUIRED`; a thrown `ValueError` propagates.

### 8.2 Live audio-to-text job — **NOT performed** (honest)

The mission allowed "ONE controlled live regression **if provider + valid
session**". That precondition was **not met**: the re-verify above failed at
the region gate, so no usable session existed. Consequences, deliberately:

- **No live job was executed and none is reported.**
- Mock results from the sandbox were **never** presented as live evidence.
- The manual live-gate scripts were **not run** (they would have hit the same
  gate; running them only to fail adds cost, no signal).
- The last live-verified NotebookLM run remains **P2 (2026-10-26)** — see
  `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md`.
- Root-cause classification: **environmental** (egress IP/region reputation
  as seen by Google), not a product defect — tunnel, worker spawn, request
  path, and fail-closed behavior all worked as designed.

### 8.3 cURL examples — production (read-only + validation only)

Executed on s52 loopback against the deployed service; **no production data
was mutated** (validation-failure POSTs are rejected before any job/archive
is created):

| Example                                                                    | Result                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/health`, `GET /api/health/ready`                                 | 200                                                                  |
| `GET /api/jobs`                                                            | 3 jobs (2 SUCCEEDED real, 1 FAILED unknown) — identical before/after |
| `GET /api/jobs/:id` (+ `/events`, `/artifacts`, `/audio`)                  | 200                                                                  |
| `POST /api/jobs` with `audio=*.txt`                                        | 400 `validation_error` — "unsupported audio extension: .txt"         |
| `POST /api/jobs` without `prompt`                                          | 400 `validation_error` — "prompt is required"                        |
| `GET /api/jobs/j_unknown`                                                  | 404 `not_found`                                                      |
| `GET /api/v1/jobs`, `GET /api/v1/health` (default optional mode, no token) | 200                                                                  |
| Job count after all probes                                                 | **3 — unchanged (no data loss)**                                     |

**F4 (pre-existing):** `POST /api/jobs` with **no** `content-type` → 406
followed by `internal_error` (multipart parser expectation); documented, not
fixed in this phase.

### 8.4 TypeScript client — [`docs/api/examples/client.ts`](../api/examples/client.ts)

Executed against the sandbox (deployed code, mock provider,
`NLO_API_AUTH=true`), using a real production wav
(`j_6568c109d989bc430be9453f7e9008f9/input/audio-nlo-e2e-audio.wav`,
641,980 B):

- No token → **401** (enforced mode) — client error path exercised.
- `GET /api/v1/provider` → honest mock capability matrix.
- Job **`j_cc206c6433f274a9d79a188259c6b2f1`**: `CREATED → SUCCEEDED`,
  `resultProvenance: mock` (explicitly labeled; **not** live).
- Artifact `mock-sample-2cd2f1bd.txt` (127 B) listed + downloaded; its
  content explicitly states it is **not** a real NotebookLM output.
- `GET /api/v1/audit` → 7 events for the run; no token plaintext.

### 8.5 Python client — compact pattern from [`docs/api/README.md`](../api/README.md)

Executed against the same sandbox (system `python3` + `requests` 2.31.0;
production venv untouched):

- C1 — `.txt` upload → 400 `validation_error`.
- C2 — real wav → **201 `j_1534fa27ae629bc401ba98d7c17212bb`** →
  `SUCCEEDED` (mock) → artifact 127 B downloaded.
- C3 — supplied correlation id `py-corr-1` **echoed**; idempotent replay →
  **200, same job id, `x-idempotent-replay: true`**.

### 8.6 Teardown & production integrity

Sandbox instance stopped via port-based cleanup (4871 freed), temp data dir
`/tmp/nlo-s7` removed. Production afterwards: service active, port 4870,
job count 3, no new artifacts — **untouched**.

## 9. Step 8 — Full regression on the deployed version

| Check                              | Result                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed commit on s52             | `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9` (repo + running service)                                                                             |
| Process tree                       | **single instance**: MainPID 3812771 (`tsx`) → 3812839 (`main.ts`, the only 4870 listener) → esbuild + xray children; **no idle Python worker** |
| `/api/health`, `/api/health/ready` | 200                                                                                                                                             |
| Web UI                             | index 490 B, hashed asset 487,823 B, SPA fallback 200                                                                                           |
| Legacy resources                   | accounts 1, jobs 3 (unchanged), proxies 2 nodes, provider `python-worker`, settings, secrets (redacted), sessions — all 200                     |
| v1 surface                         | health/jobs/openapi/docs 200 (41 path items)                                                                                                    |
| `npm test` (on s52)                | exit 0 — **152/152** (shared 44 + server 83 + web 25)                                                                                           |
| Data integrity                     | no job loss/duplication; archives intact; backups present in `data/backups/`                                                                    |
| Rollback readiness                 | `80a9e667b283f440cf7e69de159b91251b28df15` present; pre-deploy backup `20261027T084302Z-80a9e66` + post-deploy `20261028T134316Z-b5e9ad3`       |
| Journal since deploy               | only the **expected** 14:12:10Z region-gate 500 from the §8.1 verify probe                                                                      |

Note (observed, not acted on): three untracked files exist on s52 outside git
control — `apps/server/src/proxy/connect-proxy.ts.bak-curlfix` and
`apps/server/src/queue/job-runner.ts.bak-e2efix` (both 2026-10-26,
pre-existing) and a 0-byte `nul` (2026-10-28 13:41, stray redirect artifact).
They are not part of the deployed tree and were left in place (cleaning
operational host files is out of acceptance scope).

## 10. Findings register (F1–F7)

| #   | Severity                          | Description                                                                                                                                   | Status                                                                    |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| F1  | cosmetic                          | Legacy `/api/openapi.json` copy declares `servers[0].url = "/api/v1"` (spec.ts)                                                               | documented; not fixed (no speculative product change in acceptance phase) |
| F2  | gap                               | No first-admin-token bootstrap: enforced mode + zero tokens ⇒ token routes unreachable by design; requires out-of-band seeding                | documented; follow-up suggested (§12)                                     |
| F3  | pre-existing                      | `POST /api/health/account` → 500 `internal_error` when the provider throws at the region gate                                                 | documented; root cause = F7                                               |
| F4  | pre-existing                      | `POST /api/jobs` with no `content-type` → 406 + `internal_error`                                                                              | documented                                                                |
| F5  | by design                         | `GET /api/audit` + token routes are v1-only (`/api/audit` → 404) — legacy never gained them                                                   | documented in `docs/api/README.md`                                        |
| F6  | pre-existing                      | Session re-verify surfaces provider _throws_ as 500 instead of structured `{ok:false}` (same class as F3)                                     | documented                                                                |
| F7  | **environmental (blocking live)** | NotebookLM region/anti-abuse gate (`location=unsupported`) for s52 egress via **both** proxy nodes — blocks live session verify and live jobs | documented; needs different egress node / Google-side resolution          |

## 11. Remaining limitations (honest)

1. **Live-NotebookLM not re-verified in this acceptance** — last live
   verification remains P2 (2026-10-26). F7 blocks any live run until egress
   region/IP is acceptable to Google (a different egress node, or resolution
   on the Google side, is required; product code is not at fault — the tunnel
   and fail-closed paths behaved correctly).
2. **F2 bootstrap gap** — first-admin-token creation requires out-of-band
   seeding; recommend a one-time bootstrap command (or env-seeded token)
   before enforced mode is ever used in production (Phase F).
3. **F1** cosmetic spec `servers` mismatch on the legacy URL.
4. **F3/F6** provider exceptions surface as `500 internal_error` instead of
   structured results (pre-existing error-handling polish).
5. **F4** missing-`content-type` on job create → 406/`internal_error`.
6. `NLO_API_AUTH` is **not enforced in production** (loopback single-user
   model; enforcement is a Phase F task behind an auth-capable reverse proxy).
7. Swagger UI loads its assets from a CDN; on an air-gapped s52 the shell
   loads but swagger-ui assets may not (the JSON contract is unaffected).
8. Out of scope per mission (not started): webhooks (Phase G), Google Drive /
   DOCX / Studio outputs, Docker packaging re-smoke, external publishing (F),
   correlation-ID propagation into job archives, idempotency for non-job POSTs.

## 12. Files changed in this acceptance (docs only — no product code)

- **New:** `docs/reports/PHASE_C_LIVE_ACCEPTANCE.md` (this report).
- **Updated:** `docs/reports/PHASE_C_API_PRODUCTIZATION.md` (C6 row +
  limitations + addendum pointer), `docs/api/README.md` (status + verification
  level), root `README.md` (status table + report link), `CHANGELOG.md`
  (live-acceptance entry).

## 13. Evidence index

- Git: local `main` = `origin/main` = s52 deployed tree =
  `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9`; push range `4be0a20..b5e9ad3`
  (`35998c1`, `2e5a601`, `b5e9ad3`).
- s52: `/home/saber/saberprojects/notebooklm-orchestrator` @ `b5e9ad3`;
  `systemctl status nlo` active (MainPID 3812771 → 3812839 listener 4870);
  `journalctl -u nlo` (region-gate 500 at 14:12:10Z is the only post-deploy
  error).
- Backups: `data/backups/20261027T084302Z-80a9e66` (pre),
  `data/backups/20261028T134316Z-b5e9ad3` (post-deploy).
- Tests: `npm test` on s52 — exit 0, 152/152 (shared 44, server 83, web 25).
- Sandbox jobs (mock provenance, temp DB, cleaned up):
  `j_cc206c6433f274a9d79a188259c6b2f1` (TS client),
  `j_1534fa27ae629bc401ba98d7c17212bb` (Python client).
- Production real job referenced for the client audio:
  `j_6568c109d989bc430be9453f7e9008f9` (SUCCEEDED, `resultProvenance: real`).
- Verification scripts kept locally in `C:\tmp\` (`nlo-step7.sh`,
  `nlo-step7c.sh`, `nlo-step8.sh`, `nlo-step8b.sh`) — session artifacts, not
  committed.
- Phase context: `docs/reports/PHASE_C_API_PRODUCTIZATION.md`,
  `docs/reports/PHASE_B_ENGINEERING_GOVERNANCE.md`,
  `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md` (last live evidence).

## 14. Approval request

All 9 mission steps were executed with evidence; the service is running the
accepted commit with rollback ready. **Stopped for approval.** Per the
mission: **no** Google Drive / DOCX / Docker / new-feature work started; the
acceptance-commit push to GitHub and any further deployment are **not**
performed until explicitly approved.

Suggested next decisions (for the user, not acted on):

1. Approve push of this docs/report commit to `origin/main`.
2. Decide on F7 (live egress region gate): provide/authorize a different
   egress node or accept the P2 live-verification as the current live baseline.
3. Schedule F2 (bootstrap token) and F1/F3/F4/F6 (error-handling polish) as
   Phase D/F items.
