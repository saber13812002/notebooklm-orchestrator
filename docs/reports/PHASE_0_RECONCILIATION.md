# Phase 0 — Read-Only Reconciliation (Six-Phase Infrastructure & Release Mission)

- **Date:** 2026-10-29 (UTC)
- **Mode:** Read-only. **Nothing was deployed, restarted, changed, or published** in this phase.
- **Method:** direct inspection of the local checkout, `git ls-remote`, GitHub API (check-runs),
  `ssh s52` (systemctl / curl loopback / sqlite3 / git), local `netstat`, `nslookup`, and
  HTTPS probes to GitLab / Wiki.js. No assumptions carried over from prior reports — every
  reference value from the mission prompt was re-verified.

## 1. Verification levels (honest)

| Area                                     | Level                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Git (local / GitHub / production)        | **Live-verified** (direct commands)                                                   |
| Production service health (s52)          | **Live-verified** (loopback curl, 200s)                                               |
| Production auth state (tokens/audit/env) | **Live-verified** (sqlite3 + env key list)                                            |
| Local Windows environment                | **Live-verified** (netstat, versions, DB read-only)                                   |
| GitLab / Wiki.js reachability            | **Live-verified** (anonymous HTTP only; authenticated state unknown — no credentials) |
| DNS / target domain                      | **Live-verified** (nslookup + probes)                                                 |
| Edge proxy (80.191.92.189) internals     | **Not tested** (no access; not needed for Phase 0)                                    |

## 2. Git state — all four locations kept distinct

| Location                                                           | Branch | SHA                                        | State                                                                                                      |
| ------------------------------------------------------------------ | ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Local Windows                                                      | `main` | `627404c1a14a436feeb9e2c5790c48ac4ef632c5` | clean (only untracked scratch: `$out`, `HTTP`, `tmp/`)                                                     |
| GitHub `saber13812002/notebooklm-orchestrator`                     | `main` | `627404c1a14a436feeb9e2c5790c48ac4ef632c5` | `git ls-remote` matches local exactly; 0 ahead / 0 behind                                                  |
| Production s52 `/home/saber/saberprojects/notebooklm-orchestrator` | —      | `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9` | matches `data/deployed-commit`; **ancestor of HEAD** (fast-forward deploy possible, no history divergence) |
| GitLab `git.ai.ismc.ir`                                            | —      | unknown                                    | service up (302 → `/users/sign_in`); **no credentials → project existence / CI state unverified**          |

- GitHub CI on `627404c` (via API check-runs): **`quality (lint / format / typecheck / test / build)` = success**,
  **`docker image build` = success**.
- Commits on GitHub not yet on production (5, all safe fast-forward — no product breakage, docs + bootstrap CLI only):
  `9e3fc67` (Phase C live-acceptance report) → `d02bcbc` (Swagger accessibility report) →
  `8938bcc` (GitHub publication report) → `cfd96e6` (first-admin bootstrap, Phase 2 code) →
  `627404c` (this mission's prior-phase report).
- **Anomaly found & resolved (non-destructive):** between sessions, the preserved scratch paths
  (`$out`, `HTTP`, `tmp/`) had appeared **staged** in the git index (`A`). They were unstaged with
  `git reset` (index-only; working tree untouched). They remain **untracked and preserved**, and
  will not be committed (scratch files).

## 3. Production — s52 (172.20.1.52), service `nlo`

| Item                      | Value                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed commit           | `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9` (`b5e9ad3`)                                                                                                                                                                          |
| `data/deployed-commit`    | `b5e9ad3` (consistent with git HEAD)                                                                                                                                                                                            |
| Service                   | `active` + `enabled` (systemd)                                                                                                                                                                                                  |
| ExecStart                 | `<repo>/node_modules/.bin/tsx src/main.ts` (WorkingDirectory `apps/server`, Node 22 via `/home/saber/.local/node22`)                                                                                                            |
| Health (loopback)         | `/api/health` **200**, `/api/health/ready` **200**, `/api/openapi.json` **200**                                                                                                                                                 |
| API auth                  | **optional mode** — `NLO_API_AUTH` **not set** in `.env`                                                                                                                                                                        |
| Tokens                    | `api_tokens`: **0 rows (0 enabled)**; `api_audit_log`: **0 rows** — no token has ever been issued in production                                                                                                                 |
| `.env` location           | `<repo>/.env` (262 B, mode 664) — keys: `NLO_ALLOW_DIRECT_EGRESS`, `NLO_HOST`, `NLO_LOGIN_BROWSER`, `NLO_PORT`, `NLO_PROVIDER`, `NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN` (+ one comment line). No secrets surfaced in this report. |
| Worker                    | `data/venv` Python 3.12.3; `data/vendor` (xray) present                                                                                                                                                                         |
| Backups (`data/backups/`) | 5 × sqlite + 5 × env; newest `nlo-20261028T134316Z-b5e9ad3.sqlite` / `env-20261028T134316Z-b5e9ad3.env` (Phase C acceptance deploy)                                                                                             |
| Untracked leftovers       | `apps/server/src/proxy/connect-proxy.ts.bak-curlfix`, `apps/server/src/queue/job-runner.ts.bak-e2efix`, `nul` (left in place — no cleanup without approval)                                                                     |
| Docker                    | **installed**: 29.1.3 (Ubuntu 24.04)                                                                                                                                                                                            |
| Ports                     | BT Panel nginx holds `0.0.0.0:80` and `:443`; **no `nlo` vhost exists**; app itself loopback-only on 4870                                                                                                                       |

## 4. Local Windows — `C:\Users\s.tabatabaei\Documents\saberprojects\notebooklm-orchestrator`

| Item                       | Value                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                       | `main` @ `627404c`, in sync with origin (see §2)                                                                                                                                                                                                                                            |
| Node / npm                 | **v24.14.0 / 11.9.0** (note: production & Docker target **Node 22** — see D7)                                                                                                                                                                                                               |
| Python                     | system **3.14.7**; local venv `data/venv` **3.13.15** (worker deps present)                                                                                                                                                                                                                 |
| node_modules               | installed (workspaces)                                                                                                                                                                                                                                                                      |
| `.env` keys                | `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`, `NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`, `NLO_ALLOW_DIRECT_EGRESS`. **No `NLO_API_AUTH`**, no secrets surfaced.                                                                                                                  |
| Local DB `data/nlo.sqlite` | 143,360 B; 13 tables; `schema_migrations` at **v4** (2026-10-21) — i.e. **pre-Phase C**: no `api_tokens` / `api_audit_log` yet. Migration `0005` is **purely additive** (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN`), so the next startup will apply it without data loss. |
| **Port 4870**              | **OCCUPIED by a stale NLO server, PID 8380** (started 2026-10-22 09:01, `tsx src/main.ts`). It serves **pre-Phase C code**: `/api/health` 200 but `/api/openapi.json`, `/api/docs`, `/api/v1/*` → 404.                                                                                      |
| Port 4871                  | **free**                                                                                                                                                                                                                                                                                    |
| Port 14870                 | SSH tunnel (active) → `s52:4870` (used for production loopback reach)                                                                                                                                                                                                                       |
| Playwright/Chromium        | cache empty (`.links` only) — no local browser installed                                                                                                                                                                                                                                    |
| Docker                     | **NOT installed** (`where docker` → not found)                                                                                                                                                                                                                                              |
| Git remotes                | `origin` = GitHub only; **no GitLab remote configured**                                                                                                                                                                                                                                     |

## 5. External services

| Service                                | Probe result                                                                                                                                                     | Access                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GitLab `https://git.ai.ismc.ir`        | up (302 → `/users/sign_in`)                                                                                                                                      | **anonymous only; no PAT →** project existence, runner, CI state all **unverified** |
| Wiki.js `https://docs.ai.ismc.ir`      | up (200; GraphQL `/graphql` answers anonymous `{"data":{"__typename":"Query"}}`; UI fa/RTL)                                                                      | **publishing requires an API token — not available**                                |
| Target domain `https://nlo.ai.ismc.ir` | **A → `172.20.1.52` directly** (not the reported edge `80.191.92.189`); TLS cert untrusted (self-signed); `/api/health` via domain → 404 (no nlo vhost upstream) | **no change authorized this phase**                                                 |

## 6. Docker state

- **Repo:** `Dockerfile` (multi-stage, node:22-bookworm-slim, `/opt/nbl-venv` with `notebooklm-py[browser]>=0.8.5,<0.9`, `EXPOSE 4870`, HEALTHCHECK, `CMD npx tsx apps/server/src/main.ts`), `docker-compose.yml` (restart policy, ports, volumes), `.dockerignore`, `.gitlab-ci.yml` (node:22-bookworm + docker:27-dind stages) — all present and CI-built successfully on `627404c`.
- **Local Windows:** Docker **absent** → Phase 5 local part **blocked until Docker Desktop (or equivalent) is installed** (user action).
- **s52:** Docker 29.1.3 present; production is currently on **systemd** (no migration in this mission without the dedicated approval gate).

## 7. Missing permissions / external inputs (gates for later phases)

| #   | Missing item                                                                                               | Blocks                                 |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1  | **GitLab PAT** (min-privilege; never in git/logs/reports)                                                  | Phase 4 (repo mirror, CI verification) |
| P2  | **Wiki.js API token** (publish scope)                                                                      | Phase 6 (publication)                  |
| P3  | **Authorization to change shared edge** (DNS target / reverse-proxy vhost / TLS cert for `nlo.ai.ismc.ir`) | Phase 3                                |
| P4  | **Windows Docker install** (user action)                                                                   | Phase 5 (local)                        |
| P5  | Approval of production auth activation (per-mission gate)                                                  | Phase 2                                |

## 8. Discrepancy register

| ID  | Discrepancy                                                                                                                                        | Impact                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Stale local server** PID 8380 on 4870 runs **pre-Phase C** code (Swagger/v1 404)                                                                 | Phase 1: run current code on **alternate port 4871** (per mission: prefer alternate port; do not terminate processes)                               |
| D2  | Local DB at schema **v4** (pre-`api_tokens`)                                                                                                       | Next local startup applies additive `0005` — safe, no data loss                                                                                     |
| D3  | Production is **5 commits behind** GitHub `main` (docs + bootstrap CLI; no product regression)                                                     | Phase 2 deploys `627404c` fast-forward (its own approval gate)                                                                                      |
| D4  | `nlo.ai.ismc.ir` resolves to **172.20.1.52**, not the reported edge `80.191.92.189`; TLS untrusted; **no nlo vhost**; `/api/health` via domain 404 | Phase 3 must first decide: point DNS at edge (recommended, per mission architecture) **or** add vhost on s52 — both need P3 authorization           |
| D5  | Scratch paths (`$out`, `HTTP`, `tmp/`) were found **staged in the git index** between sessions                                                     | Unstaged (index-only, non-destructive); preserved; will not be committed                                                                            |
| D6  | s52 untracked leftovers (2 `.bak-*` files, `nul`)                                                                                                  | Cosmetic; left untouched without approval                                                                                                           |
| D7  | Local dev **Node 24.14.0** vs production/Docker/CI **Node 22**                                                                                     | Functional today (CI green on 22, local app runs on 24); Phase 1 will note any divergence; consider pinning via `.nvmrc`/`engines` in a later phase |
| D8  | s52 `.env` mode **664** (group-writable)                                                                                                           | Minor hardening: recommend `600` (fold into a Phase 2 preflight action, with approval)                                                              |
| D9  | GitLab project state **unknown** (no credentials)                                                                                                  | Phase 4 step 1 = authenticated audit for duplicate projects before any creation                                                                     |
| D10 | Wiki.js anonymous GraphQL is open (200)                                                                                                            | Not an NLO secret exposure, but noted for the Phase 6 security review                                                                               |

## 9. Phase 0 constraint compliance

- ✅ **Do not deploy anything** — no s52 change, no restart, no checkout, no service action.
- ✅ No DB writes (all DB reads used `mode=ro`).
- ✅ No credentials collected or surfaced; no secrets in this report.
- ✅ No DNS / vhost / firewall / proxy change.
- ✅ No scratch files committed.

## 10. Files changed in this phase

| File                                     | Change                  |
| ---------------------------------------- | ----------------------- |
| `docs/reports/PHASE_0_RECONCILIATION.md` | **added** (this report) |

(Scratch probe script `tmp/n0-local-db-check.py` stays in `tmp/`, untracked, never committed.)

## 11. What was NOT tested / not done

- No production restart, redeploy, or rollback.
- No live NotebookLM job, no token bootstrap anywhere, no auth-mode change.
- GitLab and Wiki.js **authenticated** state (requires credentials — P1, P2).
- Edge proxy `80.191.92.189` configuration (no access granted).
- Docker image **run** (only CI build verified; local Docker absent).
- s52 public/external reachability of 4870 (loopback-only by design; only loopback probed).

## 12. Recommended next step (Phase 1 plan, per mission)

1. Re-inspect local repo/versions/.env/DB (done above; re-confirmed at Phase 1 start).
2. Run the **current** version (`627404c`) locally on **port 4871** (4870 occupied by stale same-app process D1 — left running; mission says prefer alternate port).
3. Verify `GET /api/health`, `/api/health/ready`, `/api/openapi.json`, `/api/docs`.
4. Full regression suite (root `npm test`) + one authorized + one unauthorized API request in an **isolated** environment (separate `NLO_DATA_DIR`, `NLO_API_AUTH=1`, Phase-2 bootstrap CLI; token value never written to any report).
5. Deliver `docs/reports/PHASE_1_LOCAL_SWAGGER.md`, commit + push the report only, then **STOP for explicit approval** before Phase 2.

## 13. Approval request

Phase 0 (read-only reconciliation) is **complete**. Requesting explicit approval to start
**Phase 1 — Windows Local + Swagger**, with the Phase 1 plan in §12. No Production
authentication activation, shared reverse-proxy change, Production Docker migration, or
public documentation publication is authorized by this report.
