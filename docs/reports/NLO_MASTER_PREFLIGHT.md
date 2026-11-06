# NLO MASTER — Preflight Audit (read-only)

**Mission:** NLO-MASTER-2026-11
**Date:** 2026-11-06 (audit window ≈ 07:10–07:40 UTC / 10:40–11:10 Asia/Tehran)
**Mode:** READ-ONLY. No commits, no pushes, no service restarts, no deletions,
no feature changes. All live checks were status/inspect commands and
loopback/SSH curl to health endpoints. Old reports were used as context only;
every fact below was re-verified fresh against the working tree and live
systems during this audit.
**Secrets:** none printed. Variable names, file paths, and masked refs only.

---

## 1. Mission context & audit date

The mission's end state: a user submits text or audio → NLO creates a real
NotebookLM notebook → uploads the source → **generates a Deep Dive audio
overview** → downloads the produced audio → converts to **MP3 56 kbps** →
publishes it via a configurable **external HTTP POST webhook**. Production is
host `172.30.0.133` (host name `AI-TOOLS`); legacy `s52`/`172.20.1.52` was
decommissioned 2026-11-01.

This preflight is the first of six phases. Its output is the planning source
of truth for Phases 1–6.

---

## 2. Environment matrix

| Env                                                           | Branch | HEAD SHA                                  | Working tree                                                                                       | Sync vs peers                                                                                                                    | Running version                                                                          | Status                                       |
| ------------------------------------------------------------- | ------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Local repo** (`notebooklm-orchestrator`)                    | `main` | `a7f7a42`                                 | **287 staged files** (whole `tmp/` tree + 3 root artifacts); 0 uncommitted _tracked_ modifications | 1 commit **ahead** of `origin/main`, 0 behind                                                                                    | dev server on **4871**                                                                   | ⚠️ DEGRADED (worker start fails, 0xC0000142) |
| **GitHub** `origin` = `saber13812002/notebooklm-orchestrator` | `main` | `4ae25da`                                 | —                                                                                                  | source of truth                                                                                                                  | CI on push/PR (gh CLI not available locally; last run not verified from here)            | OK                                           |
| **GitLab** `git.ai.ismc.ir`                                   | —      | —                                         | **no `gitlab` remote configured locally**                                                          | mirror documented but **blocked on token**; GitLab container ran on s52 (now decommissioned) — instance availability now unknown | no runner; `.gitlab-ci.yml` inactive                                                     | ⚠️ BLOCKED / STALE DOCS                      |
| **Production** `saber@172.30.0.133` (`AI-TOOLS`)              | `main` | `d705634`                                 | tracked tree clean (verified via `git status --porcelain --untracked-files=no`, empty)             | 12 commits behind `origin/main` (the `d705634..4ae25da` delta, incl. H1 from-text)                                               | `nlo.service` **active** on `127.0.0.1:4870`, deployed-commit `d705634`                  | OK (deploy delta pending)                    |
| **Local dev server** `127.0.0.1:4871`                         | —      | running from local `main` `a7f7a42` (tsx) | —                                                                                                  | —                                                                                                                                | `python-worker` provider **not configured** (worker spawn fails); xray runtime available | ⚠️ DEGRADED                                  |

Overall: **no BLOCKED production check** — production was reachable and
verified live this audit (see §5). The degraded item is the **local** dev
environment (Python worker DLL init failure), which does not affect prod.

---

## 3. Repository & git reconciliation

- `git branch --show-current` → `main`; `git rev-parse HEAD` →
  `a7f7a420b9f4fc4ff00b9558e1c60bf9686e38d3`.
- `git remote -v` → only `origin` (GitHub). **No GitLab remote.**
- `git fetch origin` + `git rev-list --left-right --count main...origin/main`
  → `1 0` (local 1 ahead, 0 behind). Local-only commit `a7f7a42`
  "docs: production readiness audit 172.30.0.133 (read-only)".
- `git status --porcelain` → **287 staged (A) entries, 67,570 insertions, 0
  unstaged tracked modifications**:
  - **`'2026-11-05'`** (3,704 B, filename contains _literal single-quote
    characters_) — a PowerShell redirection artifact; a job-dump (job ids,
    statuses, error classes; no secrets).
  - **`$out`** (2,135 B) — PowerShell redirection artifact containing a
    production preflight evidence capture (systemctl status, port 4870 bind,
    deployed commit `b5e9ad3`, loopback probes, journal tail) from host
    `AI-TOOLS`. No secrets.
  - **`HTTP`** (0 B) — empty file, same artifact class.
  - **entire `tmp/` tree** — hundreds of dev scratch files, including a
    Python venv (`tmp/zoo-p1/pylib/...`), dev server logs, and
    `tmp/p0_make_mp3.py`.
- **Governance gap:** `tmp/` is **not** in `.gitignore`; these artifacts are
  staged in the index (never committed). `.env` **is** properly ignored
  (`.gitignore:18`) and `.env` exists locally (var names: `NLO_HOST`,
  `NLO_PORT`, `NLO_PROVIDER`, `NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN`,
  `NLO_LOGIN_BROWSER`, `NLO_ALLOW_DIRECT_EGRESS`; no LLM-key var present).
- **Secret scan** of all staged content (patterns `sk-`, `ghp_`,
  `vless://`, `api_key`, UUID-like tokens): **no secret-like hits**.
- No force-pushes or history rewrites detected; local log is linear on top of
  `origin/main`.

**Action for Phase 1:** unstage the 287 entries (`git reset` on paths only —
not a history op), delete the 3 root artifacts, add `tmp/` to `.gitignore`,
commit + push the pending `a7f7a42` docs commit.

---

## 4. Local dev server state (port 4871)

- **Process:** `npx tsx apps/server/src/main.ts` with `NLO_PORT=4871`
  (active terminal; log `tmp\dev4871-retry5.log`); port 4871 LISTENING.
- **Liveness:** `GET /api/health` → `{"ok":true,"service":"notebooklm-orchestrator",...}`.
- **Readiness:** `GET /api/health/ready` → `ready:true` BUT
  `provider.configured:false` with
  `worker start failed: python worker exited unexpectedly
(code=3221225794, signal=none)`. `3221225794 = 0xC0000142
(STATUS_DLL_INIT_FAILED)` — the Windows Python venv at
  `data/venv/Scripts/python.exe` cannot spawn a working interpreter
  (repeated across multiple worker spawn attempts in the log tail).
- `proxyRuntime: {state:"available", name:"xray"}` — `data/vendor/xray.exe`
  present locally; `liveDisabled:true`.
- **Log tail (redacted; no secrets present):** one job
  `j_10d3fbe7c2f97890dfc4932fa3d951fa` started, node `france1-SeyedSaber`
  selected, tunnel `127.0.0.1:60922`, then `RPC GET_NOTEBOOK
(TransportServerError) / RemoteProtocolError`, worker killed `SIGTERM`;
  subsequent worker spawns exit with `0xC0000142`. Also: `notebooklm-py`
  `DeprecationWarning` for legacy `from_storage(timeout=...)` tuning arg.
- **Implication:** locally, real NotebookLM jobs currently fail at worker
  start. This is an environment problem (venv/DLL on this Windows machine),
  not a code regression — the same provider code is healthy on production
  (§5).

---

## 5. Production state — `172.30.0.133` (verified live, read-only)

Access: `ssh -o BatchMode=yes saber@172.30.0.133` (publickey; **reachable —
NOT blocked**). Commands executed: `hostname`, `systemctl is-active nlo`,
`cat data/deployed-commit`, `git rev-parse HEAD`,
`git status --porcelain --untracked-files=no`,
`curl 127.0.0.1:4870/api/health`, `.../api/health/ready`, `ss -ltn | grep 4870`.

| Item                                       | Value                                                                                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                                       | `AI-TOOLS`                                                                                                                                                                                                                                                |
| `nlo.service`                              | **active**                                                                                                                                                                                                                                                |
| Repo HEAD                                  | `d705634dacff5e3b97cdb29cb3968a8d91e90cab`                                                                                                                                                                                                                |
| `data/deployed-commit`                     | `d705634`                                                                                                                                                                                                                                                 |
| Tracked working tree                       | clean (empty porcelain output)                                                                                                                                                                                                                            |
| `GET /api/health`                          | `{"ok":true,...}`                                                                                                                                                                                                                                         |
| `GET /api/health/ready`                    | `{"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}`                                                                                       |
| Port                                       | `127.0.0.1:4870` LISTENING (loopback-only)                                                                                                                                                                                                                |
| Deploy delta pending                       | `d705634..4ae25da` = 12 commits (P0 audio recovery + H1 text-to-notebook; no migrations, no dependency changes — per `PRODUCTION_READINESS_2026-11-06.md`, whose premise I re-verified but whose staleness risk I re-checked: HEAD still `d705634` today) |
| Known caveat (from that report, unchanged) | `sudo systemctl restart` requires an interactive password (no NOPASSWD); P0 audio tunnel instability on `france1-SeyedSaber` is external                                                                                                                  |

**No blocker on production.** Deploy mechanics (`deploy/deploy.sh`) are
documented and precondition-checked; the only human dependency at deploy
time is the sudo password.

---

## 6. Existing capability inventory (audit items 6–14)

### 6.1 NotebookLM worker lifecycle — **implemented (live-verified on prod); one known defect**

- `apps/server/src/providers/python-worker/worker.ts` (`WorkerSupervisor`):
  argument-array spawn (never shell), line-buffered stdio, stderr drained
  with 64 KB cap + `redactSecrets`, per-request deadline
  (`requestTimeoutMs` default 30 min, `startupTimeoutMs` 20 s),
  SIGTERM → SIGKILL escalation (5 s), `failAll()` rejects every pending op on
  child death.
- **Known defect (PRE-EXISTING, unchanged on prod — byte-identical file
  between `d705634` and `4ae25da`):** on the **timeout path**
  (`worker.ts:168-177`) the pending entry is deleted **before** `kill()`, so
  at a 30-min timeout the promise never settles and the in-process queue
  stays `busy` (wedge). The **abort path** deliberately does _not_ delete the
  entry (kill→failAll rejects it). Documented as not-fixed in
  `PHASE_H0_H1_TEXT_TO_NOTEBOOK.md` §16 and `PHASE_P0_AUDIO_RECOVERY.md` §15
  (mitigation: early-stop before 30 min; DB-terminalize + restart if wedged).
  **This must be fixed in Phase 1 (stabilization).**
- `protocol.ts`: JSON-line opcodes (ping/validate/verify/login/
  browser-import/job/job_text), error-code enum, `isAmbiguousCode()`
  (ambiguous/timeout never auto-retry). Frames forced pure-ASCII
  (`19fba24`).
- `nbl_worker.py`: asyncio worker; Playwright interactive login;
  browser-cookie import (allowlisted cookie names); `job` (audio upload +
  ask) and `job_text` (text source via `sources.add_text` + optional
  summary); SIGTERM/SIGINT handlers; stdin-EOF shutdown; in-flight op
  cancelled on stop. **`job` and `job_text` both END after `ask` — there is
  no op for generating or downloading a Deep Dive audio overview.**

### 6.2 API & OpenAPI — **implemented, versioned, contract-tested** (full table in §7)

- Legacy `/api/*` + versioned `/api/v1/*` (same handlers re-registered) +
  admin `/api/v1/tokens` + `/api/v1/audit`.
- OpenAPI 3.0.3 built programmatically (`api/openapi/spec.ts`), served at
  `/api/openapi.json`, Swagger UI at `/api/docs`; bidirectional drift test
  (`apps/server/test/openapi-v1.test.ts`) asserts every documented path
  exists and every live v1 route is documented.
- Auth: Bearer `nlo_` tokens when `NLO_API_AUTH=true`; exempt GETs:
  health, ready, openapi.json, docs. Tokens/audit always require a valid
  admin token. Idempotency-Key (token-scoped), per-token sliding-window rate
  limit, correlation ids, redacted audit trail.
- **Drift found this audit:** the OpenAPI `Job` schema lists a
  `PROVIDER_CONFIRMED` status (`spec.ts:62`) that does **not** exist in the
  shared `JobStatus` type (`packages/shared/src/types.ts:6-18`, 12 states).
  Doc-only, but should be cleaned up in Phase 1/5.

### 6.3 Proxy runtime — **implemented (real, live-verified on prod)**

- `proxy/runtime.ts`: `XrayProxyRuntime` — per-node 0600 Xray config, one
  loopback HTTP CONNECT inbound, one VLESS outbound (tcp/ws/grpc; none/tls/
  reality), ephemeral local port detected by TCP connect (xray ≥26 safe),
  SIGTERM→SIGKILL group kill, unexpected-death cleanup; `XrayProxyRuntimeStub`
  fails closed when the binary is absent. `data/vendor/xray.exe` present
  locally; `data/vendor/xray` present on prod.
- `proxy/connect-proxy.ts`: real fetch through the tunnel — **curl primary**
  (OpenSSL fingerprint survives Google/Cloudflare where Node BoringSSL gets
  ECONNRESET), node:https fallback; **no direct fallback (fail-closed)**;
  `viaTunnel` only true when genuinely routed.
- `proxy/proxy-manager.ts`: staged health check (config → runtime →
  listener → real egress fetch → nbl access), SSRF allowlist + public-IP
  assertion, 10-min health TTL, self-heal on selection
  (`SELF_HEAL_MAX_LATENCY_MS=3000`, max 12 candidates).
- `proxy/egress.ts`: fail-closed contract; `DirectEgressBlockedError`.
  **Confirmed both local proxy nodes currently fail** the 15 s staged check
  (log: repeated `health check timed out after 15000ms through tunnel` for
  `England_1` and `france1-SeyedSaber` → jobs fail closed locally).
  On prod the route was verified working at the 2026-11-06 ~04:05 UTC audit;
  long-held audio operations still drop intermittently (external tunnel
  quality).

### 6.4 Accounts / sessions / login — **implemented (live-verified)**

- `POST /sessions/:id/login` (Playwright interactive),
  `/browser-import` (allowlisted browsers, allowlisted cookie names),
  `/import` (Playwright storage-state JSON), `/verify` + `/refresh`,
  `DELETE`. One auth op at a time per account; storage-state never served
  over HTTP; session files 0600 under `data/sessions/` (0700 dir).
- **10-minute verification TTL** confirmed:
  `auth-sessions.repo.ts` `isUsable()` / `eligibleAccountIds()` default
  `ttlMs = 10*60*1000`; `AuthSessionState` machine (9 states).
- **Freshness preflight before job submission** exists (`fc54fc4`, P0):
  `job-runner.ts selectAccount()` only accepts accounts with a usable
  (AUTHENTICATED + verified within TTL) session; preferred account strictly
  honored, then default, then most-recently-successful.
- **Redaction:** cookies/sessions never read or printed in this audit.

### 6.5 Jobs & artifacts — **implemented (queue + state machine); local DB healthy, 0 in-flight**

- `queue/queue.ts`: in-process single-worker durable queue (500 ms poll);
  at most one job at a time (safe for one account); `recoverInFlight()` on
  boot resets in-flight jobs to QUEUED (`job-state.ts RESTART_RECOVERABLE`);
  graceful drain on stop.
- `job-runner.ts`: state machine driver, account selection (TTL-gated),
  fail-closed proxy selection, failure classification (auth→AUTH_REQUIRED,
  ambiguous→NEEDS_ATTENTION, retryable→RETRY_WAIT, else FAILED), local
  `redact()` strips `vless://` + UUIDs from logs/events.
- **Local DB** (`data/nlo.sqlite`, opened read-only via `node:sqlite`):
  **20 jobs total — 11 FAILED, 5 CANCELLED, 4 SUCCEEDED; 0 in-flight; no
  RUNNING job older than 1 h; artifacts table: 0 rows.** Consistent with
  the local worker-start failures (§4). Prod DB (from today's context report,
  re-verified service state): 5 jobs, all terminal.
- **Job state delta vs mission requirement:** see §8.

### 6.6 Deep Dive / audio-overview generation — **NOT implemented (missing)**

- `providers/types.ts` documents the direction explicitly: the implemented
  workflow is _"audio + prompt"_ (upload audio source → ask a prompt → read
  the text answer) and states it is **distinct from "generate audio
  overview (which is the opposite direction)"**.
- `python-worker-provider.ts capabilities()`: `retrieveArtifacts =
unsupported` ("chat answers are text; no downloadable artifacts");
  `submitAudioJob`/`retrieveResult` = `implemented_untested_live`.
- `e2e-live.ts` / `verify-live.ts` (manual gates, never in CI) exercise:
  session verify, xray runtime, real-tunnel route proof vs
  `notebooklm.google.com:443`, audio+prompt job, grounded non-mock answer,
  provenance `real`. **No step generates or downloads a Deep Dive.**
- **Conclusion: generating a Deep Dive audio overview, downloading the
  produced audio, and MP3 conversion are entirely new work for this mission
  (Phase 3/4).** The provider interface will need new ops (e.g.
  `generate_audio_overview`, `download_artifact`) or a new capability.

### 6.7 FFmpeg — **not installed locally; not referenced by any code**

- `where ffmpeg` / `where ffprobe` on this Windows machine: **not found**.
- Codebase search for `ffmpeg|ffprobe`: **zero references in
  `apps/`, `packages/`, `deploy/`** — only historical mentions in
  `CHANGELOG.md`/reports (prod host `AI-TOOLS` has ffmpeg 6.1.1 per
  `PHASE_G3A_NEW_HOST_AUDIT.md`; early plan doc noted "not installed" for the
  old host). `tmp/p0_make_mp3.py` is a scratch MP3-frame writer with
  "No ffmpeg dependency".
- **Conclusion:** MP3 56 kbps conversion is unimplemented; Phase 4 must add
  an ffmpeg dependency (prod already has 6.1.1; local Windows needs an
  install decision — e.g. vendor binary in `data/vendor/` to match the xray
  pattern, no system install).

### 6.8 Webhooks — **NOT implemented (planned doc only); building blocks exist**

- `apps/server/src`: **0 matches** for `webhook`.
- `docs/wiki/10-webhook-integration.md` is explicitly marked
  **"planned — not implemented"** (Phase C/G design): POST JSON event with
  HMAC signature header, retry with backoff, suggested events
  `job.created/running/succeeded/failed/cancelled/needs_attention`,
  HTTPS-only URL + SSRF guard. Polling `GET /api/jobs/:id` is the only
  supported method today.
- **Existing building blocks:** `packages/shared/src/ssrf.ts`
  (`assertAllowedDestination`, `parseAllowEntry`),
  `packages/shared/src/retry.ts`, secret vault for a per-webhook secret
  (`vault.ts`), audit trail, correlation ids.
- **Conclusion:** webhook destination registry, event emitter, delivery
  worker, retries, and HMAC signing are all new (Phase 2).

### 6.9 Storage & config — **implemented; one config note**

- `data/` layout (local): `nlo.sqlite` (+wal/shm), `backups/` (deploy
  retention-5), `jobs/<jobId>/` archives (`input/prompt.md`,
  `input/audio-<safe>`, `execution/timeline.jsonl`), `sessions/` (0700,
  files 0600), `vault/` + `vault.key` (0600), `vendor/xray.exe` + `cfg/`,
  `venv/`, `tmp/`.
- `.env` (git-ignored) vs `.env.example`: example documents
  `NLO_HOST/PORT/PROVIDER/PROXY_RUNTIME/MAX_UPLOAD_BYTES/ALLOWED_AUDIO_EXTENSIONS`
  - commented `NLO_VAULT_KEY`; local `.env` additionally carries
    `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`, `NLO_ALLOW_DIRECT_EGRESS`.
    `NLO_MAX_TEXT_CHARS` (H1) is a new optional var (default 200000).
- **Vault:** AES-256-GCM per-record nonce, key from `NLO_VAULT_KEY` or
  auto-created 0600 key file; VLESS UUIDs stored as `vless-uuid:` refs,
  values encrypted; `GET /api/secrets` shows masked refs only.
- **LiteLLM / internal LLM:** `internal-llm.ts` is an OpenAI-compatible
  client for the internal proxy; base URL comes **only** from
  `NLO_INTERNAL_API_BASE_URL` (default `http://172.30.0.133:4000` — the new
  host, legacy s52 never hardcoded). The API key is a per-request parameter
  (`apiKey` option) — **no env var, no file, no temp file stores it in this
  repo; no production caller exists yet** (only tests). If the mission needs
  an LLM step, key provisioning is an open item (owner: user/maintainer;
  store in prod env or vault, never in git).

### 6.10 CI — **GitHub active; GitLab mirror inactive; GitLab itself stale**

- `.github/workflows/ci.yml`: quality (npm ci → lint → format:check →
  typecheck → test → build, node 22) + docker build & smoke
  (`/api/health` on 4870). Triggers: push/PR to main.
- `.gitlab-ci.yml`: exact mirror (quality + gated docker
  `BUILD_DOCKER=1`); header states **ready, NOT active — no runner
  registered**.
- `gh` CLI is **not installed on this machine**, so the latest Actions run
  could not be queried from here (recorded as an unverified detail, not a
  blocker — the workflow file and `origin` are authoritative).
- **Staleness:** `docs/operations/gitlab-sync.md` was written when GitLab CE
  16.3.9 ran **in a container on s52**. s52 was decommissioned 2026-11-01;
  the GitLab instance's current availability is **unknown**. No NLO project
  ever existed there (verified at the time); no token was ever provided.
  **Phase 1 must re-confirm whether the GitLab instance survived the
  s52 decommission before any mirroring work; otherwise the dual-repo policy
  needs a revised target.**

---

## 7. API operation inventory & OpenAPI coverage

Versioned surface `/api/v1/*` (legacy `/api/*` mirrors the same handlers;
tokens/audit are v1-only). `security` = Bearer token when `NLO_API_AUTH` is
on; exempt: `GET /health`, `GET /health/ready`, `GET /openapi.json`,
`GET /docs`.

| Tag             | Operations (method + path)                                                                                                                                                                                                                                                                                                                                                      | Auth                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| meta (contract) | `GET /openapi.json`, `GET /docs`                                                                                                                                                                                                                                                                                                                                                | exempt                          |
| jobs            | `POST /jobs` (multipart, Idempotency-Key), `GET /jobs`, `POST /notebooks/from-text` (H1, 202), `GET /jobs/{id}`, `GET /jobs/{id}/result`, `GET /jobs/{id}/events`, `GET /jobs/{id}/attempts`, `GET /jobs/{id}/artifacts`, `GET /jobs/{id}/artifacts/{artifactId}`, `GET /jobs/{id}/audio`, `GET /jobs/{id}/audio/download`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/requeue` | Bearer (scopes `jobs:*`)        |
| auth            | `GET /sessions`, `GET /sessions/{id}`, `DELETE /sessions/{id}`, `POST /sessions/{id}/login`, `POST /sessions/{id}/browser-import`, `POST /sessions/{id}/verify`, `POST /sessions/{id}/refresh`, `POST /sessions/{id}/import`                                                                                                                                                    | Bearer                          |
| accounts        | `GET /accounts`, `POST /accounts`, `GET /accounts/{id}`, `PATCH /accounts/{id}`, `DELETE /accounts/{id}`, `POST /accounts/{id}/default`, `POST /accounts/{id}/health`                                                                                                                                                                                                           | Bearer                          |
| proxies         | `GET /proxies`, `POST /proxies` (vless URI, UUID vaulted), `POST /proxies/manual`, `POST /proxies/ping-all`, `GET /proxies/runtime`, `GET /proxies/{id}`, `PATCH /proxies/{id}`, `DELETE /proxies/{id}`, `POST /proxies/{id}/validate`, `POST /proxies/{id}/health` (target `egress`\|`notebooklm`), `POST /proxies/{id}/connectivity`                                          | Bearer                          |
| meta (state)    | `GET /health`, `GET /health/ready`, `POST /health/account`, `POST /health/egress` (SSRF-allowlist only), `GET /provider` (honest capability matrix), `GET /settings`, `PUT /settings` (2 whitelisted keys), `GET /secrets` (masked refs)                                                                                                                                        | Bearer (health/ready exempt)    |
| tokens (admin)  | `GET /tokens`, `POST /tokens` (plaintext once), `PATCH /tokens/{id}`, `DELETE /tokens/{id}`, `GET /audit`                                                                                                                                                                                                                                                                       | Bearer + `admin` scope (always) |

**Count:** 54 operations in the local spec (this audit's count of
`spec.ts` paths); the 2026-11-06 prod audit measured 52 on `d705634` and
predicted 53 post-`from-text` — the small variance is a counting-basis
difference and is policed by the bidirectional drift test
(`openapi-v1.test.ts`).

**OpenAPI coverage gaps / notes:**

1. `Job.status` enum in the spec includes **`PROVIDER_CONFIRMED`**, which is
   not a valid `JobStatus` — doc drift to remove (or add to the type, with
   justification).
2. No webhook operations (expected — capability not built).
3. No Deep Dive / audio-overview operations (expected — capability not
   built).
4. No pagination on `/sessions`, `/accounts`, `/proxies` lists (fine at
   current scale; note for Phase 5 if lists grow).

---

## 8. Job-state delta (current vs mission-required)

Current `JobStatus` (`packages/shared/src/types.ts:6-18`) — **12 states**:
`CREATED, VALIDATING, QUEUED, WAITING_FOR_ACCOUNT, WAITING_FOR_PROXY,
RUNNING, RETRY_WAIT, SUCCEEDED, FAILED, NEEDS_ATTENTION,
CANCEL_REQUESTED, CANCELLED`.

Mission-required pipeline (16 states): `QUEUED, VALIDATING,
UPLOADING_SOURCE, CREATING_NOTEBOOK, GENERATING_SUMMARY,
GENERATING_DEEP_DIVE, WAITING_FOR_AUDIO, DOWNLOADING_AUDIO,
CONVERTING_AUDIO, ARTIFACT_READY, WEBHOOK_PENDING, WEBHOOK_DELIVERED,
SUCCEEDED, FAILED, NEEDS_ATTENTION, CANCELLED`.

| State                                            | Current                                   | Mission | Delta                                                                               |
| ------------------------------------------------ | ----------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| QUEUED                                           | ✔                                         | ✔       | keep                                                                                |
| VALIDATING                                       | ✔                                         | ✔       | keep                                                                                |
| UPLOADING_SOURCE                                 | — (inside `RUNNING`, progress event only) | ✔       | **add**                                                                             |
| CREATING_NOTEBOOK                                | — (inside `RUNNING`)                      | ✔       | **add**                                                                             |
| GENERATING_SUMMARY                               | — (inside `RUNNING`)                      | ✔       | **add**                                                                             |
| GENERATING_DEEP_DIVE                             | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| WAITING_FOR_AUDIO                                | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| DOWNLOADING_AUDIO                                | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| CONVERTING_AUDIO                                 | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| ARTIFACT_READY                                   | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| WEBHOOK_PENDING                                  | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| WEBHOOK_DELIVERED                                | — (feature absent)                        | ✔       | **add** (with feature)                                                              |
| SUCCEEDED / FAILED / NEEDS_ATTENTION / CANCELLED | ✔                                         | ✔       | keep                                                                                |
| CREATED                                          | ✔                                         | —       | fold into QUEUED or keep as internal (decision in Phase 5)                          |
| WAITING_FOR_ACCOUNT / WAITING_FOR_PROXY          | ✔                                         | —       | keep as operational sub-states (useful for the UI) or collapse; decision in Phase 5 |
| RETRY_WAIT / CANCEL_REQUESTED                    | ✔                                         | —       | keep (needed by existing retry/cancel logic)                                        |

**Impact:** 10 new states to add to the shared type + `job-state.ts`
TRANSITIONS + `job-state.test.ts` + OpenAPI enum + web status badge. This is
a cross-cutting change (shared package, runner, spec, UI) and belongs to the
integration phase, but the state machine extension must be designed in
Phase 3 so the Deep Dive pipeline lands against the final states, not
`RUNNING`-only.

---

## 9. Blockers & open questions

| #   | Item                                                                                                                    | Type                         | Who provides                                                                                             | Blocks                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| B1  | Local Windows Python venv fails with `0xC0000142` (STATUS_DLL_INIT_FAILED) — dev server can't run the real worker       | Environment                  | Operator: reinstall/repair `data/venv` (or `NLO_PYTHON_BIN` to a working interpreter)                    | Local live testing (Phase 1 gate)                              |
| B2  | Both local VLESS nodes fail the 15 s staged health check (timeout through tunnel)                                       | External (proxy quality)     | Operator: verify node credentials/availability                                                           | Local live jobs (Phase 1 gate); prod unaffected                |
| B3  | GitLab instance availability unknown after s52 decommission; no token was ever issued; no NLO project existed           | Infrastructure / credentials | User: confirm instance survival + provide maintainer PAT (`api` scope) if the dual-repo policy continues | Phase 6 (mirror) only — explicitly **not** blocking Phases 1–5 |
| B4  | GitLab/CI runner provisioning not approved; `.gitlab-ci.yml` inactive                                                   | Infrastructure approval      | User approval                                                                                            | GitLab CI parity (non-blocking)                                |
| B5  | Prod `sudo systemctl restart` needs interactive password                                                                | Operator presence            | User at deploy time (or out-of-band NOPASSWD)                                                            | Phase 6 deploy only                                            |
| B6  | FFmpeg not installed locally; no code path for MP3 56 kbps conversion                                                   | Missing dependency + code    | Decision: vendor `ffmpeg` binary into `data/vendor/` (xray pattern) vs system install                    | Phase 4                                                        |
| B7  | LiteLLM API key: no env var, no store, no caller yet                                                                    | Missing credential           | User: provide key + where it should live (prod env vs vault)                                             | Only if an LLM step is in scope for the mission                |
| B8  | Webhook destination(s), secret(s), and event contract for the _publishing_ webhook                                      | Requirements                 | User: target URL(s) + HMAC secret provisioning                                                           | Phase 2                                                        |
| B9  | Deep Dive generation mechanism (notebooklm-py API surface for audio-overview generation + artifact download) unverified | Technical unknown            | Phase 3 spike against the real provider (live)                                                           | Phase 3–4 design                                               |
| B10 | GitHub Actions latest run status not verifiable from this machine (no `gh` CLI)                                         | Tooling                      | Install `gh` or check in browser                                                                         | None (cosmetic)                                                |

**No production blocker.** B1/B2 block _local_ live verification; B3–B5 gate
Phase 6; B6–B9 are design/provisioning inputs for Phases 2–4.

---

## 10. Risks to the six phases

1. **Worker wedge (timeout path, `worker.ts:168-177`)** — pre-existing on
   prod; a 30-min hung op wedges the single in-process queue permanently
   until restart. Phase 1 must fix ordering (settle promise → then kill, or
   keep the entry until `kill()`'s failAll settles it) with a regression
   test. Highest-severity code risk in the repo today.
2. **Single-worker queue + long Deep Dive operations** — generating an audio
   overview will be far slower than the current audio+prompt flow; with one
   queue slot and a 30-min per-request deadline, a stuck Deep Dive blocks
   everything. Phase 3 must define per-phase timeouts, progress events, and
   a cancel path that actually settles the worker op.
3. **Tunnel instability under long-held connections** (prod journal:
   `GET_NOTEBOOK` ConnectTimeout/RemoteProtocolError, worker SIGABRT on
   interpreter shutdown) — Deep Dive polling/download amplifies exposure.
   Phase 3/6 needs retry-with-backoff inside the worker op and honest
   NEEDS_ATTENTION classification.
4. **State-machine scope creep** — adding 10 states mid-mission without
   updating `job-state.test.ts`, the OpenAPI enum, and the web UI in the
   same change set risks drift; do it as one atomic change (Phase 5 or as
   the first commit of Phase 3).
5. **Deploy mechanics** — the 12-commit pending delta is clean (no
   migrations/deps), but the mission adds runtime files (ffmpeg binary,
   possibly new env vars). `deploy.sh` assumes `data/vendor/` is preserved
   (it is); any new vendor binary must ship via `data/` (git-ignored) with a
   documented bootstrap step, or the Dockerfile path must change (currently
   Docker is local-only; prod is systemd).
6. **Local environment debt** — 287 staged scratch files + un-ignored
   `tmp/` invite accidental commits of dev artifacts (venv, logs). Phase 1
   hygiene (unstage, gitignore, delete artifacts, push `a7f7a42`) is cheap
   and removes a real leak risk.
7. **Auth not activated on prod** (no tokens, first-admin CLI unused) — the
   publishing webhook will be consumed over the public surface; decide in
   Phase 6 whether `NLO_API_AUTH=true` activation is part of go-live.
8. **Stale GitLab docs** — `gitlab-sync.md` evidence is s52-bound; if the
   instance is gone, the AGENTS.md dual-repo policy needs an explicit
   revision (owner decision, not an agent decision).

---

## 11. Evidence appendix (commands + key outputs)

All commands run from the local workspace unless prefixed `ssh`.

```text
# 1. Git state
git branch --show-current                          → main
git rev-parse HEAD                                 → a7f7a420b9f4fc4ff00b9558e1c60bf9686e38d3
git remote -v                                      → origin = github.com/saber13812002/notebooklm-orchestrator (only remote)
git fetch origin && git rev-parse origin/main      → 4ae25dadb7d3429b43d3eb7da10a15413e8c26c6
git rev-list --left-right --count main...origin/main → "1 0"
git status --porcelain | find /c /v ""             → 287 staged entries
git diff --cached --stat | tail -1                 → 287 files changed, 67570 insertions(+)
# staged suspicious roots (literal names): '2026-11-05' (3704 B), $out (2135 B), HTTP (0 B), tmp/** (incl. tmp/zoo-p1/pylib venv)
# secret scan (findstr over staged content: sk-, ghp_, vless://, api_key, UUID patterns) → no hits
# .gitignore:18 ignores .env (and .env.*); tmp/ NOT ignored

# 2. Local dev server (4871)
curl -s http://127.0.0.1:4871/api/health
  → {"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-06T07:34:36.383Z"}
curl -s http://127.0.0.1:4871/api/health/ready
  → ready:true, provider.configured:false
    issues:["worker start failed: python worker exited unexpectedly (code=3221225794, signal=none)"]
    (3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED)
    proxyRuntime:{state:"available",name:"xray"}, liveDisabled:true
Get-Content tmp\dev4871-retry5.log -Tail 12
  → job j_10d3fbe7c2f97890dfc4932fa3d951fa started; node france1-SeyedSaber
    tunnel 127.0.0.1:60922; RPC GET_NOTEBOOK (TransportServerError)
    RemoteProtocolError; worker SIGTERM; subsequent spawns exit 0xC0000142;
    from_storage(timeout=...) DeprecationWarning

# 3. Production (read-only; BatchMode publickey)
ssh -o BatchMode=yes saber@172.30.0.133 "hostname; systemctl is-active nlo;
  cat data/deployed-commit; curl -s -m5 127.0.0.1:4870/api/health"
  → AI-TOOLS / active / d705634 / {"ok":true,...}
ssh saber@172.30.0.133 "cd repo && git rev-parse HEAD &&
  git status --porcelain --untracked-files=no; curl -s -m8
  127.0.0.1:4870/api/health/ready; ss -ltn | grep 4870"
  → d705634dacff5e3b97cdb29cb3968a8d91e90cab / (clean)
  → {"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},
     "proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}
  → LISTEN 127.0.0.1:4870

# 4. Local DB (read-only, node:sqlite DatabaseSync readOnly)
SELECT status,count(*) FROM jobs GROUP BY status
  → FAILED 11, CANCELLED 5, SUCCEEDED 4 (total 20; in-flight 0)
SELECT count(*) FROM artifacts → 0
# no RUNNING job older than 1 h (no in-flight rows at all)

# 5. FFmpeg / tooling
where ffmpeg / where ffprobe   → not found (Windows, this machine)
codebase regex ffmpeg|ffprobe  → 0 hits in apps/, packages/, deploy/
node -v                        → v24.14.0
gh --version                   → "gh" not recognized (Actions run not verified from here)

# 6. Source-of-truth file reads (capability inventory §6)
apps/server/src/providers/python-worker/worker.ts (timeout path L168-177: pending.delete BEFORE kill → wedge)
apps/server/src/providers/python-worker/protocol.ts
apps/server/src/providers/python-worker/nbl_worker.py (ops: ping/validate/verify/login/browser-import/job/job_text — no audio-overview op)
apps/server/src/providers/python-worker/python-worker-provider.ts (capabilities: retrieveArtifacts=unsupported)
apps/server/src/providers/types.ts ("audio+prompt" ≠ "generate audio overview")
apps/server/src/api/server.ts, v1.ts, routes/{jobs,accounts,sessions,health,proxies,providers,settings,tokens}.ts
apps/server/src/api/openapi/spec.ts (54 ops incl. from-text; Job.status enum has stray PROVIDER_CONFIRMED)
apps/server/src/proxy/{runtime,connect-proxy,proxy-manager,egress}.ts
apps/server/src/queue/{queue,job-runner}.ts
apps/server/src/domain/auth-sessions.repo.ts (isUsable/eligibleAccountIds ttlMs=10*60*1000)
apps/server/src/secrets/vault.ts (AES-256-GCM; key env NLO_VAULT_KEY or 0600 key file)
apps/server/src/internal-llm.ts (base URL = NLO_INTERNAL_API_BASE_URL, default http://172.30.0.133:4000; key per-request, no store)
packages/shared/src/{types.ts (12 JobStatus),job-state.ts,ssrf.ts}
deploy/deploy.sh (backup→checkout→restart→verify→record; ROLLBACK=1)
.github/workflows/ci.yml ; .gitlab-ci.yml (mirror, inactive, no runner)
docs/operations/gitlab-sync.md (s52-bound evidence; blocked on PAT)
docs/wiki/10-webhook-integration.md (status: planned)
docs/reports/PRODUCTION_READINESS_2026-11-06.md (context; premise re-verified fresh above)
```

**Honesty note:** verified levels for this audit — Git/environment checks
**executed live**; prod service state **verified live** (health + ready +
port + deployed SHA); worker/proxy/webhook/ffmpeg findings **from source
code reads** (not runtime re-verification); GitHub Actions last-run status
**not tested** (no `gh` locally); Live NotebookLM execution **not tested**
in this audit (no job was submitted anywhere).
