# NLO-P3 — Phase 0 Preflight (read-only discovery)

Mission: **NLO-P3-PRODUCTION-LAUNCH-2026-11** — Batch 1.
Date: 2026-11-14, ~17:00–17:25 UTC. All commands read-only.
Labels: **VERIFIED** (observed now) / **PARTIALLY VERIFIED** / **NOT VERIFIED** / **BLOCKED**.

---

## 1. Git state reconciliation (VERIFIED, live)

| Location                                         | HEAD      | Notes                                                                   |
| ------------------------------------------------ | --------- | ----------------------------------------------------------------------- |
| Local Windows (`C:\...\notebooklm-orchestrator`) | `e56c0a8` | docs-only rebaseline commit; **1 ahead of origin/main**, nothing behind |
| `origin/main` (GitHub)                           | `4e2d533` |                                                                         |
| Production `172.30.0.133` repo                   | `278273a` | 0/0 vs its origin ref at last deploy                                    |
| `data/deployed-commit` (prod)                    | `278273a` | matches production HEAD                                                 |

- The discrepancy noted in the mission (`e56c0a8` vs `4e2d533`) is resolved:
  `278273a` = deployed app code (P1+P2), `4e2d533` = deploy-evidence docs commit,
  `e56c0a8` = rebaseline docs commit (local only, unpushed).
- Production untracked (pre-existing, **kept**): `connect-proxy.ts.bak-curlfix`,
  `job-runner.ts.bak-e2efix`, `nul`.
- Local untracked: none (the Cloudflare token file lives in gitignored
  `data/cf-api-token`).
- **No source changes are planned for this mission** → no push required;
  docs commits stay local until explicitly approved.

## 2. Host & service (VERIFIED — live probes)

- Host `AI-TOOLS`, Ubuntu 24.04.4 LTS, kernel 6.8.0-147-generic.
- Disk: 686 G / 250 G used (38 %) → 409 G free. RAM: 78 Gi, 54 Gi available.
- `nlo.service`: **active (running)**; MainPID tsx → node child owns
  **`127.0.0.1:4870`** only. `NLO_HOST=127.0.0.1`, `NLO_PORT=4870` in
  `/home/saber/saberprojects/notebooklm-orchestrator/.env`.
- Env file: the unit has **no `EnvironmentFile`**; the app itself reads
  `<repo>/.env` via `loadDotEnv()` ([apps/server/src/config.ts:129](apps/server/src/config.ts:129))
  — verified in code.
- `.env` key names (prod, values not printed): `NLO_HOST`, `NLO_PORT`,
  `NLO_PROVIDER` (=python-worker), `NLO_PROXY_RUNTIME` (=xray),
  `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`, `NLO_ALLOW_DIRECT_EGRESS`,
  `NLO_RADIO_BASE/TOKEN/TIMEOUT_MS`, `NLO_ORCH_NLO_TIMEOUT_MS`.
  Missing: `NLO_FFMPEG_BIN`, `NLO_API_AUTH`, `NLO_LIVE_TESTS`.
- `liveDisabled:true` in the ready payload = `NLO_LIVE_TESTS` unset
  ([config.ts:227](apps/server/src/config.ts:227)). **Code-verified: the flag
  is display-only** (used in health/provider endpoints + startup log only);
  the real python-worker provider is already active (11 real jobs executed,
  5 SUCCEEDED 2026-11-12). No env change needed for live execution.

### Readiness (prod, VERIFIED)

```json
{
  "ok": true,
  "ready": true,
  "provider": { "name": "python-worker", "configured": true, "issues": [] },
  "proxyRuntime": { "state": "available", "name": "xray" },
  "liveDisabled": true
}
```

### NotebookLM session (prod, VERIFIED)

- Account `acc_5a03a60bbda24085` (`saber.tabataba@gmail.com`, imported),
  session `sess_013327da4aff48eb` state `AUTHENTICATED`,
  `lastVerifiedAt` 2026-11-12T21:11:30Z → `sessionUsable:false` **only
  because** the 10-minute TTL in
  [auth-sessions.repo.ts:131](apps/server/src/domain/auth-sessions.repo.ts:131)
  has lapsed (expected after 2 days).
- **Live health check just executed (read-only):**
  `POST /api/accounts/{id}/health` → `ok:true, email verified against
service (185 notebooks)`. The Google session file is valid.
- Before the real job: run `POST /api/sessions/{id}/verify` (the app's own
  refresh op) to update `lastVerifiedAt`. No re-login needed.

## 3. Nginx architecture (VERIFIED)

Active listener on **:80/:443 = `/www/server/nginx/sbin/nginx`
(nginx 1.31.4, master PID 199642, root, started Nov 2)**, config
`/www/server/nginx/conf/nginx.conf`, which includes
`/www/server/panel/vhost/nginx/*.conf` (plus
`well-known/ai.ismc.ir.conf` and `extension/ai.ismc.ir/*.conf`).

Other nginx stacks (NOT to be touched): panel "webserver" (PID 2291,
legacy, not bound to 80/443), OpenResty/Kong (8443/8000), GitLab embedded,
2× container nginx.

- **No NLO vhost exists**: `nginx -T | grep -E 'nlo|4870'` → zero matches.
- Public today: `http://nlo.ai.ismc.ir` → 301 → `https://…` → **admin app
  catch-all** (SNI `nlo.ai.ismc.ir` → cert CN=`admin.ai.ismc.ir`, LE, valid
  to 2027-01-01) → `/api/*` answers 404 in Persian ("مورد مورد نظر یافت
  نشد") = admin app, not NLO.
- ACME: certbot 2.9.0 installed; 14 live LE certs (`.ai.ismc.ir`); renewal
  pattern = **webroot `/www/acme`** (owned by `saber`, contains
  `.well-known/`); LE account `5b51c0b7…` (ecdsa).
- Vhost dir `/www/server/panel/vhost/nginx/` is **root-owned** (saber cannot
  `ls` or write there).

### Permission model on the host (VERIFIED)

`sudo -n -l` for `saber`:

- **NOPASSWD**: `/usr/sbin/nginx`, `/usr/bin/nginx`,
  `/www/server/nginx/sbin/nginx` (→ `-t`, `-s reload` work),
  `systemctl` (→ `restart nlo` works), `ss`, `journalctl`, `chmod`.
- Everything else needs the sudo password **or** the **docker group**
  (saber is in `docker`) → root-equivalent file writes and certbot via
  `docker run --rm -v …`. Both are standard host mechanisms; **no sudo
  password is required** for any P3 operation. (Owner may still supply the
  password if preferred.)

## 4. Cloudflare (VERIFIED via API, token used from gitignored

`data/cf-api-token` — never printed, never committed)

- Token `cfut_…` **valid and active** (`/user/tokens/verify` →
  success, id `db76fa1dff425c0ac24186600f8b18ff`).
- **Scope is verify-only**: `/accounts` → 0, `/zones` → 0,
  `/zones/ismc.ir` → 7003, `/user` → 9109, token detail → 9109/10404.
  The token **cannot** read zone DNS, create Access apps, or change proxy
  state.
- Zone: `ismc.ir` (NS `indie/langston.ns.cloudflare.com`, SOA via 8.8.8.8).
  `nlo.ai.ismc.ir` A → `185.213.10.25` (correct, unchanged).
- **The record is NOT proxied** (grey cloud): no `cf-ray` header, direct
  `Server: nginx`. → Cloudflare Access and Origin-CA/Full-strict are
  **not currently usable** (they require the record to be proxied); that
  is a dashboard change, not doable with this token.

**Consequence (decision for the owner, see §9):** the minimum viable
public stack is **Let's Encrypt at origin (webroot, existing pattern) +
nginx auth_basic + app-level API tokens**, all doable with existing
NOPASSWD/docker permissions. Cloudflare Access becomes an optional
enhancement (owner dashboard) once the record is proxied.

## 5. Authentication findings (VERIFIED from code + live DB)

- **App-level (machine-to-machine):** complete and deployed.
  `/api/v1` bearer auth (`Authorization: Bearer nlo_…`), scope model,
  per-token rate limit, audit log, token CRUD + first-admin bootstrap CLI
  ([bootstrap-first-admin.ts](apps/server/scripts/bootstrap-first-admin.ts)).
  Exempt GETs: health, openapi.json, docs. Enforcement switch:
  `NLO_API_AUTH` (**currently unset** → tokens optional, attribution only).
  Prod DB `api_tokens`: **0 rows** → bootstrap has not run.
- **Browser/UI:** the SPA calls the **legacy `/api/*` surface with NO auth
  header** ([api.ts](apps/web/src/lib/api.ts)) — correct for loopback,
  **insufficient for public exposure**. There is no SPA login.
- CORS: permissive `Vary: Origin` on the API (fine same-origin; the public
  path is same-origin via the vhost).
- **Planned browser layer (no source change):** nginx `auth_basic`
  (htpasswd, strong password) on the NLO vhost for all paths, plus
  `NLO_API_AUTH=1` so `/api/v1` machine calls require bearer tokens.
  Artifacts/jobs/swagger all sit behind the vhost auth automatically.
- The Cloudflare token and the NLO API token are **different secrets**
  (documented in the API guide; no overlap).

## 6. FFmpeg (VERIFIED)

- `/usr/bin/ffmpeg` present, **6.1.1**, executable. `NLO_FFMPEG_BIN`
  absent → adapter reports `not_configured`
  ([config.ts:232](apps/server/src/config.ts:232)).
- Plan: add `NLO_FFMPEG_BIN=/usr/bin/ffmpeg` to the prod `.env` (after
  backup), restart `nlo.service`, verify adapter + real transcode.

## 7. Backup inventory (VERIFIED)

`/home/saber/saberprojects/notebooklm-orchestrator/data/backups/`:

- `nlo-20261114T114000Z-278273a.sqlite` (+ `.env` twin) — from today's
  11:40Z deploy (current good).
- 4 older DB backups (2026-10-27 ×2, 2026-10-28, 2026-11-04).
- deploy.sh retains the newest N of each kind.
- **Phase 1 will add** a dedicated P3 recovery-point set: DB (sqlite3
  `.backup` — WAL-safe), `.env`, `nlo.service`, the full active vhost
  dir (tar), and the nginx main conf — with SHA-256 checksums, `0600`,
  outside the web root.

## 8. Blockers & open items

| #   | Item                           | State                                                                                                                          |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | CF token has verify-only scope | **Accept for now** (DNS needs no change; TLS via LE at origin). CF Access/proxy = owner dashboard work, optional.              |
| 2   | Browser auth design            | **Decision needed from owner**: proposed = nginx `auth_basic` with a strong password (I can generate; owner confirms/chooses). |
| 3   | `api_tokens` empty in prod     | Resolved by running `bootstrap-first-admin.ts` (service stop → CLI → start) in Batch 2.                                        |
| 4   | Session TTL lapse              | Resolved by `POST /api/sessions/{id}/verify` before the real job (Batch 5).                                                    |
| 5   | Sudo password                  | Not required (NOPASSWD + docker cover everything).                                                                             |
| 6   | Unrelated vhosts/DNS           | Touched by nothing; only `nlo.ai.ismc.ir` vhost is added.                                                                      |

## 9. Planned changes (exact, per batch)

1. **Backup** (Phase 1): recovery-point set in
   `data/backups/p3-<ts>/` with checksums.
2. **Auth** (Phase 2): create `.htpasswd` (0600) in
   `/etc/nginx/` (via docker copy); `NLO_API_AUTH=1` in `.env`;
   run first-admin bootstrap → store token in prod `.env`-adjacent
   secret file (0600, not git); restart `nlo`.
3. **TLS + vhost** (Phase 3): write
   `/www/server/panel/vhost/nginx/nlo.ai.ismc.ir.conf` (rendered from
   [nlo-vhost.stageB.conf.tpl](deploy/nginx/nlo-vhost.stageB.conf.tpl),
   `client_max_body_size 210m`, WebSocket/SSE headers) via docker mount;
   issue LE cert via docker-mounted certbot (webroot `/www/acme`, same LE
   account); `sudo -n /www/server/nginx/sbin/nginx -t` →
   `-s reload`; verify.
4. **FFmpeg** (Phase 4): add `NLO_FFMPEG_BIN=/usr/bin/ffmpeg`; restart;
   adapter + real transcode verification.
5. **Real podcast** (Phase 5): session verify → 1 text job → poll →
   artifact → MP3 56k validation → authenticated download.
6. **Docs/acceptance** (Phases 6–11).

## 10. Rollback plan

- **vhost**: delete `nlo.ai.ismc.ir.conf` → `nginx -t` → reload (admin
  catch-all returns; NLO unaffected).
- **cert**: LE live symlinks are additive; removing the vhost leaves the
  cert idle (harmless) or `sudo -n` certbot-delete later.
- **`.env`**: restore `data/backups/env-…` / `p3-<ts>/env` → restart
  `nlo`.
- **systemd**: unit file is not modified (only env) → no unit rollback.
- **DB**: `sqlite3 data/nlo.sqlite < backup` after service stop; latest
  good = today's 11:40Z deploy backup.
- **Auth**: `NLO_API_AUTH=0` + remove `auth_basic` lines → reload.

## 11. Required permissions (status)

| Permission                                                    | State                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SSH as `saber`                                                | **OK** (used throughout)                                                       |
| `sudo -n` nginx `-t`/reload, systemctl, ss, journalctl, chmod | **OK**                                                                         |
| Root file writes (vhost dir, `/etc/nginx`)                    | **OK via docker group**                                                        |
| LE issuance                                                   | **OK via docker-mounted certbot** (webroot writable)                           |
| Cloudflare zone API (DNS/Access)                              | **BLOCKED with current token** (verify-only) — not needed for the minimum path |
| Sudo password                                                 | **Not required**; optional                                                     |
| One real NotebookLM job                                       | **Authorized** (mission §1.9)                                                  |

**Preflight verdict: PROCEED.** No hard blockers for the authorized scope.
One owner decision requested in Batch 1: confirmation of the browser-auth
approach (nginx `auth_basic` + password) before Batch 2 touches production.
