# NLO-P5-0 — Infrastructure Re-baseline & Production Discovery

**Date:** 2026-11-20 23:01–23:17 UTC (2026-11-21 02:31–02:47 +0330 Tehran)
**Mission:** NLO-P5-0 — read-only infrastructure re-baseline. No install, no change,
no restart, no commit, no push, no deploy (per mission STOP rule).
**Mode:** READ-ONLY — only probes: local `git` inspection, HTTP/TCP/DNS probes,
read-only SSH (`saber@172.30.0.133`, publickey), SQLite `mode=ro` queries, file
inventory (metadata only — no secret contents read).
**Labels per claim:** VERIFIED / PARTIALLY VERIFIED / NOT VERIFIED / BLOCKED /
NOT IMPLEMENTED / NOT_TESTED.

Companion prior reports (read for context, re-verified live below where
marked): `NLO_ACCESS_REBASELINE_2026-11-14.md`, `PHASE_G3A_NEW_HOST_AUDIT.md`,
`docs/reports/NLO-P4-1.1/` (7-agent audit), `NLO_MASTER_EXECUTION_STATUS.md`.

---

## 1. Executive Summary

1. **One production NLO exists: systemd service `nlo` on `172.30.0.133`
   (host `AI-TOOLS`)**, running commit `278273a` since 2026-11-14 17:35 UTC
   (6 days), loopback-only `127.0.0.1:4870`, health + ready green,
   provider `python-worker` configured with no issues, `xray` runtime
   available. **VERIFIED (live probes 2026-11-20 23:07 UTC).**
2. **The production repo is 12 commits behind `origin/main`** (`632a752`),
   0 ahead → a clean fast-forward. Working tree on host has only 3
   pre-existing untracked scratch files. **VERIFIED.**
3. **No NLO Stage exists yet.** `nlo2.ai.ismc.ir` has a public DNS A record
   (`185.213.10.25`) and an internal one (`172.30.0.133`) but **no nginx
   vhost, no TLS certificate, no Docker deployment**. HTTPS requests for it
   land on the catch-all vhost (cert `CN=admin.ai.ismc.ir`) → `404`.
   **VERIFIED.**
4. **`nlo.ai.ismc.ir` is at nginx "Stage A" only**: an HTTP-80 vhost
   (ACME webroot + `301 → https`) is installed, but **no Let's Encrypt
   certificate has been issued and no `listen 443` block exists** → public
   HTTPS currently returns `404` on the catch-all. The repo already contains
   the full Stage A/B vhost templates + staged deploy helper
   ([deploy/nginx/](../../deploy/nginx/README.md)) and a proven DNS-01
   (Cloudflare) cert-issuance script preserved in the P3 backup. **VERIFIED.**
5. **DNS is split-horizon** (works, but must be understood): from the
   workstation resolver `nlo*.ai.ismc.ir → 172.30.0.133` (internal), from
   public DoH (1.1.1.1) `→ 185.213.10.25` (public edge). Both reach the same
   host. **VERIFIED.**
6. **GitHub CI is RED on `origin/main`**: the last 3 CI runs (`632a752`
   2026-11-20, `b833d89` 2026-11-17, `f07ac1f` 2026-11-16) all ended
   `failure` — `quality` job failed and `secret scan` job failed
   (`conformance` passed, `docker` skipped). Root cause **not reproduced**
   locally in this read-only mission. This is a **hard blocker** for the
   P5-1A commit gate. **VERIFIED (GitHub API).**
7. **GitLab** (internal, same server) is up as a container with
   `git.ai.ismc.ir` publicly serving it (`302 → /users/sign_in`,
   `/api/v4/version → 401`), but the NLO repo has **no GitLab remote, no
   GitLab project, and no runner** (`.gitlab-ci.yml` exists, "ready, NOT yet
   active"). The server's internal name resolution still maps
   `git.ai.ismc.ir → 172.20.1.52` (the decommissioned s52) — a stale record.
   **VERIFIED.**
8. **Today's production job failed for a session reason, not a code
   reason**: `j_82de2bb699ae39119386e76687ae480c` (2026-11-20 22:53 UTC)
   went `created → validate → no_account` ("no eligible account with
   verified session") in 0.2 s. The single server-side Google session
   (`nlo-acc_5a03a60bbda24085.json`) has evidently expired / is unverified —
   exactly the gap P5-3A is scoped to fix. **VERIFIED (job_events, ro).**
9. **Legacy host `s52` (172.20.1.52) is confirmed dead**: ports 22/80/443
   all closed/timeout from the workstation. **VERIFIED.**
10. **FFmpeg is installed on the server (`/usr/bin/ffmpeg` 6.1.1) but not
    configured in NLO** (no `NLO_FFMPEG_BIN` in the server `.env`) → MP3
    transcode stays honestly `not_configured`. No FFmpeg, no Docker on the
    Windows workstation. **VERIFIED.**
11. **No local (workstation) NLO instance is running** at mission end
    (4870/4871 refused). A transient dev instance on `4871` was observed
    answering at 23:03:35 UTC and exited shortly after; it is not part of
    the baseline. **VERIFIED.**

**Go/No-Go (section 17):** Stage (`nlo2.ai.ismc.ir`) → **GO WITH
CONDITIONS** for P5-1A. Production (`nlo.ai.ismc.ir`) public rollout →
**NO-GO** until Stage acceptance + TLS + promotion path (P5-5).

---

## 2. Mission Scope

In (read-only discovery): repository audit (A), server discovery (B),
runtime discovery (C), data discovery (D), security audit (E), backup
inventory (F), read-only probes only, one report file.

Out (explicitly not done): no Docker install/daemon change, no nginx edit or
reload, no DNS/cert action, no `.env` change, no service restart, no
migration, no job creation, no `git add/commit/push`, no new backup
(created), no firewall change.

---

## 3. Initial Baseline (live-verified 2026-11-20 23:01–23:17 UTC)

### 3.1 Environments inventory

| Env                         | Host                                                                                                                                           | Path                                                                    | Mechanism                                                                                                                           | Commit                                    | State                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Local (Windows workstation) | `TABLIGH-VM` / user `s.tabatabaei`                                                                                                             | `c:/Users/s.tabatabaei/Documents/saberprojects/notebooklm-orchestrator` | bare `tsx` (manual `npm run dev`), loopback                                                                                         | `632a752` (HEAD)                          | **no instance running** at mission end (4870/4871 refused); transient 4871 dev instance seen at 23:03:35 UTC, gone by 23:07 |
| **Production (de-facto)**   | `172.30.0.133` (`AI-TOOLS`, Ubuntu 24.04.4 LTS, kernel 6.8.0-147, 20× Xeon Gold 6458Q, 78 GiB RAM, disk 686 GiB 43 % used, up 20 d, load ~2.5) | `/home/saber/saberprojects/notebooklm-orchestrator`                     | systemd `nlo.service` (enabled, `Restart=always`, `NoNewPrivileges`, `PrivateTmp`, `TimeoutStopSec=120`), loopback `127.0.0.1:4870` | `278273a` (`data/deployed-commit` agrees) | **active (running) since 2026-11-14 17:35:56 UTC**, MainPID 2809780, RSS ~94 MB; health/ready green                         |
| **Stage**                   | `172.30.0.133`                                                                                                                                 | —                                                                       | —                                                                                                                                   | —                                         | **NOT IMPLEMENTED** (no vhost, no cert, no Docker project, no separate data dir)                                            |

### 3.2 Repository / Git matrix

| Item                               | Local (Windows)                                                             | Production (`AI-TOOLS`)                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Remote `origin`                    | `https://github.com/saber13812002/notebooklm-orchestrator.git` (fetch+push) | identical                                                                                                                                  |
| Branch / HEAD                      | `main` / `632a752da880357c0565e60b1300824cafbec5a3`                         | `main` / `278273a2e9f8fabb137d6ecdb3a51c1745dd8352`                                                                                        |
| vs `origin/main`                   | 0 / 0 (in sync; `git ls-remote` HEAD = `632a752`, `fetch` OK)               | **12 behind / 0 ahead** (fast-forward safe; verified `git rev-list --count`)                                                               |
| Working tree                       | clean (0 modified / 0 staged / 0 untracked)                                 | 3 untracked pre-existing: `apps/server/src/proxy/connect-proxy.ts.bak-curlfix`, `apps/server/src/queue/job-runner.ts.bak-e2efix`, `nul`    |
| GitLab remote                      | none                                                                        | none                                                                                                                                       |
| Tags                               | none                                                                        | none                                                                                                                                       |
| P5 commits in history              | **none** (this is the first P5 mission)                                     | none                                                                                                                                       |
| GitLab project on `git.ai.ismc.ir` | —                                                                           | **none** (`/api/v4/projects?search=notebooklm → 200 []` unauthenticated)                                                                   |
| CI (GitHub Actions)                | —                                                                           | last 3 pushes on `main` = **failure** (`quality` fail, `secret scan` fail, `conformance` pass, `docker` skipped) — VERIFIED via GitHub API |
| CI (GitLab)                        | —                                                                           | `.gitlab-ci.yml` present; **no runner registered → pipeline not running** (file header states this)                                        |

Latest 12 commits on `origin/main` (all reachable from local HEAD):
`632a752` P4-1.1 mission close, `b833d89` final report, `232b5da` provider
conformance CI, `073637d` durable job locks, `373440d` provider egress
gateway, `90f9619` provider registry/capabilities API, `f07ac1f` ریبورت,
`5720d16` P4-0 docs, `76cd5f0` NLO-P3 security acceptance, `430c565` NLO-P3
preflight+backup, `e56c0a8` access-rebaseline docs, `4e2d533` P2 deploy
docs.

**Workstation git config observations:** `http.sslverify=false`
(global; pre-existing finding A-5 from the P4-1.1 audit, still present),
identity `moazpor <moazpor@gmail.com>`.

### 3.3 Runtime discovery (production host, live)

| Component                            | State                                                                                              | Evidence                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NLO API (Node 22, tsx)               | UP                                                                                                 | `GET /api/health → 200 {"ok":true,...}` from host loopback (23:07:47 UTC)                                                                                                             |
| Readiness                            | GREEN                                                                                              | `GET /api/health/ready → 200 {"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}` |
| UI (built web dist served by server) | UP (loopback)                                                                                      | served by same process; not probed publicly (no public path exists yet)                                                                                                               |
| Python worker                        | configured, spawns on demand, ping OK                                                              | journal 23:07:47: `spawn pid=1051975 → op=ping → response ok → exit code=0`; venv `Python 3.12.3`, `notebooklm-py 0.8.5`                                                              |
| NotebookLM provider                  | configured, **no verified account session**                                                        | today's job event `no_account` (§5.3); `accounts:1` in DB                                                                                                                             |
| Queue / job engine                   | UP                                                                                                 | journal 22:53:48 `queue: starting job j_82de...`                                                                                                                                      |
| Webhook outbox                       | idle, 0 endpoints / 0 deliveries                                                                   | DB ro counts                                                                                                                                                                          |
| Artifact storage                     | 0 artifacts                                                                                        | `artifacts` table count = 0                                                                                                                                                           |
| FFmpeg                               | installed `/usr/bin/ffmpeg` 6.1.1, **not wired** (`NLO_FFMPEG_BIN` absent)                         | `ffmpeg -version`; `.env` key list                                                                                                                                                    |
| xray (egress)                        | available, vendored                                                                                | `data/vendor/xray` 35 MB `0755` + `geoip.dat`/`geosite.dat`, `cfg/` `0700`                                                                                                            |
| Prometheus/Grafana                   | present on host (org stack, not NLO-specific)                                                      | containers `prometheus` (9090), `grafana` (3001), `node-exporter` (9100)                                                                                                              |
| Journal errors (48 h)                | none new; 3 pre-existing `Fatal Python error: _enter_buffered_busy` (worker shutdown) on Nov 14–15 | `journalctl -u nlo`                                                                                                                                                                   |

### 3.4 Data discovery

**Production (`AI-TOOLS`, sizes/permissions only — contents not read):**

| Path                                | Size / perms                                                                                                                                    | Note                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/` total                       | 242 MB                                                                                                                                          |                                                                                                                                                                                                                                              |
| `data/nlo.sqlite` (+shm/wal)        | 290 KB `0644`                                                                                                                                   | 18 tables (migrations applied); jobs **5 SUCCEEDED / 7 FAILED**, last 2026-11-20 22:53                                                                                                                                                       |
| `data/backups/`                     | 5× `nlo-*.sqlite` + 5× `env-*.env` (`0600`)                                                                                                     | `deploy/deploy.sh` retention-5                                                                                                                                                                                                               |
| `data/backups/p3-20261114T172954Z/` | `0700`, with `SHA256SUMS` manifest (4 entries: `.env`, `nlo.sqlite`, `nlo.service.unit`, `nginx-effective.conf`) + root-owned stageA vhost copy | P3 pre-cert backup                                                                                                                                                                                                                           |
| `data/sessions/`                    | `0700`, 1 file `nlo-acc_5a03a60bbda24085.json` (12 150 B, `0600`) + 2 lock files                                                                | single Google account session                                                                                                                                                                                                                |
| `data/secrets/p3/`                  | `0700`, 3 files `0600` (`bootstrap-output.txt`, `nlo-api-token`, `nlo-browser-password`)                                                        | P3 batch-3 minted material                                                                                                                                                                                                                   |
| `data/vault.key`                    | 64 B `0600`                                                                                                                                     | AES-256-GCM vault key                                                                                                                                                                                                                        |
| `data/vendor/`                      | xray 35 MB + geo files + `cfg/` `0700`                                                                                                          |                                                                                                                                                                                                                                              |
| `data/venv/`                        | Python 3.12.3, `notebooklm-py 0.8.5`                                                                                                            |                                                                                                                                                                                                                                              |
| `.env`                              | 502 B `0600`                                                                                                                                    | keys only (values not read): `NLO_HOST, NLO_PORT, NLO_PROVIDER, NLO_PYTHON_BIN, NLO_PROXY_RUNTIME, NLO_LOGIN_BROWSER, NLO_ALLOW_DIRECT_EGRESS, NLO_RADIO_BASE, NLO_RADIO_TOKEN, NLO_RADIO_TIMEOUT_MS, NLO_ORCH_NLO_TIMEOUT_MS, NLO_API_AUTH` |

**Local (workstation `data/`, 356.8 MB, 4 224 files):**
`nlo.sqlite` (same 18 tables; jobs **7 SUCCEEDED / 16 FAILED / 5 CANCELLED**,
0 artifacts, 0 tokens, 0 webhooks, 3 accounts, 2 proxy nodes),
`data/jobs/` 29 dirs / 149 MB, `data/sessions/` **3** account sessions
(28–32 KB each) + lock files, `data/vault.key`, `data/vendor/xray.exe`,
`data/venv/` (Python 3.13.15, `notebooklm-py 0.8.5`, `playwright 1.64.0`),
`data/cf-api-token` (53 B, 2026-11-14 — Cloudflare API token file, **see
§12 security note S-6**), `data/e2e-local/manual-run.ts`,
`data/backups/` 9 files (see §10) **including a copy of the P3 production
backup dir** (production `.env` copy on the workstation — S-7).

### 3.5 Network / DNS / TLS discovery

| Check                                                         | Result                                                                                                                                                                          | Label                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `nlo.ai.ismc.ir` via workstation resolver (172.22.6.1)        | `172.30.0.133`                                                                                                                                                                  | VERIFIED (internal)                  |
| `nlo2.ai.ismc.ir` via workstation resolver                    | `172.30.0.133`                                                                                                                                                                  | VERIFIED (internal)                  |
| `nlo.ai.ismc.ir` / `nlo2.ai.ismc.ir` via public DoH (1.1.1.1) | `185.213.10.25`                                                                                                                                                                 | VERIFIED (public)                    |
| `git.ai.ismc.ir` via public DoH                               | `185.213.10.25`                                                                                                                                                                 | VERIFIED                             |
| `git.ai.ismc.ir` on the server (`getent`)                     | `172.20.1.52` (stale s52)                                                                                                                                                       | VERIFIED — inconsistency B-8         |
| Split-horizon conclusion                                      | internal DNS → internal IP; public DNS → public edge; same host                                                                                                                 | VERIFIED                             |
| TCP from workstation to public `185.213.10.25`                | 80 OPEN, 443 OPEN, 4870 closed, 81/444/2222 (GitLab) closed/timeout                                                                                                             | VERIFIED                             |
| TCP from workstation to s52 `172.20.1.52`                     | 22/80/443 closed/timeout                                                                                                                                                        | VERIFIED (decommissioned, confirmed) |
| `http://nlo.ai.ismc.ir/...`                                   | `301 → https://nlo.ai.ismc.ir/...` (Stage A vhost active)                                                                                                                       | VERIFIED                             |
| `https://nlo.ai.ismc.ir/api/health`                           | `404`, served by catch-all (SNI cert `CN=admin.ai.ismc.ir`, Let's Encrypt, valid)                                                                                               | VERIFIED — **no NLO TLS**            |
| `https://nlo2.ai.ismc.ir/api/health`                          | `404`, catch-all, same cert                                                                                                                                                     | VERIFIED — **no NLO vhost at all**   |
| Server vhost dir                                              | `nlo.ai.ismc.ir.conf` present = Stage A only (`listen 80` + ACME webroot + 301; **0 occurrences of `listen 443`**, no `proxy_pass`); no `nlo2` vhost; cert dir has no nlo entry | VERIFIED                             |
| `nginx -t` (as `saber`, panel config)                         | passes with 3 pre-existing `http2` deprecation warnings (other vhosts)                                                                                                          | VERIFIED                             |
| SSH workstation → server                                      | publickey as `saber` (default Windows username **fails**: `Permission denied (publickey,password)`)                                                                             | VERIFIED                             |

### 3.6 Docker on the server (read-only `docker ps` / `docker compose ls`)

Docker 29.1.3. ~35 compose projects for other org services (litellm `:4000`,
litellm-public `:4102`, grafana `:3001`, prometheus `:9090`, node-exporter
`:9100`, rag-* stack, tasnim, llmhub, n8n, flowise, wikijs, homarr, kong,
**gitlab** (`:2222→22`, `:81→80`, `:444→443`, `:5433→5432`, `:6379→6379`),
persian-corpus-toolkit, ocr-asr, asr-proxy, q1-4get, shahrbano,
9router/agentos/ai-bot-gateway, etc.). **NLO is not containerized anywhere.**
NLO's Docker assets exist in the repo (`Dockerfile`, `docker-compose.yml` —
single-container local design, healthcheck, non-root `node` user, `./data`
volume).

---

## 4. Architecture & Dependency Map (current, as-is)

```
[Workstation, loopback]                         [AI-TOOLS 172.30.0.133]
  (dev instance: start/stop manually)             systemd nlo.service (User=saber)
                                                   ┌─────────────────────────────┐
                                                   │ Node 22 + tsx (apps/server) │
 public internet ──► 185.213.10.25:80/443         │  /api  (legacy, un-gated)   │
                        │  panel nginx (BT/aaPanel)│  /api/v1 (Bearer-token     │
   nlo.ai.ismc.ir  ──► Stage-A vhost (301→https)  │    gated: NLO_API_AUTH=1)  │
   nlo2.ai.ismc.ir ──► NO vhost (catch-all 404)   │  job queue → job stages    │
                        │                          │  └─ python worker (venv)  │
  catch-all cert CN=admin.ai.ismc.ir               │     └─ notebooklm-py 0.8.5│
                                                   │  xray tunnel (VLESS) ──────┼──► NotebookLM (Google)
  internal LAN ──► 172.30.0.133:22 (SSH)          │  artifacts: data/jobs/j_*  │
                                                   │  SQLite: data/nlo.sqlite   │
  GitLab (container, same host)                    │  vault AES-256-GCM 0600    │
   git.ai.ismc.ir ──► :2222/:81/:444 (public 80/443 edge only; gitlab ports firewalled)
```

- **Single job engine** (queue + stages + worker supervision) — no parallel
  engine exists; P5 missions must not add one (contract rule 3).
- **Contract**: `/api/v1` OpenAPI 3.0.3, title "NotebookLM Orchestrator
  API" v1.0.0, built programmatically
  ([apps/server/src/api/openapi/spec.ts](../../apps/server/src/api/openapi/spec.ts)),
  served at `/api/openapi.json` and `/api/v1/openapi.json` (91 766 B on the
  server, 45 paths — full list in §13), with a **bidirectional spec↔app drift
  test** in [apps/server/test/openapi-v1.test.ts](../../apps/server/test/openapi-v1.test.ts).
- **Deploy path (production)**: git-based via
  [deploy/deploy.sh](../../deploy/deploy.sh) (backup DB+`.env` → checkout
  commit reachable from `origin/main` → restart systemd → verify
  health/ready/port/journal). **Docker path**: repo-local single-container
  (loopback publish) — designed for local single-user, **not yet adapted for
  a Stage service** (P5-1A work).

---

## 5. Runtime & Data Evidence

### 5.1 Production live probes (from host loopback, 23:07 UTC)

```
GET /api/health       → 200 {"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-20T23:07:47.509Z"}
GET /api/health/ready → 200 {"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}
GET /api/openapi.json → 200 (91 766 B)
GET /api/docs         → 200
GET /api/v1/jobs (no token) → 401 {"error":{"code":"unauthorized","message":"API token required"}}
listening: 127.0.0.1:4870 (node pid 2809792) — no other NLO binds
```

### 5.2 Production DB (read-only, 23:07 UTC)

- Jobs: 5 SUCCEEDED / 7 FAILED; last job `j_82de2bb699ae39119386e76687ae480c`
  created 2026-11-20T22:53:48Z → FAILED 22:53:48.778Z.
- `artifacts` 0, `api_tokens` 1, `webhook_endpoints` 0, `webhook_deliveries`
  0, `accounts` 1, `proxy_nodes` 2.
- 18 tables incl. `job_stages`, `job_attempts`, `api_audit_log`,
  `proxy_health`, `proxy_health_history` (P4-1 durability schema present).

### 5.3 Why today's production job failed (evidence)

```
job_events for j_82de2bb699ae39119386e76687ae480c:
 (73, 'created',  'text job created and queued', 22:53:48.568Z)
 (74, 'validate', 'validating input',            22:53:48.767Z)
 (75, 'no_account', 'no eligible account with verified session', 22:53:48.781Z)
```

The single server-side session's `last_verified_at` is stale → the account is
ineligible. This is a **session-freshness** problem (P5-3A scope), not a
regression: the worker spawned and pinged fine at 23:07:47.

### 5.4 Workstation state

- No NLO process at mission end: `127.0.0.1:4870` and `:4871` refused
  (23:07, 23:10). Transient 4871 dev instance answered
  `{"ok":true,...}` at 23:03:35 UTC, then exited (its PID 21388 no longer
  exists).
- Local `.env` (keys/values visible, no secrets): `NLO_HOST=127.0.0.1`,
  `NLO_PORT=4870`, `NLO_PROVIDER=python-worker`, `NLO_PROXY_RUNTIME=xray`,
  `NLO_PYTHON_BIN=…data/venv/Scripts/python.exe`, `NLO_LOGIN_BROWSER=chrome`,
  `NLO_ALLOW_DIRECT_EGRESS=0`. `NLO_API_AUTH` **not set** (optional-auth
  mode; loopback trust boundary).
- Python venv local: `3.13.15`, `notebooklm-py 0.8.5`, `playwright 1.64.0`.
- No `ffmpeg`, no `docker` on the workstation.

---

## 6. Server Inventory (AI-TOOLS)

| Item              | Value                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Hostname / OS     | `AI-TOOLS`, Ubuntu 24.04.4 LTS, kernel 6.8.0-147-generic                                                         |
| CPU / RAM / Disk  | 20× Intel Xeon Gold 6458Q / 78 GiB (48 GiB available) / 686 GiB (43 % used, 380 GiB free)                        |
| Uptime / load     | 20 d 15 h / ~2.5                                                                                                 |
| NIC               | `ens33 → 172.30.0.133/20` (public face `185.213.10.25`)                                                          |
| Docker            | 29.1.3, ~35 compose projects (other org services; §3.6)                                                          |
| Node              | `/home/saber/.local/node22` v22.23.4 (not on default PATH for non-interactive shells — `deploy.sh` handles this) |
| Python            | `/usr/bin/python3` 3.12.3; NLO venv 3.12.3                                                                       |
| FFmpeg            | `/usr/bin/ffmpeg` 6.1.1                                                                                          |
| Git               | 2.43.0                                                                                                           |
| SSH               | OpenSSH 9.6p1; key auth for `saber`; host key `ssh-ed25519` (pinned in prior missions)                           |
| Sudo              | **password required** (`sudo -n true` fails) → ufw/iptables/certbot/root ops need the password or a panel route  |
| Nginx stacks      | panel nginx (public 80/443), OpenResty/Kong (saber), GitLab embedded nginx, 2 container nginx masters            |
| Org observability | prometheus :9090, grafana :3001, node-exporter :9100                                                             |

---

## 7. Deployment Topology & Data Flow (proposed target for P5, as-is vs target)

| Layer        | As-is                                               | Target (P5-1A/1B)                                                                                              |
| ------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Code         | systemd + `deploy.sh` on one host                   | same, unchanged                                                                                                |
| Runtime      | systemd `nlo` (production) + bare dev (workstation) | **Stage**: Docker Compose project `nlo-stage` (own network, own `nlo2_data` volume, own `.env`, own image tag) |
| DB           | single `data/nlo.sqlite` per install                | isolated SQLite per env (Stage `data-stage/nlo.sqlite`, Production `data/nlo.sqlite`)                          |
| Public entry | Stage-A vhost only (301)                            | Stage B vhost for `nlo2` (TLS, proxy to container port, security headers, rate limit)                          |
| TLS          | none for NLO                                        | LE DNS-01 via Cloudflare (proven script in P3 backup) for `nlo2` first, `nlo` later                            |
| Secrets      | host `.env` `0600` + `data/secrets`                 | Stage gets its own `.env` `0600`; **no secret shared between envs**                                            |

Data flow (job): UI/API (`/api/v1` token) → validate → account/session gate
→ xray tunnel → NotebookLM → artifact stored under `data/jobs/j_*/` →
`GET /api/v1/jobs/{id}/audio/download` (or artifacts endpoint) → optional
webhook outbox (0 endpoints today) → consumer (external client / future
MCP).

---

## 8. Security Matrix

| Area                        | State                                                                                                                                                                                                                                                                                    | Label                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API auth                    | Production `NLO_API_AUTH=1` → `/api/v1` requires `Authorization: Bearer nlo_…` (401 verified live); health/openapi/docs exempt by design; 1 token minted (P3, stored `0600` in `data/secrets/p3/`)                                                                                       | VERIFIED                                                               |
| Legacy UI surface           | `/api` (non-v1) **not** token-gated (documented design; trust boundary = loopback). Once public via vhost, the vhost is the only entry — but the app-level gate for non-v1 remains open → **must be covered by vhost-level auth (Basic or token rewrite) or scope restriction in P5-1A** | VERIFIED (code + docs)                                                 |
| TLS                         | **none** for NLO domains (catch-all cert answers)                                                                                                                                                                                                                                        | VERIFIED                                                               |
| Public exposure             | only 80/443 open at the edge; 4870 closed from outside; GitLab ports firewalled at the edge (81/444/2222 closed from workstation)                                                                                                                                                        | VERIFIED                                                               |
| Loopback bind invariant     | production binds `127.0.0.1:4870` only                                                                                                                                                                                                                                                   | VERIFIED                                                               |
| Secret permissions (server) | `.env` `0600`, `vault.key` `0600`, `data/sessions/` `0700` + files `0600`, `data/secrets/p3/` `0700`+`0600`, backup envs `0600`                                                                                                                                                          | VERIFIED                                                               |
| Session isolation           | 1 session file per account, vault-encrypted at rest (AES-256-GCM), lock files per account                                                                                                                                                                                                | VERIFIED (structure); **validity NOT VERIFIED** (today's `no_account`) |
| Webhook egress              | fail-closed: empty `NLO_WEBHOOK_ALLOWLIST` → dead-letter (SSRF guard); 0 endpoints registered                                                                                                                                                                                            | VERIFIED (code + DB)                                                   |
| Rate limiting               | per-token sliding window (default 120/60 s) enforced in v1; no vhost-level limit yet (none needed pre-public)                                                                                                                                                                            | VERIFIED (code)                                                        |
| CORS                        | not probed in this mission (no public consumer yet)                                                                                                                                                                                                                                      | NOT_TESTED                                                             |
| Cloudflare token            | local file `data/cf-api-token` (53 B) on the workstation — must stay out of prompts/reports; read only via protected channel when cert work happens (S-6)                                                                                                                                | VERIFIED (existence)                                                   |
| Workstation ACLs            | `.env` and `data/cf-api-token` grant `CodexSandboxUsers` read (shared-VM ACL) — tighten to owner-only (S-1)                                                                                                                                                                              | VERIFIED                                                               |
| Git TLS verify              | `http.sslverify=false` global on workstation (S-2)                                                                                                                                                                                                                                       | VERIFIED                                                               |
| Secrets in repo             | `.gitignore` covers `.env`, `data/`, `*.key`, `*.pem`; CI has a secret-scan gate (currently FAILING — see B-1, so the gate is red but present)                                                                                                                                           | VERIFIED                                                               |
| Journal/secret leakage      | redaction module present; 48 h journal shows no secret-bearing lines                                                                                                                                                                                                                     | VERIFIED (sampled)                                                     |

---

## 9. Backup Inventory (pre-existing — none created by this mission)

**Server `data/backups/`** (retention-5 from `deploy.sh`):

| File                                                                    | Size                                                                                                                                               | Date            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `env-20261027T084157Z-888e8f9.env` … `env-20261114T114000Z-278273a.env` | 262–487 B, `0600`                                                                                                                                  | Oct 27 → Nov 14 |
| `nlo-20261027…888e8f9.sqlite` … `nlo-20261114T114000Z-278273a.sqlite`   | 143 360 → 233 472 B                                                                                                                                | Oct 27 → Nov 14 |
| `p3-20261114T172954Z/` (`0700`)                                         | `.env` 487 B, `nlo.sqlite` 290 816 B, `nlo.service.unit`, `nginx-effective.conf` 52 898 B, `SHA256SUMS` (4 hashes), root-owned stageA vhost copies | Nov 14          |

Restore capability for the deploy.sh backups: **previously demonstrated**
(P3 batch reports `NLO_P3_BACKUP_AND_RECOVERY.md`, `NLO_P3_BATCH3_BACKUP_ROLLBACK.md`); not re-run in this read-only mission.

**Workstation `data/backups/`** (SHA-256 first-16, computed read-only 23:07 UTC):

| File                                              | Size                                                    | SHA-256[:16]          | Date       |
| ------------------------------------------------- | ------------------------------------------------------- | --------------------- | ---------- |
| `nlo-pre-P0-2026-11-05.bundle`                    | 656 KB                                                  | `2504C5C618442CA5`    | 2026-11-05 |
| `nlo-p1.bundle`                                   | 1006 KB                                                 | `2506B0ED60D2B541`    | 2026-11-13 |
| `nlo-p2.bundle`                                   | 1032.7 KB                                               | `D7B131DD5013BD73`    | 2026-11-13 |
| `nlo-p2-resume.bundle`                            | 1037.6 KB                                               | `920B90E8473DEDE3`    | 2026-11-13 |
| `nlo-p1-head.txt`                                 | ~0 KB                                                   | `AF2655DF97131F14`    | 2026-11-13 |
| `nlo-pre-phase2-2026-11-06T20-18Z.sqlite`         | 140 KB                                                  | `293115D3D5005877`    | 2026-10-22 |
| `nlo-pre-phase2-2026-11-06T20-18Z-wal.sqlite-wal` | 3138.3 KB                                               | `C1B5852AF04A7FC9`    | 2026-11-06 |
| `nlo-pre-retry5-2026-11-06T02-52Z.sqlite`         | 140 KB                                                  | `293115D3D5005877`    | 2026-10-22 |
| `p3-20261114T172954Z/`                            | dir (copy of server P3 backup, incl. production `.env`) | (see server manifest) | 2026-11-14 |

---

## 10. Test Results (this mission)

| Level                              | Result                 | Note                                                                                                                                       |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only probes (live)            | **PASS**               | all probes in §3/§5 executed and recorded                                                                                                  |
| Unit / Integration / E2E suites    | **NOT_TESTED**         | read-only mission; `npm test` not run (would be a state change risk? no — but out of scope; see B-1 for the CI-red fact instead)           |
| Live (NotebookLM execution)        | **NOT_TESTED**         | no job was created by this mission                                                                                                         |
| Git integrity                      | **PASS**               | `fetch` OK, `ls-remote` matches local HEAD, history linear, host↔origin ancestry verified (`rev-list` counts)                              |
| OpenAPI validity                   | **PASS (server copy)** | `200`, 91 766 B, 45 paths; spec version 3.0.3; bidirectional drift test exists in-repo (`openapi-v1.test.ts`) — **test itself not re-run** |
| Local↔server version compatibility | **PASS**               | local HEAD is a fast-forward descendant of server HEAD (12 commits, 0 divergence)                                                          |

---

## 11. Blocker List (must be resolved inside/around P5-1A or before P5-3B)

| #    | Severity | Blocker                                                                                                                                                                                                     | Evidence / owner mission                               |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B-1  | **P0**   | **GitHub CI red on `origin/main`** (`quality` + `secret scan` failing since `f07ac1f`, 3 consecutive runs). P5-1A commits cannot pass the pre-commit gate while red. Root cause not yet reproduced locally. | §3.2; fix in P5-1A step 0                              |
| B-2  | **P0**   | **No Stage at all**: `nlo2.ai.ismc.ir` has DNS but no vhost/cert/Docker/data isolation                                                                                                                      | §3.5                                                   |
| B-3  | **P0**   | **No NLO TLS**: cert issuance (Cloudflare DNS-01) never completed for either domain; Stage B never installed                                                                                                | §3.5, P3 backup scripts                                |
| B-4  | **P1**   | Production 12 commits behind `origin/main` (fast-forward ready)                                                                                                                                             | §3.2                                                   |
| B-5  | **P1**   | Production Google session unverified → jobs fail with `no_account`                                                                                                                                          | §5.3 (P5-3A scope)                                     |
| B-6  | **P1**   | FFmpeg not wired (`NLO_FFMPEG_BIN` absent) in both envs → MP3 transcode `not_configured`                                                                                                                    | §3.4                                                   |
| B-7  | **P1**   | **sudo on the server needs a password** — required for cert install, vhost activation in panel dir, `ufw` verification                                                                                      | §6 (needs owner-provided password or a delegated task) |
| B-8  | **P2**   | `git.ai.ismc.ir` internal (server-side) record still points to s52 `172.20.1.52` while the GitLab container runs on 133                                                                                     | §3.5                                                   |
| B-9  | **P2**   | GitLab sync not operational: no remote, no project, no runner (mirror inactive)                                                                                                                             | §3.2                                                   |
| B-10 | **P2**   | Workstation secret hygiene: `.env` + `cf-api-token` ACL too broad (S-1); production `.env` copy present locally (S-7); `http.sslverify=false` (S-2)                                                         | §8                                                     |
| B-11 | **P2**   | Legacy `/api` (non-v1) is un-gated at app level; a public vhost must gate or restrict it                                                                                                                    | §8                                                     |

---

## 12. Security Findings (detail)

- **S-1** (P2): workstation `.env` and `data/cf-api-token` ACL include
  `CodexSandboxUsers` (ReadAndExecute). Tighten to owner-only.
- **S-2** (P2): global `git config http.sslverify=false` on the workstation
  (known since P4-1.1 audit finding A-5, still present).
- **S-3** (P2, design): UI/legacy-API auth model = loopback trust. Acceptable
  **only** while loopback-only; the public vhost (P5-1A) must add
  application-level access control (e.g., nginx `auth_basic` for the UI
  path — material pattern already produced in NLO-P3 "Gate 2" commit
  `76cd5f0` — or token pass-through for `/api/v1`).
- **S-4** (P3): `NLO_API_AUTH=1` on production is good; but the UI (legacy
  `/api`) behind the future vhost would still be open — pair with S-3.
- **S-5** (INFO): server `.env` key list read (values not read); one key
  (`NLO_RADIO_TOKEN`) holds a third-party bearer — stays host-only. ✔
- **S-6** (P2): Cloudflare API token file lives on the workstation
  (`data/cf-api-token`). Per contract rule 8: it must be read only from the
  protected local file during P5-1A cert issuance, never pasted into a
  prompt/report/log. ✔ (file inventoried, contents not read)
- **S-7** (P2): a copy of the **production `.env`** (plus root-owned nginx
  effective config) sits in the workstation backup dir
  `data/backups/p3-20261114T172954Z/`. Consider encrypting or removing the
  copy once P3 batch-3 is closed out.
- **S-8** (P3): GitLab container publishes `5433`/`6379` on `0.0.0.0`
  (firewalled at the edge — not reachable from the workstation). Org-level,
  not NLO's, but record for the Stage/Prod network plan.
- **S-9** (P3): pre-existing worker shutdown noise
  (`Fatal Python error: _enter_buffered_busy … interpreter shutdown`) in
  journal Nov 14–15; benign at the time, but P5-3A should re-check the
  worker settle-once path on the promoted commit.
- **S-10** (P2): 8 SSH users logged in on the server; no NLO-specific
  SSH key isolation (single `saber` key). Acceptable for now; note for
  Stage isolation (Docker creds ≠ host sudo).

---

## 13. OpenAPI path inventory (live from production `/api/openapi.json`)

Spec 3.0.3 · "NotebookLM Orchestrator API" v1.0.0 · 45 paths:
`/accounts`, `/accounts/{id}`, `/accounts/{id}/default`,
`/accounts/{id}/health`, `/artifacts/{artifactId}/download`, `/audit`,
`/docs`, `/health`, `/health/account`, `/health/egress`, `/health/ready`,
`/jobs`, `/jobs/{id}`, `/jobs/{id}/artifacts`, `/jobs/{id}/artifacts/{artifactId}`,
`/jobs/{id}/attempts`, `/jobs/{id}/audio`, `/jobs/{id}/audio/download`,
`/jobs/{id}/cancel`, `/jobs/{id}/events`, `/jobs/{id}/requeue`,
`/jobs/{id}/result`, `/notebooks/from-text`, `/openapi.json`,
`/orchestrator/ask`, `/provider`, `/proxies`, `/proxies/manual`,
`/proxies/ping-all`, `/proxies/runtime`, `/proxies/{id}`,
`/proxies/{id}/connectivity`, `/proxies/{id}/health`, `/proxies/{id}/validate`,
`/secrets`, `/sessions`, `/sessions/{id}`, `/sessions/{id}/browser-import`,
`/sessions/{id}/import`, `/sessions/{id}/login`, `/sessions/{id}/refresh`,
`/sessions/{id}/verify`, `/settings`, `/tokens`, `/tokens/{id}`, `/webhooks`,
`/webhooks/{id}`, `/webhooks/{id}/deliveries`, `/webhooks/{id}/test`.

Auth-exempt GETs: `/health`, `/health/ready`, `/openapi.json`, `/docs`.
Error envelope: `{"error":{"code","message","details?"}}`
([packages/shared/src/api-error.ts](../../packages/shared/src/api-error.ts)).
Job states (state machine
[packages/shared/src/job-state.ts](../../packages/shared/src/job-state.ts)):
`queued, running, waiting, needs_attention, succeeded, failed, cancelled`
(the observed DB values map to these; P5-2A must use only these).

---

## 14. Changed Files (this mission)

| File                                               | Change                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/reports/NLO-P5-0-INFRASTRUCTURE-BASELINE.md` | **new** — this report (untracked, **uncommitted** per the P5-0 STOP rule "no commit") |

No other file touched. No code, config, service, DNS, Docker, DB, or secret
changed anywhere.

---

## 15. Backup Manifest / Restore Verification / Rollback Procedure

- **Backup manifest (created by this mission):** N/A — read-only, no new
  backup (existing inventory in §9).
- **Restore verification:** N/A (no change to restore). Pre-existing
  demonstrated restores: P3 batch reports (server DB + `.env`).
- **Rollback procedure:** N/A for this mission. Standing rollback paths:
  production = `ROLLBACK=1 bash deploy/deploy.sh <prev-commit>` + DB restore
  from `data/backups/`; workstation = git (clean tree, nothing to roll back).

---

## 16. Git Commit & Remote Status

- Local: branch `main`, HEAD `632a752` = `origin/main`; working tree clean
  (plus this one new untracked report file); **no commit made** (mission
  rule).
- `origin` (GitHub) reachable; `ls-remote` matches local.
- GitLab remote: **not configured** (honestly reported, no invention).
- No tags exist (no tagging convention yet — P4-1.1 backlog A-7).
- Push: **not performed** (no push in a read-only mission).

---

## 17. Stage & Production Recommendation + Go/No-Go

**Stage = `nlo2.ai.ismc.ir`** (per mission contract). **Production =
`nlo.ai.ismc.ir`.** Both on `AI-TOOLS`, fully isolated (separate Compose
project, network, volume, `.env`, DB, tokens, sessions, proxy assignment,
encryption key).

### Recommendation (concrete)

1. **P5-1A (Stage)** on `AI-TOOLS`:
   - Fix CI first (B-1) — the pre-commit gate requires green `npm test`,
     lint, format, typecheck, build **locally**, and the GitHub CI red must
     be diagnosed.
   - New Docker Compose project `nlo-stage` (repo `Dockerfile`/`compose`
     extended with CPU/mem limits, restart policy, log rotation, non-root,
     healthcheck — already in the repo), own volume `nlo2_data` (e.g.
     `/home/saber/nlo-stage/data`), own `.env` (`0600`), loopback-only
     publish; Stage **must not** mount or read production `data/`.
   - New vhost `nlo2.ai.ismc.ir.conf` from
     [deploy/nginx/nlo-vhost.stageB.conf.tpl](../../deploy/nginx/nlo-vhost.stageB.conf.tpl)
     (Stage A first, then DNS-01 cert with the Cloudflare token read only
     from `data/cf-api-token` on the workstation via the secure channel,
     then Stage B), proxy to the Stage container port, security headers +
     rate limit, `auth_basic` (or equivalent) for the legacy UI surface.
   - DNS for `nlo2` already exists (public + internal) — no DNS action
     needed for Stage (recorded, not changed).
2. **P5-1B (acceptance)**: independent four-path testing on Stage.
3. **Production** (`nlo.ai.ismc.ir`): keep the systemd service running as
   the de-facto production; fast-forward it (B-4) only via `deploy.sh` after
   Stage acceptance; issue its TLS cert (same mechanism); then P5-5A/B gate
   the promotion. Do **not** touch production in P5-1A.

### Go/No-Go

| Decision                                                    | Verdict                | Conditions                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proceed to **P5-1A (Stage deployment)**                     | **GO WITH CONDITIONS** | C1: fix/diagnose GitHub CI red (B-1) before committing; C2: owner provides sudo path (password or delegated task) for cert install + vhost activation (B-7); C3: Cloudflare token used only via protected file (S-6) |
| **Production** public rollout (`nlo.ai.ismc.ir` HTTPS live) | **NO-GO**              | until: Stage accepted (P5-1B), live session verified (P5-3A/B), TLS issued, promotion runbook + backup/restore verified (P5-5A)                                                                                      |
| **Production** service continuity                           | **NO-GO for changes**  | production stays as-is (running `278273a`) — no restart, no deploy, no nginx reload in P5-0/P5-1A                                                                                                                    |

---

## 18. Acceptance Matrix (P5-0 checklist)

| #   | P5-0 requirement                                                                                    | Status      | Evidence                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Find real repository + local path                                                                   | **PASS**    | §3.2 (both envs)                                                                                                                          |
| 2   | Record branch/HEAD                                                                                  | **PASS**    | §3.2                                                                                                                                      |
| 3   | Check GitHub & GitLab remotes                                                                       | **PASS**    | §3.2 (GitHub ✔; GitLab remote absent, GitLab instance up, no project — honestly reported)                                                 |
| 4   | Local/Remote/Server commit drift                                                                    | **PASS**    | §3.2 (server 12 behind, 0 ahead; local = origin)                                                                                          |
| 5   | Staged/unstaged/untracked                                                                           | **PASS**    | §3.2 (clean / 3 pre-existing untracked)                                                                                                   |
| 6   | P5 commits check                                                                                    | **PASS**    | §3.2 (none exist yet)                                                                                                                     |
| 7   | README/OpenAPI/Dockerfile/Compose/systemd review                                                    | **PASS**    | §3.6, §4, §13                                                                                                                             |
| 8   | Server identity/OS/CPU/RAM/disk                                                                     | **PASS**    | §6                                                                                                                                        |
| 9   | Docker + compose                                                                                    | **PASS**    | §3.6                                                                                                                                      |
| 10  | Containers (running/stopped)                                                                        | **PASS**    | §3.6 (read-only `docker ps`; stopped not fully enumerated — `docker ps` subset shown; sufficient for NLO scope: no NLO containers exist)  |
| 11  | systemd services                                                                                    | **PASS**    | §3.3 (`nlo` active; `llmhub-feedback` was the only failed unit in G3-A — not re-checked this mission, out of NLO scope)                   |
| 12  | Listening ports                                                                                     | **PASS**    | §3.3, §3.5                                                                                                                                |
| 13  | Nginx vhosts & upstreams                                                                            | **PASS**    | §3.5 (nlo vhost = Stage A; no upstream to 4870 anywhere)                                                                                  |
| 14  | Internal & public DNS                                                                               | **PASS**    | §3.5 (split-horizon documented)                                                                                                           |
| 15  | SSL certs & expiration                                                                              | **PARTIAL** | no NLO cert exists (VERIFIED); catch-all cert valid; per-domain expiration of the ~14 LE certs on the host not enumerated (not NLO-owned) |
| 16  | Firewall & real access                                                                              | **PARTIAL** | edge ports probed from outside (80/443 open; rest closed); `ufw`/`iptables` = **BLOCKED** (sudo password)                                 |
| 17  | Real NLO install path                                                                               | **PASS**    | §3.1                                                                                                                                      |
| 18  | DB/artifact/volume locations                                                                        | **PASS**    | §3.4                                                                                                                                      |
| 19  | File ownership & permissions                                                                        | **PASS**    | §3.4                                                                                                                                      |
| 20  | NLO API/UI/worker/provider/queue/webhooks/artifacts/ffmpeg/health                                   | **PASS**    | §3.3                                                                                                                                      |
| 21  | Prometheus/Grafana                                                                                  | **PASS**    | §3.3 (org stack present)                                                                                                                  |
| 22  | Data discovery (DBs, audio, inputs, tmp, vault, keys, backups)                                      | **PASS**    | §3.4, §9                                                                                                                                  |
| 23  | Security audit (auth, scopes, exposure, TLS, perms, sessions, rate limits, CORS, Docker/SSH access) | **PARTIAL** | §8 — CORS NOT_TESTED; API token scopes: single-scope bootstrap token (scope model minimal by design)                                      |
| 24  | Backup inventory (path/size/date/SHA/restore/history)                                               | **PASS**    | §9 (server SHA manifest pre-existing; workstation SHA-256 computed)                                                                       |
| 25  | Read-only probes + health + git integrity + OpenAPI validity + version compatibility                | **PASS**    | §10                                                                                                                                       |
| 26  | Report with all required sections                                                                   | **PASS**    | this file                                                                                                                                 |
| 27  | STOP: no install/change/restart/commit/push/deploy                                                  | **PASS**    | §14, §15, §16                                                                                                                             |

---

## 19. Remaining Backlog (hand-off to next missions)

1. **P5-1A step 0**: diagnose + fix GitHub CI red (B-1) — likely cause
   candidates (unverified): secret-scan gate vs. committed docs, or a flaky
   quality job; reproduce with local `npm run lint`/`npm test`
   (read-only-safe) before touching anything.
2. **P5-1A**: Stage Docker design (limits/limits/log rotation), isolated
   volume + `.env`, vhost Stage A→cert→Stage B, `auth_basic` for legacy UI,
   Cloudflare token channel (S-6), sudo path (B-7).
3. **P5-1B**: independent acceptance incl. "Stage must not see production
   data" negative test.
4. **P5-2A/B**: external REST client + webhook receiver (contract paths in
   §13 are the only allowed endpoints).
5. **P5-3A**: server-side session re-verify (B-5), multi-account + proxy
   registry, FFmpeg wiring decision (B-6 — server has the binary; just
   `NLO_FFMPEG_BIN` + policy), worker settle-once re-check (S-9).
6. **P5-4A/B**: event/delivery contract on the existing outbox (0 endpoints
   today → clean slate, no migration risk).
7. **P5-5A/B**: production promotion (fast-forward 12 commits via
   `deploy.sh`, cert, vhost Stage B for `nlo`, release gate).
8. **Housekeeping**: GitLab mirror project + runner decision (B-9), stale
   internal `git.ai.ismc.ir` record (B-8), workstation ACLs + `sslverify`
   (S-1/S-2), production-`.env` copy on workstation (S-7), tagging
   convention (A-7).

---

## 20. Final Verdict

**Mission P5-0 status: PASS (read-only discovery complete, all evidence
recorded, zero changes made).**

- **Stage (`nlo2.ai.ismc.ir`): GO WITH CONDITIONS** (C1–C3 in §17).
- **Production public rollout: NO-GO** (deferred to P5-5 gates).
- **Production service: as-is, untouched, healthy, loopback-only, 12
  commits behind (fast-forward ready).**
- **Highest-risk facts for the owner to see:**
  1. GitHub CI is red on `main` (3 pushes) — fix before P5-1A commits.
  2. No NLO TLS anywhere yet; the Cloudflare DNS-01 path is prepared but
     never executed; needs sudo (B-7).
  3. Production can currently not run a live job: session unverified
     (`no_account`) — P5-3A prerequisite.
  4. GitLab mirror is not operational (no project/runner/remote).

**STOP.** Awaiting owner review of the infrastructure contradictions
resolved here (server reachable ✔, NLO running on 133 ✔, Stage absent,
DNS split-horizon, GitLab status) and the P5-1A Stage approval.
