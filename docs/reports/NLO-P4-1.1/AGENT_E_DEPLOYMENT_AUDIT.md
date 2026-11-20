# Agent E — Production & Docker Audit (NLO-P4-1.1)

- **Agent role:** Production & Docker Auditor (Qwen)
- **Mode:** strictly **read-only**; executed sequentially in a separate context (no true subagents —
  see CONSOLIDATED §parallelism).
- **Executed:** 2026-11-17 ~16:20–16:30 UTC. Host: workstation `BAKHTIARI-VM` (Windows 10); production
  host probed over the network only.
- **Non-negotiables honored:** NO production change, no Nginx/DNS/SSL/firewall/Docker change, no
  restart, no deploy. Every live probe below was a read (TCP connect / HTTP GET). Where access was
  missing, the item is marked **BLOCKED** — nothing was guessed.

---

## 1. Where NLO runs — local vs production

| Location | State | Evidence |
|---|---|---|
| **Workstation (this machine)** | Local **dev server** running on port **4871** (`NLO_PORT=4871 npx tsx apps/server/src/main.ts`), `/api/health` → **200** | Active terminal; health probe re-confirmed during audit |
| **Legacy production host s52** (`172.20.1.52`) | **Decommissioned 2026-11-01** (unreachable) — per `docs/deployment/s52-deploy.md` §Status and prior G-phase reports | doc read + prior reports |
| **New production host** (`172.30.0.133`) | **NLO NOT deployed** — see §3 probes | live probes below |

**Conclusion: there is currently NO running production instance of NLO.** The only live instance is the
local dev server on 4871 (mock mode by default). **VERIFIED** (probes below).

## 2. New-host network probes (read-only, 2026-11-17 ~16:2x UTC, from workstation)

| Probe | Result |
|---|---|
| `Test-NetConnection 172.30.0.133:22` | **TCP open** (SSH daemon reachable) |
| `curl http://172.30.0.133:80` | HTTP response — **aaPanel default vhost** "Website not found" (a generic web panel, not an NLO vhost) |
| `curl https://172.30.0.133:443` | **closed / no TLS response** |
| `curl http://172.30.0.133:4870/api/health` | **closed** (no NLO listener) |
| DNS `nlo.ai.ismc.ir`, `nlo2.ai.ismc.ir`, `*.ai.ismc.ir` | all resolve to `172.30.0.133` |
| `https://git.ai.ismc.ir` (GitLab, co-located on new host) | alive, HTTP 302 → login |

Interpretation: the new host is a **shared aaPanel box** (other org services live there — GitLab,
Wiki.js). NLO's service, vhost, TLS and port are all **absent**: the endpoint-migration addendum
(Phase G) has not been executed. **VERIFIED.**

## 3. Production internals — BLOCKED without SSH credentials

SSH port 22 is open, but **no credentials/keys for the production host are available on this
workstation** (checked: no NLO-specific ssh config, no known agent with the key). Therefore the
following are **BLOCKED** (documented, not guessed):

| Item | Status |
|---|---|
| Production `git rev-parse HEAD` / deployed commit | BLOCKED (no SSH) |
| `systemctl status nlo`, `journalctl -u nlo` | BLOCKED (no SSH) |
| `data/` contents: DB, backups, vault, venv, vendor/xray, sessions | BLOCKED (no SSH) |
| Production `.env` contents/permissions | BLOCKED (no SSH) |
| `ss -ltnp` port 4870 listener identity | BLOCKED (port closed anyway → service not running) |
| Docker state on production host | BLOCKED (no SSH; note: production path is **systemd**, not Docker — see §5) |

The port-4870-closed result is sufficient to conclude the service is **not running** on the new host
without needing SSH. Everything deeper (what *was* running before decommission, exact backup counts)
needs SSH. **PARTIALLY-VERIFIED** (host-level facts) / **BLOCKED** (host-internal facts).

## 4. Deployment machinery (code-reviewed at HEAD)

### 4.1 `deploy/deploy.sh` (181 lines, read fully)

Git-based, host-agnostic, run *on the production host*:

1. Resolve target commit; **only commits reachable from `origin/main` are deployable** (warns on local
   commits) — matches AGENTS.md §8.
2. Refuse to run with dirty tracked tree.
3. Prerequisite warnings (service active, `.env`, `data/vendor/xray`).
4. **Backup before any change**: `data/nlo.sqlite` → `data/backups/nlo-<TS>-<sha>.sqlite`,
   `.env` → `data/backups/env-<TS>-<sha>.env` (chmod 600), retention **5 newest** per kind.
5. `git reset --hard <target>` (safe: only reached after clean-tree check; `data/` is untracked and
   never touched — the script's `git status --porcelain --untracked-files=no` check is the guard).
6. `npm ci --omit=dev` / venv sync **only when the relevant manifest changed** (diff-gated).
7. `sudo systemctl restart nlo`.
8. **Verify, don't assume**: unit active, `/api/health`, `/api/health/ready` must contain
   `"ready":true`, port listening, journal free of new errors since restart.
9. Regression: `apps/server` vitest run (failures reported, non-fatal — documented choice).
10. Record `data/deployed-commit`.
- Dry-run mode (`NLO_DEPLOY_DRY_RUN=1`): no checkout/backup/restart.
- Rollback: `ROLLBACK=1` documented; previous-good commit printed at the top of **every** run.
- No credentials read or logged.

**CODE-VERIFIED.** The script is consistent with AGENTS.md §8 (rollback always possible, `data/`
survives, previous-good printed).

### 4.2 `deploy/systemd/nlo.service` (read fully)

- `User=saber`, `WorkingDirectory=/home/saber/saberprojects/notebooklm-orchestrator/apps/server`,
  `ExecStart=…/node_modules/.bin/tsx src/main.ts`.
- `Restart=always`, `RestartSec=5`, `TimeoutStopSec=120` (graceful drain window), `KillSignal=SIGTERM`.
- Hardening: `NoNewPrivileges=true`, `PrivateTmp=true`.
- Loopback bind via `.env` (`NLO_HOST=127.0.0.1`), journal logging, `SyslogIdentifier=nlo`.

**CODE-VERIFIED.** Note the unit is **host-agnostic but pre-filled for the s52 paths**
(`/home/saber/…`, node22 in `/home/saber/.local/node22/bin`) — the header says "adjust paths/user per
host", so re-deployment on the new host requires verifying those paths exist there (setup step, not a
defect).

## 5. Docker (kept for local single-user runs, per AGENTS.md §8)

### 5.1 `Dockerfile` (64 lines, read fully)

- Two-stage: `node:22-bookworm-slim` builder (ships host `node_modules`/`dist` when present —
  offline-friendly), slim runtime.
- `ca-certificates` installed (xray's Go TLS needs the system store — documented).
- Python venv baked at `/opt/nbl-venv` (`notebooklm-py[browser]`) — container never depends on a host
  interpreter.
- **No Chromium on purpose** (interactive login can't work in a container; storage-state upload is the
  container path) — documented in-file.
- Non-root: `USER node` (uid 1000); `VOLUME ["/data"]`; `HEALTHCHECK` hits `/api/health`;
  binds `0.0.0.0` *inside* the container only.
- **No secrets in the image** (no `ARG`/`ENV` with keys; `.env` is bind-mounted via compose, not
  baked). **CODE-VERIFIED** against AGENTS.md §7.

### 5.2 `docker-compose.yml` (48 lines, read fully)

- Publishes **`127.0.0.1:4870:4870` only** (host loopback; comment explains when to widen it).
- `./data:/data` bind mount → DB, archives, vault, sessions, vendor survive recreate.
- `user: ${NLO_UID:-1000}:${NLO_GID:-1000}` (host-uid override for the bind mount).
- Env: provider/proxy-runtime defaulted to **mock**; `NLO_PYTHON_BIN` pinned to the baked venv
  (explicitly *not* interpolated from the host `.env` — a real pitfall documented in the comment).

**CODE-VERIFIED.**

### 5.3 Docker runnability on this workstation

**BLOCKED/NOT-RUN:** no Docker daemon on this Windows machine (Docker API connect failed during the
audit — also surfaced while extracting the CI docker job). The image build is therefore
**file-reviewed only**; it has not been rebuilt in this audit. **PARTIALLY-VERIFIED.**

### 5.4 Nginx staging templates (for the future `nlo2.ai.ismc.ir` / `nlo.ai.ismc.ir` fronts)

- `deploy/nginx/nlo-vhost.stageA.conf.tpl` — plain HTTP vhost (port 80, `__NLO_DOMAIN__` placeholder).
- `deploy/nginx/nlo-vhost.stageB.conf.tpl` — 443 ssl, `TLSv1.2 TLSv1.3`, `http2 on`,
  `__NLO_CERT_DIR__` cert placeholders, `proxy_pass http://__NLO_UPSTREAM__`.
- `deploy/nginx/nlo-nginx-deploy.sh` + `README.md` — template-substitution deploy helper.

These are **templates only** — neither domain currently has a live NLO vhost (aaPanel default page at
:80, §2). **CODE-VERIFIED** (templates read) / **NOT-DEPLOYED** (live state).

## 6. Staging vs production (permanent standard §8)

| Standard | State at HEAD |
|---|---|
| Production = `nlo.ai.ismc.ir` | DNS → new host; **no vhost/service yet** (BLOCKED for full bring-up) |
| Staging = `nlo2.ai.ismc.ir` | DNS → new host; **no vhost/service yet**; no staging-environment code path exists (single `.env` model; staging is a *deployment target*, not a code mode) |
| Staging-first testing | Not executable today — staging host has no NLO instance; local dev (4871) + mock provider is the de-facto pre-prod path |

**VERIFIED** (DNS + port probes) / **BLOCKED** (bring-up requires SSH + owner approval, which the
mission forbids this session).

## 7. Backups & rollback

- **In-script:** DB + `.env` snapshot per deploy, 5-deep retention, `.env` backups chmod 600
  (deploy.sh §4) — **CODE-VERIFIED**.
- **On-host:** backup directory contents on the new host — **BLOCKED** (no SSH; and nothing is
  deployed there yet, so the question is moot until first deploy).
- **Legacy s52 backups:** s52 decommissioned; whether its `data/` was migrated to the new host is
  **NOT-VERIFIED** from this workstation (would need access to either host) — recorded as an open
  migration question (backlog E-BL-04).

## 8. `.env` permissions

- Production `.env` perms: **BLOCKED** (no SSH). The deploy script *backs up* `.env` with 600; the
  running service reads it from the repo root (auto-load in `config.ts`).
- Workstation `.env` perms: default inherited ACL (user F; sandbox RX) — see Agent C §3 (C-BL-05).

## 9. Findings summary (Agent E)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| E-BL-01 | **P0 (ops)** | **No production instance of NLO exists right now**: s52 decommissioned, new host has no service/vhost/TLS/4870. Any "production" work (P4-2+) must first re-deploy on 172.30.0.133 — a prerequisite the mission's no-deploy rule means this audit can only *prepare*, not do | §1–§3 |
| E-BL-02 | P1 | Production-internal state (deployed SHA, backups, venv, xray, .env) **BLOCKED** without SSH credentials for 172.30.0.133 — request the access item from the owner | §3 |
| E-BL-03 | P1 | Re-deployment prerequisites on the new host are unverified: `/home/saber` paths, node22 location, repo clone, `data/` migration from s52 (incl. DB, vault, vendor/xray, sessions) | §4.2, §7 |
| E-BL-04 | P2 | s52 `data/` migration question open (was the DB/vault carried over when s52 was decommissioned?) | §7 |
| E-BL-05 | P2 | Docker image build not re-verified in this audit (no local daemon); CI docker job gated `BUILD_DOCKER=1` | §5.3 |
| E-BL-06 | INFO | deploy.sh / systemd unit / Dockerfile / compose / nginx templates all consistent with AGENTS.md §7/§8; rollback always possible; `data/` never touched | §4–§5 |
| E-BL-07 | INFO | No staging instance exists yet (staging-first standard not executable until E-BL-01) | §6 |

## 10. What this agent did NOT do

- No SSH session was opened (no credentials). No file on the production host was read.
- No Docker build/run. No service started, stopped, or restarted anywhere.
- No deployment, rollback, DNS, Nginx, SSL, or firewall change.
