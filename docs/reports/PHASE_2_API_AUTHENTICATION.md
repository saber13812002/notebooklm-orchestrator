# Phase 2 — API Authentication (first-admin bootstrap)

**Date:** 2026-10-29 · **Status:** COMPLETE — awaiting approval for Phase 3
**Repo:** `saber13812002/notebooklm-orchestrator` · **Branch:** `main`
**Commit:** `cfd96e6` (pushed to `origin/main`, fast-forward from `8938bcc`)

## 1. Goal & scope

Close the **F2 gap** from the Phase C findings register: the token
chicken-and-egg. Token creation (`POST /api/v1/tokens`) requires an `admin`
token, so the **first** token could not be created through the API — leaving
no safe, network-reachable way to mint it. This phase:

1. Pushed the Phase 1 report commit `8938bcc` to `origin/main`.
2. Designed and implemented a **secure first-admin bootstrap** with
   **no unauthenticated public administrative endpoint**.
3. Implemented the smallest safe change with unit, integration, and
   API-level tests.
4. Verified token creation, authentication, scopes, revocation, rate
   limiting, and secret-free logs.
5. Updated README, API docs, wiki, `SECURITY.md`, `.env.example`, changelog.
6. Ran the full verification gate; committed and pushed Phase 2 changes only,
   after a full diff review and a secret scan.
7. **Did NOT** deploy to s52, restart Production, or enable mandatory
   Production authentication (explicitly out of scope; procedure in §10).

## 2. Verification levels (honest, as required)

- **Unit / Integration / API-level: PASSED** (in-process app, mock provider).
- **Live / production: NOT verified** — no deploy, no restart, no production
  auth activation in this phase (by instruction).
- Rate limiting and scope enforcement were **already** covered by the Phase C
  `openapi-v1.test.ts` suite (enforced-mode describes); they were re-run as
  part of the full regression, not re-implemented.

## 3. Step 1 — Publish Phase 1 commit

- Working tree verified clean of staged content; ancestry verified
  (`8938bcc` is the local `main` tip; `origin/main` behind).
- Pushed `8938bcc` to `origin/main` (fast-forward, no force).
- No unrelated or untracked files included.

## 4. Step 2 — Untracked files: preserved & sensitivity report

`$out`, `HTTP`, and `tmp/` were **inspected but never modified or staged**,
and remain untracked in the working tree:

| File   | Contents (summary)                                         | Sensitive?                               |
| ------ | ---------------------------------------------------------- | ---------------------------------------- |
| `$out` | s52 `systemctl status` text (service state, paths)         | No secrets                               |
| `HTTP` | Empty file (0 bytes)                                       | No                                       |
| `tmp/` | Scratch probe/audit scripts (SSH probe snippets, scanners) | No secrets; no VLESS UUIDs, no passwords |

## 5. Step 3 — Audit of the existing token implementation

Audited before implementing (no code changed until design was set):

- **Storage:** `api_tokens` (migration `0005_api_tokens.sql`): only a
  SHA-256 hash is persisted; `name TEXT NOT NULL UNIQUE` across **all** rows
  (including revoked — this later proved significant, §7).
- **Creation:** `ApiTokensRepo.create()` → `nlo_<slug>_<64hex>` from 32-byte
  CSPRNG; plaintext returned exactly once.
- **Resolution:** `resolve(plaintext)` → null if unknown/disabled/revoked;
  30 s `last_used_at` throttle.
- **Middleware:** `apps/server/src/api/v1.ts` — `NLO_API_AUTH` →
  optional (default, loopback trust preserved) vs enforced (401 +
  `auth_required` / `auth_failed` audit). Exempt GETs: health / ready /
  openapi / docs. Token management routes always `admin`-gated (defense in
  depth). Legacy `/api/*` never gated.
- **Scopes:** 6 scopes; `admin` implies all; per-route requirement map.
- **Revocation:** `DELETE /api/v1/tokens/:id` → enabled=0 + `revoked_at` +
  `token_revoked` audit.
- **Rate limiting:** per-token sliding window (120/60 s default) → 429 +
  `retryAfterSeconds` + audit.
- **Audit:** append-only `api_audit_log`, queryable via `GET /api/v1/audit`
  (admin), token values never stored (proven by test).

## 6. Step 4 — Bootstrap design (secure, no public admin endpoint)

**Decision: offline, host-only CLI — deliberately NO network endpoint.**

Rejected alternatives:

- **Unauthenticated bootstrap endpoint** (even one-time / token-less):
  violates the "no unauthenticated public administrative endpoint"
  constraint; a network-reachable first-token minter is a standing risk.
- **Auth-required endpoint**: impossible (chicken-and-egg).
- **Config-file token injection**: weaker attribution (no audit row tied to
  the minting event) and an extra secret-handling path.

Chosen design — `bootstrapFirstAdmin(db, {name?, scopes?})` in
[`apps/server/src/domain/first-admin.ts`](../../apps/server/src/domain/first-admin.ts)

- CLI [`apps/server/scripts/bootstrap-first-admin.ts`](../../apps/server/scripts/bootstrap-first-admin.ts):

* **Offline, CLI-only:** opens the data-directory SQLite DB directly on the
  host (service stopped); no HTTP involved at all.
* **One-shot gate:** refuses (`FirstAdminAlreadyBootstrappedError`, exit 1)
  while ANY active (enabled, not-revoked) token exists. After the first
  mint, token lifecycle is exclusively the admin-scoped API.
* **Recovery (documented):** revoke all active tokens via the API, then
  re-run the CLI. Name collision with an _inactive_ row is auto-suffixed
  (`first-admin` → `first-admin-2` → …) so the procedure works as-is
  (bug found by tests, §7).
* **Secret hygiene:** plaintext shown exactly once to the operator; only the
  SHA-256 hash is stored; the token never appears in logs, audit rows, or
  API responses.
* **Attributable:** audit row `first_admin_bootstrapped`
  (`method: CLI`, `path: local://bootstrap-first-admin`, `status: 200`,
  `detail: <token id>`, `ip: null`).

## 7. Step 5 — Implementation (smallest safe change)

**New files**

- `apps/server/src/domain/first-admin.ts` — `bootstrapFirstAdmin` +
  `FirstAdminAlreadyBootstrappedError` (~80 lines, pure domain, reuses
  `ApiTokensRepo`).
- `apps/server/scripts/bootstrap-first-admin.ts` — CLI
  (`--name <value>` optional; prints token id/name/scopes + one-time
  plaintext + next steps; refuses with a clear message, exit 1).
- `apps/server/test/first-admin.test.ts` — 12 tests.

**Modified**

- `apps/server/package.json` — `"bootstrap:admin": "tsx scripts/bootstrap-first-admin.ts"`.
- Docs: `README.md`, `docs/api/README.md` (new "First token (bootstrap)"
  section), `docs/wiki/08-api-authentication.md`, `SECURITY.md` (§1 —
  replaced the stale "no user system **and no API token**" statement),
  `.env.example`, `CHANGELOG.md`.

**No changes** to: `v1.ts`, `api-tokens.repo.ts`, migrations, auth
middleware, rate limiter, any route. (Smallest-diff property: the bootstrap
is additive and reuses the existing, tested token machinery.)

## 8. Step 6 — Test evidence

### Targeted suite — `test/first-admin.test.ts` → **12/12 passed**

Unit (fresh temp DB per test):

1. Fresh-DB mint: name `first-admin`, full scope set,
   `nlo_first-admin_<64hex>` format, resolves by plaintext.
2. **Hash-only storage:** DB row's `token_hash == sha256(plaintext)`; scan of
   every string column in `api_tokens` + `api_audit_log` finds **no**
   plaintext.
3. **One-shot:** second bootstrap throws; token list unchanged.
4. Refused when an active token was created via the normal API path.
5. **Recovery:** revoke-all then re-bootstrap succeeds (name kept — no
   collision in that scenario); new plaintext resolves.
6. **Auto-suffix** when the base name is held by a revoked row
   (`first-admin` → `first-admin-2`).
7. Suffix increments past multiple taken inactive names
   (`ops-admin` + `ops-admin-2` → `ops-admin-3`).
8. Custom name + scope subset honored.
9. **Attributable, secret-free audit:** exactly one row,
   `first_admin_bootstrapped` / `CLI` / `local://bootstrap-first-admin` /
   200 / detail = token id / ip null; serialized audit contains no plaintext.

Integration / API-level (`NLO_API_AUTH=true`, in-process app):

10. **Chicken-and-egg proven:** with no token, anonymous
    `GET /api/v1/jobs` → 401 and anonymous `POST /api/v1/tokens` → 401
    (nothing network-reachable can mint the first token).
11. **Bootstrap unblocks enforced auth:** mint → bearer `GET /api/v1/jobs`
    200; admin lists tokens 200; admin creates a `jobs:read` child token via
    API (201) which then works; legacy `GET /api/health` stays 200.
12. **Revocation cycle:** revoke the bootstrap token → old bearer 401 →
    re-bootstrap (auto-suffixed) → new bearer 200.

### Full gate (re-run on the final tree, 2026-10-29)

| Gate                                      | Result                                        |
| ----------------------------------------- | --------------------------------------------- |
| `npx vitest run test/first-admin.test.ts` | 12/12 passed                                  |
| `npm test` (all workspaces)               | 164/164 passed (shared 44, server 95, web 25) |
| `npm run typecheck`                       | clean (3 workspaces)                          |
| `npm run lint`                            | clean                                         |
| `npm run format:check`                    | clean                                         |
| `npm run build`                           | ✓ built in 6.18 s (web)                       |

### CLI smoke test (throwaway data dir, never committed)

- Run 1 (`NLO_DATA_DIR=<temp>`): "first-admin bootstrap OK", token id
  `tok_b7465b1b4ff3481c9c99ad17`, name `first-admin`, all 6 scopes,
  plaintext printed once, **exit 0**.
- Run 2 (same dir): refusal message, **exit 1**.
- The throwaway data dir was **deleted** after the smoke; the smoke token
  exists only in this terminal session's output and is treated as
  throwaway (it can never be read back and the dir is gone).

### Secret scan of the staged diff

Same 13-pattern scan as Phase 1 (token hashes, `tok_` hex, VLESS, long hex,
passwords, bearer, cookies, private keys, internal IPs/hosts, vault key):
**all clean**, with one _expected_ informational hit — the already-public
target domain `nlo.ai.ismc.ir` on an existing README context line (feature
status table, unchanged content).

## 9. Step 9 — Commit & push

- Full diff of all 10 files reviewed; no secrets, no unrelated content.
- Staged explicitly (10 files only); `$out`, `HTTP`, `tmp/` left untracked
  and untouched.
- Commit **`cfd96e6`** — "Phase 2: first-admin bootstrap for API
  authentication (offline CLI, one-shot, tested)" — pushed
  fast-forward: `8938bcc..cfd96e6  main -> main` (no force).

## 10. Recommended Production activation procedure (NOT executed)

Per instruction, production auth was **not** activated. When approved, the
procedure is:

1. Deploy `cfd96e6` to s52 via the documented git-based path:
   `deploy/deploy.sh origin/main` (backs up DB + `.env`; prints
   rollback SHA).
2. Verify the deployed service: `systemctl status nlo`,
   `GET /api/health`, `GET /api/health/ready` (loopback / tunnel).
3. Stop the service: `systemctl stop nlo`.
4. On s52, with the service stopped, run:
   `NLO_DATA_DIR=/home/saber/saberprojects/notebooklm-orchestrator/data npm run bootstrap:admin --workspace @nlo/server`
   — capture the one-time plaintext.
5. Store the token securely on s52 (e.g. `0600` file or the existing vault
   convention); **never** in git, env examples, or logs.
6. Set `NLO_API_AUTH=1` in the service environment, restart, re-verify
   health/ready. Confirm: anonymous v1 non-exempt → 401; token-bearer
   traffic → 200; legacy `/api/*` unchanged; `GET /api/v1/audit` shows
   `first_admin_bootstrapped`.
7. Distribute the token to the intended API consumers only.

**Rollback:** `NLO_API_AUTH=0` + restart (immediate, no data loss).
**Token rotation (later):** create a replacement via the admin API, then
`DELETE /api/v1/tokens/<id>` for the bootstrap token.

## 11. Remaining limitations (honest)

- **No production change made:** s52 still runs `b5e9ad3` (the Phase C
  acceptance deployment, which includes the `/api/v1` + token-auth code but
  **not** this phase's bootstrap) with auth in its default (optional) mode.
  The commits ahead of it (`d02bcbc`, `8938bcc`, `cfd96e6`) are docs + this
  phase's additive bootstrap; deploying `cfd96e6` changes no running
  behavior until the activation procedure (§10) is executed.
- **No live verification** of the bootstrap CLI against the s52 data dir
  (deliberately — that is the activation step, §10).
- The **local** dev instance on port 4870 (if running) predates Phase C
  code; it is not part of this verification.
- The bootstrap assumes the **service is stopped** while it runs (documented
  in the CLI header and §10 step 3) — SQLite WAL tolerates concurrent
  readers, but a single-writer discipline keeps it simple and safe.
- Bootstrap token is a **long-lived** admin token by design (it is the root
  of trust); rotation path is documented but not automated.

## 12. Files changed in this phase (commit `cfd96e6`)

| File                                           | Change                                           |
| ---------------------------------------------- | ------------------------------------------------ |
| `apps/server/src/domain/first-admin.ts`        | new — bootstrap domain logic                     |
| `apps/server/scripts/bootstrap-first-admin.ts` | new — offline CLI                                |
| `apps/server/test/first-admin.test.ts`         | new — 12 tests                                   |
| `apps/server/package.json`                     | + `bootstrap:admin` script                       |
| `README.md`                                    | API section bullet + feature-status row          |
| `docs/api/README.md`                           | new "First token (bootstrap)" section            |
| `docs/wiki/08-api-authentication.md`           | new Persian bootstrap section                    |
| `SECURITY.md`                                  | §1 trust-model update (stale statement replaced) |
| `.env.example`                                 | bootstrap + enforcement guidance                 |
| `CHANGELOG.md`                                 | `[2026-10-29] — Phase 2` entry                   |

## 13. Evidence index

- Commit: `cfd96e6` on `origin/main` (fast-forward from `8938bcc`).
- Tests: 12/12 targeted; 164/164 full regression; typecheck/lint/format/build
  clean (all re-run 2026-10-29 on the final tree).
- CLI smoke: exit 0 (mint) / exit 1 (refusal), throwaway data dir deleted.
- Secret scan over staged diff: clean (one expected domain hit, pre-existing
  public context line).
- Preserved untracked: `$out`, `HTTP`, `tmp/` (no secrets; §4).

## 14. Approval request

Phase 2 is **complete** per the 10 instructions. Production authentication
remains **off** on s52. **Awaiting explicit approval** before: (a) any
production auth activation (§10), and (b) starting Phase 3 (Windows Local
run + `PHASE_3_LOCAL_SETUP.md`).
