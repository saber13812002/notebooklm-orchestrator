# Phase E — Server Endpoint Migration: Integration Tests

**Date:** 2026-11-01 (UTC) · **Addendum phase:** E · **Approval:** user-approved
scope = push of Phase D commit `30b03cd` to `origin/main`, then Phase E
(integration tests), stop before Phase F.

---

## 1. Executive summary

Added a minimal internal-LLM client
([`apps/server/src/internal-llm.ts`](../../apps/server/src/internal-llm.ts))
plus an in-process integration test suite
([`apps/server/test/internal-llm.test.ts`](../../apps/server/test/internal-llm.test.ts))
that proves, at **Unit/Integration level (mock HTTP, not live)**:

1. **No requests to the old IP** — the client has no hardcoded host at all;
   the base URL comes exclusively from `config.internalApiBaseUrl`
   (`NLO_INTERNAL_API_BASE_URL`). A dedicated test asserts the default base
   is the new host `172.30.0.133:4000` and that the constructed URL contains
   no reference to the legacy `172.20.1.52` (string-level, no network).
2. **New endpoint used** — `GET /v1/models` hits the configured base with a
   correct `Authorization: Bearer <key>` header and returns the parsed body.
3. **Clean errors when down** — connection refused → `llm_unreachable` with a
   message containing only the target host (no stack, no "at ", no key);
   accept-but-never-respond → `llm_timeout` via AbortController.
4. **Secret redaction** — the exact LiteLLM 401 envelope
   (`"No api key passed in"`) is surfaced with status 401 and upstream
   message, but **never** the key, never the `authorization`/`bearer`
   header text; non-`/v1` paths (incl. traversal) are rejected before any
   network call.

Full regression green: **175/175** (shared 44 + server 106 + web 25);
typecheck, lint (phase files), format, and build clean. Committed locally;
**Phase E push NOT performed** (not approved). Live `/v1/models` against the
real proxy remains a manual gate pending an LLM API key via secret store
(carried to Phase F/G).

## 2. Initial state

- Local `main` == `origin/main` @ `30b03cd` (Phase D commit); after the
  approved push, `git rev-list --left-right --count origin/main...HEAD` →
  `0 0`. Tracked tree clean (untracked scratch: `$out`, `HTTP`, `tmp/` —
  left alone).
- Dev server 4871 running (PID 27528, log `tmp/dev4871-repro.log`); stale
  4870 (PID 8380) untouched.
- Baseline before Phase E: 169/169 tests; lint had 6 pre-existing `no-empty`
  errors in untracked `tmp/n1-auth-probe.mjs` only (out of scope, as in
  Phase C/D).

## 3. Implementation (goal + scope: endpoint-safe client + integration tests)

| File                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/internal-llm.ts`](../../apps/server/src/internal-llm.ts)             | **NEW.** `createInternalLlmClient(config: AppConfig)` → `{ request<T>(opts), listModels(apiKey?) }`. Result union `LlmResult<T> = { ok: true; status; data } \| { ok: false; code: "llm_unreachable" \| "llm_error" \| "llm_timeout"; message; status? }`. Path whitelist `/^\/v1(?:\/[A-Za-z0-9._~-]+)+$/` + explicit `..` rejection → invalid path returns a clean error **before any network call**. URL built via `new URL(path, config.internalApiBaseUrl)`; `fetch` + `AbortController` (default 15000 ms, per-request `timeoutMs`); `Authorization: Bearer` only when `apiKey` provided; JSON body for `POST`. Error messages are composed of **only** `url.host`, HTTP status, and the upstream `error.message` (OpenAI-style envelope) — never the key, never a stack, never raw error objects.                                                                                                                                                                                 |
| [`apps/server/test/internal-llm.test.ts`](../../apps/server/test/internal-llm.test.ts) | **NEW.** 6 tests on in-process `node:http` servers bound to `127.0.0.1` ephemeral ports; config via `loadConfig({ NLO_INTERNAL_API_BASE_URL: base })` overrides (ambient-env safe, save/restore of `NLO_INTERNAL_API_BASE_URL`). (1) default base = `http://172.30.0.133:4000`, no `172.20.1.52` anywhere, constructed URL host correct (no network); (2) `listModels("sk-test-abc123")` → mock sees `Bearer sk-test-abc123` + `/v1/models`, returns parsed model list; (3) bind→close→reused port → `llm_unreachable`, message contains host, no `at ` / `Error:` / stack / key; (4) exact LiteLLM 401 envelope → `llm_error`, status 401, message contains `No api key passed in`, does **not** contain the key or `authorization`/`bearer`; (5) silent server + `timeoutMs: 200` → `llm_timeout` ("did not respond within 200ms"), elapsed < 5 s; (6) paths `/openapi.json`, `/health`, `/v1`, `v1/models`, `/v1/../../etc/passwd` all rejected pre-network (mock hit-count stays 0). |
| [`CHANGELOG.md`](../../CHANGELOG.md)                                                   | New `[2026-11-01] — Phase E` entry (Added / Tests / Unchanged / Notes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`docs/ROADMAP_MASTER.md`](../ROADMAP_MASTER.md)                                       | Addendum table: E → ✅ done (in-process mock HTTP, not live; live `/v1/models` pending LLM key).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Deliberately NOT changed

- **No route, API surface, provider, DB, or deployment change** — the client
  is a standalone module not yet wired into any route (wiring is future
  prompt-engine work; per API-first rules, capabilities join via the API when
  they exist).
- No network traffic to any real endpoint from CI (all mock, 127.0.0.1).
- All class ②/③ doc references (unchanged since Phase D).

## 4. Git

- Branch: `main`. Phase D push (approved): `3f796a6..30b03cd main -> main`,
  verified in sync after fetch.
- Phase E commit: **local only** (1 new code module + 1 new test file +
  CHANGELOG + ROADMAP_MASTER + this report). **Push NOT approved — not done.**

## 5. Tests (level: **Unit/Integration — in-process mock HTTP, NOT live**)

| Suite                  | Result                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/server` (vitest) | **106/106 passed**, incl. new `internal-llm.test.ts` (6/6) and `config-internal-api.test.ts` (5/5) |
| `packages/shared`      | 44/44 passed                                                                                       |
| `apps/web`             | 25/25 passed                                                                                       |
| **Total**              | **175/175** (baseline 169 + 6 new)                                                                 |
| typecheck              | clean (all workspaces)                                                                             |
| lint (phase files)     | clean (remaining 6 errors are pre-existing, untracked `tmp/n1-auth-probe.mjs`)                     |
| format (prettier)      | phase files formatted (`--write` applied)                                                          |
| build                  | clean (vite, 6.85 s)                                                                               |

Mock tests do **not** prove real NotebookLM/LiteLLM execution (honesty rule).

## 6. Live verification

**Not performed in this phase** (by design — Phase E is the offline test
phase). Live `GET /v1/models` against `http://172.30.0.133:4000` requires an
LLM API key via secret store (never in repo/env files in git); it will run as
a manual gate in Phase F (local 4871 verification) or Phase G, with the key
supplied out-of-band.

## 7. Security

- Bearer key sent only when provided; never logged; never appears in error
  messages (asserted by tests 3 and 4 with a distinct key string).
- Error surface: only `host` + status + upstream `error.message`; no raw
  `Error` objects, no stacks (asserted).
- Path whitelist prevents non-`/v1` surface and traversal (`..` rejected
  explicitly in addition to the regex).
- No secrets added to any tracked file; `.env.example` unchanged (Phase C).
- Tests bind only to 127.0.0.1 ephemeral ports; no external egress.

## 8. Deployment

- No deployment impact: new module + tests only; `Dockerfile`,
  `docker-compose.yml`, `deploy/deploy.sh`, `nlo.service` unchanged. The
  running 4871 dev server is unaffected (module is not imported by
  `main.ts` yet).

## 9. Data safety

- No DB, vault, session, or runtime-data changes. Tests create no files
  outside their in-memory servers; `loadConfig` overrides are passed
  in-process (no `.env` mutation beyond save/restore of one variable).

## 10. Evidence & limitations

**Evidence:** test output 175/175 (vitest, 2026-11-01); typecheck/lint/
format/build transcripts; Phase D push receipt `3f796a6..30b03cd`.

**Limitations:**

1. Mock-level only — no real request to `172.30.0.133:4000` was made (that
   is Phase F/G, manual gate, key required).
2. The client is not yet wired into any API route (out of Phase E scope;
   the addendum asked for tests, not features).
3. 429/5xx bodies are handled by the same generic path as 4xx
   (message = status + optional upstream `error.message`); no per-code
   mapping needed at this stage.
4. Pre-existing lint noise in untracked `tmp/n1-auth-probe.mjs` (6 ×
   `no-empty`) remains — recommended hygiene commit (carried since Phase C).

## 11. Blockers / required accesses (carried to F/G)

- **LLM API key** (for the real `/v1/models` live check) — via secret store
  or out-of-band, never in git.
- Phase G still requires: new-host deploy specifics (systemd paths/user),
  domain vhost/TLS, and live egress re-verification.

## 12. Rollback

- `git revert <Phase E commit>` (or reset to `30b03cd` before push) restores
  the prior state exactly — the change is purely additive (2 new files + 2
  doc edits) with zero runtime wiring.

## 13. Next phase proposal (Phase F — local verification on 4871)

1. Restart/verify the local 4871 dev server against the Phase E tree
   (already running on the Phase D tree; restart to pick up nothing new at
   runtime, but re-run `/api/health` + `/api/health/ready`).
2. Run the regression suite once more in the final state.
3. Manual live gate (if a key is supplied): `GET /v1/models` on the real
   proxy via the client, result recorded in the Phase F report.
4. Report + stop for approval before Phase G (production migration — hard
   gate).

## 14. Approval request

Requesting approval for: **(a)** push of the Phase E commit to
`origin/main`, and **(b)** start of Phase F (local verification on 4871),
then stop before Phase G.
