# NLO-ACCESS-REBASELINE-01 — Local/Production Discovery & Access Diagnosis

Date: 2026-11-14 (11:59–12:25 UTC / 15:29–15:55 +0330)
Mission: **NLO-ACCESS-REBASELINE-01** — read-only discovery, runtime
verification, and browser-access diagnosis for NotebookLM Orchestrator (NLO).

Companion documents (same mission):

- `NLO_LOCAL_RUNTIME_AUDIT.md`
- `NLO_PRODUCTION_RUNTIME_AUDIT.md`
- `NLO_NETWORK_AND_NGINX_AUDIT.md`
- `NLO_P2_DEPLOYMENT_VERIFICATION.md`
- `NLO_NEXT_EXECUTION_PLAN.md`

Labels used per claim: **VERIFIED / PARTIALLY VERIFIED / NOT VERIFIED /
BLOCKED / NOT IMPLEMENTED**.

---

## 1. Executive Summary

1. **Both environments are running the P2 code base.**
   - Local (Windows dev machine): running the tree of `278273a`
     (processes started 14:42/14:52 +0330, before the docs-only commit
     `4e2d533`); git HEAD is `4e2d533` (docs-only delta). **VERIFIED**
   - Production `172.30.0.133` (host `AI-TOOLS`): systemd service `nlo`
     active on `278273a` (deployed 11:40 UTC). **VERIFIED**
2. **NLO listens on port 4870 in both environments, bound to loopback
   (`127.0.0.1`) only.** Local additionally runs a dev instance on 4871
   (loopback). **VERIFIED**
3. **Why the browser cannot reach NLO (root cause, verified):**
   - `http://172.30.0.133:4870/` fails from outside the server: the port is
     loopback-bound (design invariant) AND no NAT/DNAT rule forwards 4870 —
     TCP 4870 to the server's public IP is closed. **VERIFIED**
   - `https://nlo.ai.ismc.ir` fails because **no nginx vhost exists for
     `nlo.ai.ismc.ir`** and **no TLS certificate for it is issued**. The
     domain resolves correctly to the server's public IP (`185.213.10.25`),
     but the request lands on the panel's **default/catch-all vhost**
     (cert `CN=admin.ai.ismc.ir`) which returns `307 → /login` — that is a
     different application, not NLO. **VERIFIED**
4. **The working access paths today** (no changes required):
   - From the workstation: `http://127.0.0.1:4870/` and
     `http://127.0.0.1:4871/` (local instances, verified 200).
   - From anywhere: SSH tunnel
     `ssh -N -L 4870:127.0.0.1:4870 saber@172.30.0.133` →
     `http://127.0.0.1:4870/` (SSH to the server is verified reachable).
5. **Public HTTPS access (`https://nlo.ai.ismc.ir`) is NOT IMPLEMENTED**: it
   needs (a) a panel-nginx vhost with `proxy_pass http://127.0.0.1:4870`,
   (b) a Let's Encrypt certificate for `nlo.ai.ismc.ir`, (c) nginx reload.
   Nothing was changed in this mission (read-only).
6. **Podcast pipeline readiness**: code is deployed everywhere; live
   execution is NOT VERIFIED (no audio job has ever run — 0 artifact
   records in both DBs). FFmpeg: **not installed locally**; installed on
   the server (`/usr/bin/ffmpeg` 6.1.1) but **not configured** (no
   `NLO_FFMPEG_BIN` in either `.env`) → MP3 transcode reports
   `not_configured` honestly. **VERIFIED**
7. No service was restarted, no deploy, no nginx reload, no DNS/firewall
   change, no env change, no job created, no commit/push of code. One
   commit of this mission's 6 report files was made (see §14); no push.

---

## 2. Current Local State

See `NLO_LOCAL_RUNTIME_AUDIT.md` for the full inventory.

| Item             | Value                                                                                                                                                                                 | Label                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Repo HEAD        | `4e2d533` (2026-11-14 15:11:41 +0330, docs-only)                                                                                                                                      | VERIFIED             |
| Running tree     | `278273a` (process start 14:42/14:52 +0330)                                                                                                                                           | VERIFIED             |
| Instance 1       | `127.0.0.1:4870`, node PID 2520 (tsx `apps/server/src/main.ts`)                                                                                                                       | VERIFIED             |
| Instance 2       | `127.0.0.1:4871`, node PID 21388 (same command, `NLO_PORT=4871`)                                                                                                                      | VERIFIED             |
| Binding          | `127.0.0.1` (loopback) on both                                                                                                                                                        | VERIFIED             |
| HTTP             | `/` 200, `/api/health` 200, `/api/health/ready` 200 (`ready:true`), `/api/openapi.json` 200 (91 766 B), `/api/docs` 200, `/api/v1/webhooks` 200 `{"items":[],"total":0}` — both ports | VERIFIED             |
| Worker           | python 3.13.15 venv, `notebooklm-py 0.8.5`, ping OK, clean SIGTERM                                                                                                                    | VERIFIED             |
| FFmpeg           | not in PATH; no `NLO_FFMPEG_BIN` in `.env` → `not_configured`                                                                                                                         | VERIFIED             |
| DB               | `data/nlo.sqlite`, migrations 1–6, jobs 23 (6 SUCCEEDED / 12 FAILED / 5 CANCELLED), 0 artifacts, 0 webhook endpoints, 0 deliveries                                                    | VERIFIED             |
| Sessions         | 2 NotebookLM account sessions (files present, 0700 dir)                                                                                                                               | VERIFIED (existence) |
| Non-NLO listener | `127.0.0.1:18789` = `openclaw` gateway (unrelated)                                                                                                                                    | VERIFIED             |

## 3. Current Production State

See `NLO_PRODUCTION_RUNTIME_AUDIT.md` for the full inventory.

| Item                   | Value                                                                                                                                                                                                             | Label                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Host                   | `AI-TOOLS`, Ubuntu 24.04.4 LTS, kernel 6.8.0-147-generic, up 14 d                                                                                                                                                 | VERIFIED             |
| Service                | systemd `nlo` **active** (User=saber, WorkingDirectory `apps/server`, `ExecStart=node_modules/.bin/tsx src/main.ts`, Restart=always/5 s, NoNewPrivileges, PrivateTmp)                                             | VERIFIED             |
| Repo HEAD              | `278273a` (deployed 11:40 UTC; `data/deployed-commit` = `278273a`)                                                                                                                                                | VERIFIED             |
| Process                | main PID 1260062 (tsx) → child 1260079 (node, owns the socket), started 11:40 UTC                                                                                                                                 | VERIFIED             |
| Listening              | `127.0.0.1:4870` only (no 4871, no 0.0.0.0, no server-IP bind)                                                                                                                                                    | VERIFIED             |
| HTTP (from the server) | `/` 200 (6.5 ms), `/api/health` 200 (0.9 ms), `/api/health/ready` 200 (83 ms, `ready:true`, provider python-worker, proxy xray available, `liveDisabled:true`), `/api/openapi.json` 200 (4.5 ms), `/api/docs` 200 | VERIFIED             |
| FFmpeg                 | `/usr/bin/ffmpeg` 6.1.1 installed; **no** `NLO_FFMPEG_BIN` in `.env` → not configured by the app                                                                                                                  | VERIFIED             |
| DB                     | `data/nlo.sqlite`, migrations 1–6 (0006 applied 11:40:01 UTC), jobs 11 (5 SUCCEEDED / 6 FAILED), last job SUCCEEDED 2026-11-12, 0 artifacts, 0 webhook endpoints/deliveries                                       | VERIFIED             |
| Sessions               | 1 NotebookLM account session file                                                                                                                                                                                 | VERIFIED (existence) |
| Untracked (server)     | 2 old `.bak` files (Oct 26) + `nul` (0 B, Oct 28) — pre-existing, not from this mission                                                                                                                           | VERIFIED             |
| Resources              | disk 249 G/686 G (38 %), RAM 78 Gi (54 Gi available), load ~2.7                                                                                                                                                   | VERIFIED             |

## 4. Repository State

| Item                     | Local (Windows)                                                         | Production (AI-TOOLS)                                                                             |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Path                     | `c:/Users/s.tabatabaei/Documents/saberprojects/notebooklm-orchestrator` | `/home/saber/saberprojects/notebooklm-orchestrator`                                               |
| Remote `origin`          | `https://github.com/saber13812002/notebooklm-orchestrator.git`          | same                                                                                              |
| Branch                   | `main`                                                                  | `main`                                                                                            |
| HEAD                     | `4e2d5333bd473fbfba7a91fe9893904b9c56ebf7`                              | `278273a2e9f8fabb137d6ecdb3a51c1745dd8352`                                                        |
| HEAD vs `origin/main`    | 0 / 0 (in sync; `git ls-remote` HEAD = `4e2d533`)                       | 0 / 0                                                                                             |
| Working tree             | clean (no modified/untracked/staged)                                    | 3 untracked: `connect-proxy.ts.bak-curlfix`, `job-runner.ts.bak-e2efix`, `nul` (all pre-existing) |
| GitLab remote configured | none                                                                    | none (GitLab itself runs on the same server — see §7)                                             |

Reference commit chain (all present, in order, local history):
`81e86a8 → 0c4047c → 6e09259` (P1) `→ b45dadd → 09b2b11 → 8446118 →
b6dd4c9 → e01dbc8 → 7be9c72 → 936aa34 → 5f04cb9 → 21d8090 → 6f3bd98 →
d232e5e → 278273a` (P2) `→ 4e2d533` (deploy docs). **VERIFIED**

**Audio pipeline presence:** in Local (code + runtime) and in Production
(code + runtime, deployed). The only delta between the two environments is
the docs-only commit `4e2d533`. **VERIFIED**

## 5. Runtime Process Inventory

Local (session 2, user `s.tabatabaei`), redacted, no secrets in the
command lines:

| PID                                       | Role                                          | Started (+0330) | Notes                    |
| ----------------------------------------- | --------------------------------------------- | --------------- | ------------------------ |
| 14192 → 31180 → 13988 → 20164 → **2520**  | cmd → npx → tsx cli → **node (server, 4870)** | 14:42:21–29     | owns `127.0.0.1:4870`    |
| 22644                                     | esbuild service (child of 4870 tree)          | 14:42:29        | normal tsx helper        |
| 32692 → 32624 → 31832 → 10548 → **21388** | cmd → npx → tsx cli → **node (server, 4871)** | 14:52:45–47     | owns `127.0.0.1:4871`    |
| 8916                                      | `openclaw` gateway (node)                     | —               | **not NLO** (port 18789) |

Production:

| PID         | Role                                                                                                | Started (UTC) |
| ----------- | --------------------------------------------------------------------------------------------------- | ------------- |
| 1260062     | `node …/node_modules/.bin/tsx src/main.ts` (systemd main)                                           | 11:40         |
| 1260079     | `node --require tsx preflight … src/main.ts` (child; owns `127.0.0.1:4870`)                         | 11:40         |
| (ephemeral) | python worker children spawned per readiness probe (e.g., 1260483, 1264810) — spawn→ping→clean exit | 11:40+        |

**VERIFIED**

## 6. Port Mapping

| Port  | Local bind             | Local owner                  | Production bind                    | Production owner   | External reachability                                                    |
| ----- | ---------------------- | ---------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| 4870  | `127.0.0.1` (loopback) | PID 2520 (node)              | `127.0.0.1` (loopback)             | PID 1260079 (node) | `185.213.10.25:4870` closed; `172.30.0.133:4870` closed from workstation | VERIFIED           |
| 4871  | `127.0.0.1` (loopback) | PID 21388 (node)             | not listening (connection refused) | —                  | n/a                                                                      | VERIFIED           |
| 18789 | `127.0.0.1`            | PID 8916 (openclaw, not NLO) | —                                  | —                  | n/a                                                                      | VERIFIED           |
| 80    | —                      | —                            | `0.0.0.0` (panel nginx)            | nginx master 2291  | open                                                                     | VERIFIED           |
| 443   | —                      | —                            | `0.0.0.0` (panel nginx)            | nginx master 2291  | open                                                                     | VERIFIED           |
| 444   | —                      | —                            | `0.0.0.0`                          | nginx (panel)      | 000 (no HTTP response on 444/tcp test)                                   | PARTIALLY VERIFIED |

No other NLO-related listeners exist (all node/python/xray listeners
inventoried; xray tunnels spawn on-demand on ephemeral loopback ports).
**VERIFIED**

## 7. Nginx Configuration

Full detail in `NLO_NETWORK_AND_NGINX_AUDIT.md`. Headline findings:

- The server runs **several nginx stacks**: BT/aaPanel webserver (master
  PID 2291, config `/www/server/panel/webserver/conf/webserver.conf`,
  vhosts in `/www/server/panel/vhost/nginx/`), an OpenResty/Kong instance
  (saber, ports 8000/8443), GitLab's embedded nginx, and two Docker
  container nginx masters. **VERIFIED**
- The public 80/443 are served by the **panel nginx** (vhost dir contains
  `sources.ai.ismc.ir.conf`, `tasnim.ai.ismc.ir.conf`, etc.). **VERIFIED**
- **No vhost references `nlo` or `4870`** (grep over the readable config
  dump: zero hits). **VERIFIED**
- `git.ai.ismc.ir` is served from the same panel nginx (GitLab web,
  302 → `/users/sign_in`; `/api/v4/projects?search=notebooklm` → 200 `[]`
  unauthenticated → no _public_ notebooklm project visible). GitLab
  runner unit active; omnibus `gitlab` unit reported `inactive` by
  `systemctl` while its processes run (managed outside plain systemd —
  runsv) → GitLab main service state **PARTIALLY VERIFIED**.
- **Let's Encrypt certs on the server** (panel-managed, not certbot —
  no certbot binary/cron found): admin, bot, chat2, chat, corpus, docs,
  eiis, grafana, kong, llmhub, mesbah, meshkat, rag, taghrir
  (`*.ai.ismc.ir`). **No `nlo.ai.ismc.ir` certificate exists.**
  **VERIFIED**
- `sudo -n` requires a password → direct `nginx -T` of root-only files,
  `ufw status`, `iptables`, `certbot certificates` = **BLOCKED** for this
  mission (no privilege escalation attempted).

## 8. DNS Findings

| Check                                            | Result                                                                                                                          | Label                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `nlo.ai.ismc.ir` via local resolver (172.22.6.1) | A → `185.213.10.25`                                                                                                             | VERIFIED                                                                                          |
| `nlo.ai.ismc.ir` via 1.1.1.1 and 8.8.8.8         | A → `185.213.10.25` (same) → no split-horizon difference                                                                        | VERIFIED                                                                                          |
| AAAA / CNAME                                     | none returned (A record only)                                                                                                   | VERIFIED                                                                                          |
| Reverse DNS `185.213.10.25`                      | NXDOMAIN (no PTR)                                                                                                               | VERIFIED                                                                                          |
| `185.213.10.25` = public face of AI-TOOLS        | strong evidence: public 443 serves the catch-all whose default cert `CN=admin.ai.ismc.ir` is one of the LE certs on this server | PARTIALLY VERIFIED (no direct `curl ifconfig.me` from the server — its egress proxy returned 403) |
| Workstation reachability                         | workstation IP `172.27.128.1` (different /24 group, but routed): `172.30.0.133:22` open, `:443` open, `:4870` **closed**        | VERIFIED                                                                                          |

## 9. HTTPS Findings

- `https://nlo.ai.ismc.ir/` (public): `307 → /login`, `Server: nginx`.
  Same response with `Host: admin.ai.ismc.ir` → the **default/catch-all
  vhost** answers, not an NLO vhost. **VERIFIED**
- Default server TLS cert: `CN=admin.ai.ismc.ir`, issuer Let's Encrypt
  (YE2), `Verify return code: 0` — valid for the catch-all app, **wrong
  for NLO**. **VERIFIED**
- No NLO vhost ⇒ no NLO upstream (`proxy_pass` to 4870 nowhere), no ACME
  challenge location for NLO, no NLO websocket/SSE config. **VERIFIED**
- NLO itself serves plain HTTP only (no TLS in the app) — TLS termination
  must happen at a proxy (panel nginx) if public access is wanted.
  **VERIFIED** (code: loopback HTTP server; no cert handling).

## 10. Application Health

| Probe                 | Local 4870                   | Local 4871             | Server (from server)                                         |
| --------------------- | ---------------------------- | ---------------------- | ------------------------------------------------------------ |
| `/` (web UI shell)    | 200 (490 B)                  | 200 (490 B, same etag) | 200 (6.5 ms)                                                 |
| `/api/health`         | 200                          | 200                    | 200                                                          |
| `/api/health/ready`   | 200 `ready:true`             | 200 `ready:true`       | 200 `ready:true` (83 ms)                                     |
| `/api/openapi.json`   | 200 (91 766 B)               | 200                    | 200 (4.5 ms)                                                 |
| `/api/docs` (Swagger) | 200                          | 200                    | 200                                                          |
| `/api/v1/webhooks`    | 200 `{"items":[],"total":0}` | 200                    | (route present in deployed spec; not re-probed this mission) |

Ready payload (identical on both environments): provider
`python-worker` configured, no issues; `proxyRuntime xray: available`;
`liveDisabled: true`. **VERIFIED**

Real UI paths (from code, [`apps/server/src/api/v1.ts`](apps/server/src/api/v1.ts)):
`/api/openapi.json`, `/api/v1/openapi.json`, `/api/docs`,
`/api/v1/docs` (all auth-exempt GETs); the SPA shell at `/`. No other
documented UI path exists (e.g., there is **no** top-level `/openapi.json`
contract path in the spec; the local probe of it returning 200 is the SPA
fallback, not an API contract). **VERIFIED**

## 11. Database Findings

Read-only queries only (`mode=ro`), no rows touched.

| Metric                                                     | Local `data/nlo.sqlite`                             | Production `data/nlo.sqlite`                   |
| ---------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Engine / file                                              | SQLite (node:sqlite), `data/nlo.sqlite` (+ wal/shm) | same                                           |
| Migrations                                                 | 1–6                                                 | 1–6 (0006 applied at deploy boot 11:40:01 UTC) |
| Webhook tables                                             | `webhook_endpoints`, `webhook_deliveries`           | same                                           |
| Jobs total                                                 | 23                                                  | 11                                             |
| SUCCEEDED / FAILED / CANCELLED / RUNNING / NEEDS_ATTENTION | 6 / 12 / 5 / 0 / 0                                  | 5 / 6 / 0 / 0 / 0                              |
| Last job                                                   | SUCCEEDED 2026-11-10 (`j_599f…d66c`)                | SUCCEEDED 2026-11-12 (`j_f9a4…96cc`)           |
| Artifacts                                                  | 0                                                   | 0                                              |
| Webhook endpoints / deliveries                             | 0 / 0                                               | 0 / 0                                          |
| Job dirs on disk                                           | 23 (`data/jobs/`)                                   | 5+ (`data/jobs/`)                              |
| Session files                                              | 2 accounts (names redacted) + locks                 | 1 account file                                 |

Interpretation: **no audio/podcast job has ever completed** in either
environment (0 artifacts; artifact rows are only written by the P2 audio
pipeline). All successful jobs are pre-P2 text jobs. **VERIFIED**

## 12. P1/P2 Deployment Comparison

Full matrix in `NLO_P2_DEPLOYMENT_VERIFICATION.md`.

| Item                                | Local                                                                                                  | Production                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Repo SHA (git HEAD)                 | `4e2d533` (docs-only ahead)                                                                            | `278273a`                                                                            |
| Running tree                        | `278273a` (process start predates `4e2d533`)                                                           | `278273a`                                                                            |
| P1 (E2E runner, contract)           | installed (code)                                                                                       | installed (code)                                                                     |
| P2 audio pipeline                   | installed (code)                                                                                       | installed (code + deployed)                                                          |
| Worker audio ops (`generate_audio`) | present in `nbl_worker.py` (1 use of `artifacts.generate_audio`)                                       | present (same file, same count)                                                      |
| Webhook module                      | running (dispatcher started at boot)                                                                   | running (dispatcher started at boot; tables exist)                                   |
| OpenAPI P2 paths                    | `/jobs/{id}/audio/download`, `/artifacts/{artifactId}/download`, `/webhooks*` (verified via live spec) | same deployed spec                                                                   |
| E2E runner (`nlo-e2e.ts`)           | present                                                                                                | present                                                                              |
| FFmpeg                              | **not installed** (PATH); not configured                                                               | **installed** 6.1.1 (`/usr/bin/ffmpeg`) but **not configured** (no `NLO_FFMPEG_BIN`) |
| Node                                | v24.14.0                                                                                               | v22.23.4 (user-local)                                                                |
| Python (venv)                       | 3.13.15                                                                                                | 3.12.3                                                                               |
| notebooklm-py                       | 0.8.5                                                                                                  | 0.8.5                                                                                |
| DB / artifact storage               | `data/nlo.sqlite`, `data/jobs/`                                                                        | `data/nlo.sqlite`, `data/jobs/`                                                      |

Conclusion: **P2 is installed in both environments; the production host
is the one where a live acceptance could run (xray available, ffmpeg
binary present, session present).** Live execution: NOT VERIFIED.

## 13. Root Cause Analysis (browser inaccessibility)

Scenario matrix (12 hypotheses from the brief):

| #   | Hypothesis                 | Evidence                                                                                                                                         | Probability                                                      | Status             | User impact                                                            | Recommended fix                                                                 |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Service not running        | both services up, all probes 200                                                                                                                 | excluded                                                         | VERIFIED (false)   | —                                                                      | —                                                                               |
| 2   | Loopback-only binding      | `127.0.0.1:4870` on server; workstation TCP 4870 closed                                                                                          | **primary cause for direct-IP access**                           | VERIFIED           | `http://172.30.0.133:4870` never works from outside the box            | use SSH tunnel, or add a proxy vhost (fix #4/#5)                                |
| 3   | Wrong port                 | 4870 is the configured port everywhere; 4871 is local-dev only                                                                                   | excluded                                                         | VERIFIED (false)   | —                                                                      | —                                                                               |
| 4   | Nginx upstream wrong       | **no NLO vhost exists at all** (no `nlo`/`4870` in config dump)                                                                                  | **primary cause for domain access**                              | VERIFIED           | `https://nlo.ai.ismc.ir` hits the catch-all app (`307 /login`)         | create vhost `nlo.ai.ismc.ir` → `proxy_pass http://127.0.0.1:4870`              |
| 5   | Nginx vhost disabled       | n/a — vhost absent                                                                                                                               | subsumed by #4                                                   | VERIFIED           | same                                                                   | same                                                                            |
| 6   | DNS wrong                  | A → `185.213.10.25` on local + 2 public resolvers; that IP is (very likely) this server's public face                                            | excluded                                                         | VERIFIED (false)   | —                                                                      | —                                                                               |
| 7   | Firewall blocks path       | public 80/443 open, 4870 closed; host `ufw`/`iptables` not readable without sudo                                                                 | possible contributor for :4870 (indistinguishable from NAT here) | PARTIALLY VERIFIED | direct :4870 to public IP stays closed                                 | if direct :4870 is ever wanted: open in firewall **and** DNAT; otherwise ignore |
| 8   | TLS problem                | catch-all cert valid but wrong name; **no NLO cert exists**                                                                                      | **primary cause for HTTPS on the domain**                        | VERIFIED           | browser shows the wrong app (or cert mismatch if NLO cert were served) | issue LE cert for `nlo.ai.ismc.ir` (panel ACME)                                 |
| 9   | Application internal error | all endpoints 200; ready:true; no new errors in journal since restart                                                                            | excluded                                                         | VERIFIED (false)   | —                                                                      | —                                                                               |
| 10  | New version not deployed   | server runs `278273a` = P2 HEAD (code); local `4e2d533` = +docs                                                                                  | excluded                                                         | VERIFIED (false)   | —                                                                      | —                                                                               |
| 11  | Wrong UI path              | `/` → 200 SPA shell; `/api/docs` → 200 on both                                                                                                   | excluded                                                         | VERIFIED (false)   | —                                                                      | use `http://<host>:4870/` or the tunnel                                         |
| 12  | Frontend build incomplete  | `apps/web/dist` served identically (490 B index, same etag) local & server; dist present on server (mtime Oct 25 = last dist-affecting checkout) | no evidence of breakage                                          | PARTIALLY VERIFIED | none observed                                                          | —                                                                               |

**Root cause statement:** the application is healthy and up-to-date in
both environments. Browser access fails because (a) NLO is
loopback-only by design (no route to 4870 from any network) and (b)
`nlo.ai.ismc.ir` has no dedicated vhost/certificate, so the domain lands
on an unrelated default app. **VERIFIED**

## 14. Evidence Table

All raw commands and outputs are recorded in the companion audits.
Selection (all executed 2026-11-14, 11:59–12:25 UTC):

| Claim                 | Command (abbrev.)                                                                    | Observed                                                          |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| local processes/ports | PowerShell `Get-CimInstance Win32_Process` + `Get-NetTCPConnection`                  | PIDs 2520/21388; `127.0.0.1:4870`, `127.0.0.1:4871`               |
| local HTTP            | `curl` per path                                                                      | 200s incl. `/api/v1/webhooks` `{"items":[],"total":0}`            |
| local versions        | `node -v`, `data/venv/Scripts/python -m pip show notebooklm-py`, `where ffmpeg`      | v24.14.0, 0.8.5, ffmpeg missing                                   |
| local DB              | python `sqlite3 mode=ro`                                                             | migrations 1–6; 23 jobs; 0 artifacts                              |
| server identity       | `hostname; /etc/os-release; uname -r; uptime; df; free`                              | AI-TOOLS, 24.04.4, 6.8.0-147, up 14 d                             |
| server service        | `systemctl cat nlo; systemctl show nlo`                                              | unit as §3; active                                                |
| server process        | `ps -ef                                                                              | grep 1260062`                                                     | 1260062 → 1260079 (socket owner)      |
| server ports          | `ss -ltnp`                                                                           | `127.0.0.1:4870` node 1260079; no 4871; 80/443/444 0.0.0.0        |
| server HTTP           | `curl -w time` per path                                                              | 200s as §10                                                       |
| server versions       | `node -v; venv python --version; pip show; which ffmpeg`                             | v22.23.4, 3.12.3, 0.8.5, `/usr/bin/ffmpeg` 6.1.1                  |
| server repo           | `git log -1; git status --short; rev-list --left-right`                              | `278273a`; 3 untracked; 0/0                                       |
| server DB             | python `sqlite3 mode=ro`                                                             | migrations 1–6; 11 jobs; 0 artifacts                              |
| env keys (names only) | `grep -oE '^[A-Z0-9_]+=' .env` (both envs)                                           | keys as §3/§12; no values printed                                 |
| nginx                 | process list; `nginx -T` (readable); grep `nlo                                       | 4870`                                                             | no NLO vhost; panel nginx owns 80/443 |
| certs                 | `ls /etc/letsencrypt/live`                                                           | 14 `*.ai.ismc.ir`; no `nlo`                                       |
| SNI test              | `openssl s_client -servername nlo.ai.ismc.ir` → `CN=admin.ai.ismc.ir` (LE, verify 0) | catch-all answers                                                 |
| redirects             | `curl -D - -H 'Host: nlo.ai.ismc.ir'` (80 & 443, from server + public)               | `301`/`307 → /login`                                              |
| GitLab                | `git.ai.ismc.ir` probes; `/api/v4/projects?search=notebooklm`                        | web 302 sign_in; search 200 `[]`                                  |
| DNS                   | `nslookup` local / 1.1.1.1 / 8.8.8.8; reverse                                        | A `185.213.10.25` everywhere; no PTR                              |
| TCP matrix            | PowerShell `Test-NetConnection` (workstation + public)                               | 172.30.0.133: 22 ✓ 443 ✓ 4870 ✗; 185.213.10.25: 80 ✓ 443 ✓ 4870 ✗ |

Secret handling: only env **key names** were printed; no `.env` values,
no session contents, no VLESS URIs, no tokens. **VERIFIED**

## 15. Security Findings

- Loopback-only binding holds on both environments (security invariant
  intact). **VERIFIED**
- No secrets in the collected evidence (key names only). **VERIFIED**
- Server unit has `NoNewPrivileges=true`, `PrivateTmp=true`. **VERIFIED**
- Data dirs: `data/sessions` contains account session files (0700
  convention per docs; not re-stat'd this mission — PARTIALLY VERIFIED).
- Public exposure today: the catch-all app (admin.ai.ismc.ir) is what the
  public internet can see on 80/443; NLO itself is not publicly
  reachable. **VERIFIED**
- 3 untracked files on the server (2 `.bak`, 1 empty `nul`) are inside
  the repo dir but git-ignored from the commit (untracked only).
  **VERIFIED**
- `client_max_body_size 50m` in the panel nginx global config — relevant
  if large audio uploads ever pass through a proxy vhost (NLO's own
  upload limit is configured in-app). **VERIFIED**

## 16. Local Recovery Plan

Local is currently **up** — no recovery needed. If an instance dies:

1. Prerequisites: repo at a P2 commit (currently `4e2d533`), `data/venv`
   present, `.env` present (it is).
2. Start: `set NLO_PORT=4870&& npx tsx apps/server/src/main.ts`
   (and `NLO_PORT=4871` for the dev instance).
3. Health: `curl http://127.0.0.1:4870/api/health/ready` → expect
   `{"ok":true,"ready":true,…}`.
4. Rollback: stop the instance (Ctrl+C / terminate PID); no state change
   occurs merely by running (DB writes only when jobs are created).

Required permissions: none (all local).

## 17. Production Recovery Plan

Production is currently **healthy** — no recovery needed. If the service
were down: `sudo systemctl restart nlo` (requires sudo). If a bad
deployment: `ROLLBACK=1 bash deploy/deploy.sh 8abf18aea5ff2356f37f1eee779cd35c531b29a9`
(previous good). DB restore: `data/backups/` (deploy-time backups
`nlo-20261114T114000Z-278273a.sqlite` + `.env`). Estimated downtime for a
re-deploy: ~30–60 s (observed deploy restart+ready ≈ 10 s). Acceptance:
the §10 probe set from the server.

Required permissions: `sudo` (systemctl), or an account with restart
rights for `nlo`.

## 18. Public Access Plan (`https://nlo.ai.ismc.ir`)

Nothing implemented yet (NOT IMPLEMENTED). Two tiers:

**Tier A — zero infra change (works today):**
`ssh -N -L 4870:127.0.0.1:4870 saber@172.30.0.133` then
`http://127.0.0.1:4870/`. Permissions: existing SSH key (verified).

**Tier B — panel nginx vhost + LE cert (recommended, ~15 min, needs
approval):**

1. BT-panel (or root shell): create vhost `nlo.ai.ismc.ir`:
   `listen 443 ssl; server_name nlo.ai.ismc.ir; location / { proxy_pass
http://127.0.0.1:4870; proxy_set_header Host $host; proxy_read_timeout
300s; }` (+ ACME challenge location + LE cert via panel).
2. `nginx -t` (read-only check) then `systemctl reload nginx` (or panel
   reload) — the only non-read-only step.
3. Verify from outside: `https://nlo.ai.ismc.ir/api/health/ready`.
4. Rollback: delete vhost file + reload; cert can stay.
5. Auth note: NLO without `NLO_API_AUTH` enforces no token — acceptable
   for internal use; for internet exposure, consider an auth proxy layer
   first (security invariant: non-loopback bind ⇒ auth-capable proxy).

Required permissions: root/sudo on AI-TOOLS (or BT-panel credentials) and
authority to issue the LE cert for `nlo.ai.ismc.ir`.

## 19. Podcast Acceptance Readiness

Target flow: Text/Audio → Notebook → Deep Dive → Podcast → MP3 → Download
→ Webhook. **No job was created during this mission.**

| Capability                                   | Status                                                                                                   | Label                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| UI accessible                                | local ✓ (200); server ✓ internally; public ✗ (no vhost)                                                  | PARTIALLY VERIFIED                    |
| API accessible                               | local ✓; server ✓ (loopback); public ✗                                                                   | PARTIALLY VERIFIED                    |
| OpenAPI valid                                | ✓ 200, 91 766 B, P2 paths present (live spec)                                                            | VERIFIED                              |
| Auth session (NotebookLM)                    | 2 session files local, 1 server (freshness/validity unknown — no session op run)                         | PARTIALLY VERIFIED                    |
| Proxy health                                 | `proxyRuntime: xray available` (both)                                                                    | VERIFIED (runtime); tunnels on demand |
| Notebook creation                            | P2 code deployed; last live successes were pre-P2 text jobs (2026-11-10 local / 2026-11-12 server)       | PARTIALLY VERIFIED                    |
| Text source upload                           | route present (pre-P2, previously live-verified)                                                         | PARTIALLY VERIFIED                    |
| Audio source upload                          | route present (pre-P2)                                                                                   | PARTIALLY VERIFIED                    |
| Deep Dive instruction                        | in deployed job engine                                                                                   | NOT VERIFIED (live, post-deploy)      |
| Audio generation / status polling / download | P2 worker ops present in deployed tree (`generate_audio` in `nbl_worker.py`); never executed             | NOT VERIFIED                          |
| FFmpeg                                       | local: not installed; server: installed 6.1.1 but **not configured** (no `NLO_FFMPEG_BIN`)               | VERIFIED (gap)                        |
| MP3 56 kbps                                  | blocked by the FFmpeg-config gap in both envs                                                            | NOT VERIFIED                          |
| Artifact storage                             | dirs exist; 0 artifact rows                                                                              | VERIFIED (empty)                      |
| Download API                                 | route live in spec (`/artifacts/{id}/download`, `/jobs/{id}/audio/download`); no artifact to exercise it | PARTIALLY VERIFIED                    |
| Webhook delivery                             | dispatcher running, outbox empty (0/0)                                                                   | VERIFIED (idle)                       |
| External E2E runner                          | `nlo-e2e.ts` present; local mock env 2/2 green at last full run                                          | VERIFIED (mock level)                 |

**Blocking gaps for a live acceptance run (in order):** (1) FFmpeg
configuration (server: set `NLO_FFMPEG_BIN=/usr/bin/ffmpeg` — an env
change requiring approval; local: install ffmpeg), (2) a live
NotebookLM session on the server, (3) access path (tunnel or vhost).
Nothing in this mission changed any of these.

## 20. Required User Permissions (for the next phase)

| Action                         | Permission needed                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| SSH tunnel use                 | none (existing key)                                                                                          |
| Live acceptance on server      | approval to run `nlo-e2e.ts` / one text job against live NotebookLM; server sudo only if a restart is needed |
| FFmpeg config (server)         | approval to edit `data/.env` (add `NLO_FFMPEG_BIN`) + `systemctl restart nlo` (sudo)                         |
| FFmpeg install (local)         | approval to install ffmpeg on the workstation                                                                |
| Public access (Tier B)         | root/BT-panel on AI-TOOLS + LE cert issuance for `nlo.ai.ismc.ir` + nginx reload                             |
| Direct public :4870 (optional) | firewall/DNAT authority (host firewall state currently BLOCKED to read)                                      |

## 21. Rollback Plan

- This mission changed **nothing** runtime: no restart, no env, no
  config, no data. The only change is the addition of 6 report files,
  committed (see below) — revert with a single `git revert` if ever
  desired. **VERIFIED**
- Production rollback anchor (unchanged): `8abf18a` (previous good before
  the P2 deploy) via `ROLLBACK=1 bash deploy/deploy.sh <sha>`; DB restore
  from `data/backups/`.
- Local: stop processes; `data/` untouched by this mission (read-only
  DB queries, no job creation).

## 22. Final Verdict

| Question                        | Answer                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where is NLO installed?         | Local dev machine (Windows) + `172.30.0.133` (AI-TOOLS)                                                                                          |
| Which version runs where?       | Local: `278273a` tree (git HEAD `4e2d533` docs-only). Production: `278273a`                                                                      |
| Which port?                     | 4870 in both; +4871 local dev only                                                                                                               |
| Which binding?                  | `127.0.0.1` loopback in all cases                                                                                                                |
| How to reach it?                | Local: `http://127.0.0.1:4870/` / `:4871/`. Production: SSH tunnel `ssh -N -L 4870:127.0.0.1:4870 saber@172.30.0.133` → `http://127.0.0.1:4870/` |
| Why can't the browser reach it? | Loopback-only bind (by design) + no NLO nginx vhost + no NLO TLS cert for `nlo.ai.ismc.ir` (domain resolves fine; hits the catch-all app)        |
| Nginx/TLS state                 | panel nginx serves 80/443; no NLO vhost; no NLO LE cert (14 other `*.ai.ismc.ir` certs present)                                                  |
| P2 deployment state             | installed + deployed in both environments; live acceptance NOT VERIFIED                                                                          |
| DB / artifact storage           | healthy, migrations 1–6 in both; 0 artifacts; webhook outbox empty                                                                               |
| Corrective plan                 | 3 levels in `NLO_NEXT_EXECUTION_PLAN.md` with required permissions                                                                               |

**Final status label: `NLO_ACCESS_REBASELINE_COMPLETE — WAITING FOR USER
APPROVAL`.**

Git (this mission): 6 new report files added and committed as one
docs-only commit (no push; `origin/main` was `4e2d533` before the commit).
Working tree clean apart from the commit itself.
