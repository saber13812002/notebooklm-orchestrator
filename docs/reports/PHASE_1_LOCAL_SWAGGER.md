# Phase 1 — Windows Local Run + Swagger Verification (Report)

Mission: Six-Phase Infrastructure & Release Mission — Phase 1 only.
Date: 2026-10-29 (UTC). Prepared per Phase 0 plan (§12 of
[PHASE_0_RECONCILIATION.md](PHASE_0_RECONCILIATION.md)).

## 1. Verification levels (honest, as required)

| Item                                                                 | Level                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local server run (127.0.0.1:4871)                                    | Live-verified (local machine only)                                                                                               |
| `/api/health`, `/api/health/ready`, `/api/openapi.json`, `/api/docs` | Live-verified (local, real provider config)                                                                                      |
| Full regression suite                                                | Unit/Integration-tested (164/164)                                                                                                |
| API auth matrix (unauthorized/authorized/invalid)                    | **Live-verified in an isolated local environment with the MOCK provider — explicitly Mock, not real NotebookLM, not production** |
| Production (s52)                                                     | Unchanged — Phase 0 read-only state remains valid                                                                                |

## 2. Constraint compliance (Phase 1 rules)

- **Data preserved:** `.env` read-only, never modified, never staged; local DB
  preserved in place; no production changes; no scratch files committed.
- **Port discipline:** default port 4870 is held by a stale pre-Phase-C local
  server (PID 8380). Per the mission rule ("prefer an alternate local port if
  occupied; do not terminate unrelated processes"), the stale process was
  **left running** and this phase used **port 4871**.
- **Isolation:** the auth probe used a throwaway `NLO_DATA_DIR`
  (`%TEMP%\nlo-p1-isolated`) that did not touch the real `data/` directory;
  the directory was removed after the probe (verified by `netstat` +
  `existsSync`).
- **Secrets:** the bootstrap token plaintext was kept in memory only and is
  **not** recorded in this report (only the non-secret token id
  `tok_6fc7302ab5184c51b64f612e` is cited).

## 3. Local environment inspection (N1-1)

| Item                        | Value                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo                        | `C:\Users\...\notebooklm-orchestrator` (this workspace)                                                                                                                                                      |
| Branch / HEAD               | `main` @ `9aa4b3dc186ee22b577997040d64967ea6fd5185` (Phase 0 report commit); product code = `627404c1a14a436feeb9e2c5790c48ac4ef632c5`                                                                       |
| Remotes                     | `origin` → GitHub `saber13812002/notebooklm-orchestrator` (single remote, unchanged)                                                                                                                         |
| Node / npm                  | v24.14.0 / 11.9.0                                                                                                                                                                                            |
| Python (system / venv)      | 3.14.7 / 3.13.15 (`data/venv`)                                                                                                                                                                               |
| Worker deps                 | `notebooklm-py` 0.8.5 (module `notebooklm`) + `playwright` 1.64.0 — worker `ping` OK                                                                                                                         |
| Docker                      | Absent locally (no engine)                                                                                                                                                                                   |
| Ports at start              | 4870 = stale NLO PID 8380 (kept); 4871 = free (used here); 14870 = SSH tunnel to s52 (kept)                                                                                                                  |
| `.env` (values, no secrets) | `NLO_HOST=127.0.0.1`, `NLO_PORT=4870`, `NLO_PROVIDER=python-worker`, `NLO_PROXY_RUNTIME=xray`, `NLO_PYTHON_BIN=<repo>/data/venv/Scripts/python.exe`, `NLO_LOGIN_BROWSER=chrome`, `NLO_ALLOW_DIRECT_EGRESS=0` |
| Dependencies                | Already installed (`node_modules` present); no fresh install needed — server start and full test suite both ran from the existing tree                                                                       |

## 4. Running the current version (N1-2)

- Command: `set NLO_PORT=4871 && npx tsx apps/server/src/main.ts`
  (real `.env` values otherwise; only the port overridden via process env,
  which wins per `loadDotEnv()` semantics in
  [`apps/server/src/config.ts`](../../apps/server/src/config.ts)).
- Startup: `listening on http://127.0.0.1:4871`, `provider=python-worker`,
  `proxyRuntime=xray`, live tests disabled.
- The server remains running after this report (Terminal 2) for continued
  local use; it binds loopback only.

## 5. Endpoint verification (port 4871, real `python-worker` config)

| Endpoint                   | HTTP | Response (verbatim, trimmed)                                                                                                                                        |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`          | 200  | `{"ok":true,"service":"notebooklm-orchestrator","time":"..."}`                                                                                                      |
| `GET /api/health/ready`    | 200  | `{"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}` |
| `GET /api/openapi.json`    | 200  | OpenAPI `3.0.3`, title "NotebookLM Orchestrator API"                                                                                                                |
| `GET /api/docs`            | 200  | Swagger UI HTML                                                                                                                                                     |
| v1 mirrors (`/api/v1/...`) | 200  | Same resources via the versioned surface                                                                                                                            |

`/api/health/ready` honestly validates the provider by spawning the real
Python worker and pinging it (`validateConfiguration()`); result:
**configured=true, issues=[]** — local runtime (worker + playwright) is
functional.

## 6. Database & migration

- Pre-start: 13 tables, schema v4 (no `api_tokens` / `api_audit_log`).
- At startup, migration `0005_api_tokens.sql` auto-applied (purely additive:
  `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN`): 13 → 15
  tables. Existing data intact (read-only queries before/after; job rows
  unchanged).
- A re-queued pre-existing job `j_6a24e6a5...` FAILED with
  `account sas is not usable: session not verified` — **expected** (the local
  session is not verified); no data loss, job state preserved.

## 7. Full regression (N1-3)

- `npm test` across all workspaces: **164/164 passed**
  (shared 44, server 95, web 25).
- `npm run typecheck`, `npm run build`, `prettier --check` re-run clean on the
  final tree before commit (docs-only change).

## 8. Isolated API-auth probe — **MOCK provider, isolated data dir, port 4872**

Environment (all throwaway): `NLO_DATA_DIR=%TEMP%\nlo-p1-isolated`,
`NLO_API_AUTH=1` (enforced), `NLO_PROVIDER=mock`,
`NLO_PROXY_RUNTIME=mock`, port 4872. First-admin token bootstrapped via the
offline CLI (`--name phase1-local-probe`), token id
`tok_6fc7302ab5184c51b64f612e` (all 6 default scopes). **This is Mock-mode
evidence; it validates the auth gate logic, not real NotebookLM behavior.**

| #   | Request                             | Expected                 | Observed                                                                             |
| --- | ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| 1   | `GET /api/v1/jobs` (no token)       | 401                      | **401** `{"error":{"code":"unauthorized","message":"API token required"}}`           |
| 2   | `GET /api/v1/tokens` (no token)     | 401                      | **401** (same envelope)                                                              |
| 3   | `GET /api/health` (no token)        | 200 (exempt)             | **200**                                                                              |
| 4   | `GET /api/health/ready` (no token)  | 200 (exempt)             | **200** (`provider.mock`, `configured:true`)                                         |
| 5   | `GET /api/openapi.json` (no token)  | 200 (exempt)             | **200**                                                                              |
| 6   | `GET /api/docs` (no token)          | 200 (exempt)             | **200** (HTML)                                                                       |
| 7   | `GET /api/jobs` legacy (no token)   | 200 (legacy never gated) | **200** `{"items":[],"total":0}`                                                     |
| 8   | `GET /api/v1/jobs` (valid bearer)   | 200                      | **200** `{"items":[],"total":0}`                                                     |
| 9   | `GET /api/v1/tokens` (valid bearer) | 200                      | **200** (lists the bootstrap token)                                                  |
| 10  | `GET /api/v1/audit` (valid bearer)  | 200                      | **200** (audit rows, no token values)                                                |
| 11  | `GET /api/v1/jobs` (wrong bearer)   | 401                      | **401** `{"error":{"code":"unauthorized","message":"invalid or revoked API token"}}` |

**11/11 as expected.** Teardown verified: port 4872 free afterward
(`netstat`), isolated directory removed, token plaintext never written to
disk or to this report.

Integrity note: an earlier probe iteration (a tooling bug in the throwaway
probe script — a shell-spawned server survived the script's kill) left an
orphaned process on 4872; it was identified and terminated (own test
process only), and its isolated DB (the only store the earlier one-off token
was valid against) was deleted. That one-off token is therefore invalid and
is cited nowhere. The product code was not involved in this tooling issue.

## 9. Findings register

| ID  | Finding                                                                           | Disposition                                                                                                    |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| F1  | Stale pre-Phase-C local server (PID 8380) still holds port 4870                   | Left running per mission rule; user may stop it at will                                                        |
| F2  | Windows `spawn(..., {shell:true})` orphans the grandchild on kill (probe tooling) | Fixed in the throwaway probe script (shell-less `node --import tsx` spawn + pre-clean); no product-code impact |
| F3  | Re-queued job `j_6a24e6a5...` fails with "session not verified"                   | Expected on local (unverified session); no action needed for Phase 1                                           |
| F4  | Untracked scratch (`$out`, `HTTP`, `tmp/`) in working tree                        | Not staged, not committed; `tmp/` is git-ignored scratch                                                       |

## 10. What was NOT tested / not done

- No live / real-NotebookLM job locally (no verified session; live runs are
  a manual gate by policy).
- No Docker run locally (Docker engine absent — Phase 5 territory).
- No production, DNS, proxy, or shared-infrastructure changes of any kind.
- No new API surface; OpenAPI unchanged.

## 11. Skills used

None applicable (no UI/UX/design skill was relevant to this
infrastructure/verification phase).

## 12. Files changed in this phase

- `docs/reports/PHASE_1_LOCAL_SWAGGER.md` (new — this report)
- Product code: **none**. Throwaway probe artifacts remain in `tmp/`
  (untracked scratch, not committed).

## 13. Commit & push

- Staged **only** this report; staged-content scan clean (no secrets/tokens;
  only the non-secret token id `tok_...` and non-secret `.env` values appear).
- Pushed fast-forward to `origin/main`; no force-push, no history rewrite.

## 14. Approval request — STOP

Phase 1 is complete. **Per the mission, I stop here and request explicit
approval before Phase 2** (Production API-auth activation on s52 — preflight,
backups, a dedicated approval gate before flipping `NLO_API_AUTH=true`,
controlled deploy, live acceptance). No Phase 2 action will be taken without
that approval.
