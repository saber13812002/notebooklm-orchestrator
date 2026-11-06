# Phase 2 — Stage 1: Local Stabilization (NLO-PHASE-2-AUDIO-LIVE-2026-11)

**Date:** 2026-11-06 (evidence window 20:50–21:12 UTC)
**Result:** **PASS** — server restarted from an Active RDP session onto the
Phase-1-fixed code; health checks green; real python worker verified
(spawn → ping → clean shutdown, no orphan, settle-once logs present).

---

## 1. Pre-restart state (from Stage 0 + fresh re-check)

| Item                               | Value                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port 4870                          | free                                                                                                                                                                                                                                                                                          |
| Port 4871                          | PID **6932** — `node --require …/tsx/dist/preflight.cjs --import …/tsx/dist/loader.mjs apps/server/src/main.ts` (parent 39304 tsx CLI ← 14256 `npx tsx apps/server/src/main.ts`) — **NLO server, this repo**                                                                                  |
| Code of PID 6932                   | started 02:55 UTC → **pre-`87f964b` (pre-settle-once fix)**                                                                                                                                                                                                                                   |
| RDP session 2 (`s.tabatabaei`)     | **Active**                                                                                                                                                                                                                                                                                    |
| RDP session 3 (`rghanbari`)        | Disc (not our user)                                                                                                                                                                                                                                                                           |
| Worker spawn behaviour of PID 6932 | **BROKEN**: every `data\venv\Scripts\python.exe` spawn since ~03:07 UTC exited `code=3221225794` (0xC0000142, STATUS_DLL_INIT_FAILED) with empty stderr (pids 18168, 39480, 46168, 23536, 12420 in `tmp\dev4871-retry5.log`), while `GET /api/health/ready` still reported `configured:false` |
| Fresh-shell control                | `data\venv\Scripts\python.exe --version` → `Python 3.13.15` OK — the breakage was scoped to the old process tree                                                                                                                                                                              |

**Decision:** controlled restart required (mission 1.2). The old instance was
both (a) pre-fix and (b) spawn-broken; restarting from the active terminal
addresses both and lets the settle-once fix be observed live.

## 2. Controlled restart procedure (executed)

1. **Log backup:** `tmp\dev4871-retry5.log` → `tmp\dev4871-retry5.log.bak-phase2` (5,934 B). DB backup already taken in Stage 0 (`data/backups/nlo-pre-phase2-2026-11-06T20-18Z.sqlite` + WAL).
2. **Identity re-verification** of all three PIDs (6932/39304/14256) via `Win32_Process.CommandLine` — all three are the NLO server of this repo (command lines in §1). Non-NLO processes (`xray.exe` PID 24840, `http.server 8899`, `_dnsproxy.py`, Chrome) left untouched.
3. **Kill:** `taskkill /F /PID 6932` → SUCCESS (39304/14256 exited with the parent). Port 4871 confirmed free 3 s later.
4. **Relaunch (same convention as README, from the active terminal):**
   `start "" /B cmd /c "set NLO_PORT=4871&& npx tsx apps/server/src/main.ts > tmp\dev4871-phase2.log 2>&1"`
   → new listener PID **46924** on `127.0.0.1:4871`.

## 3. Post-restart health checks (all live)

| Check                        | Result                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`            | `{"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-06T20:53:41.510Z"}`                                                                                 |
| `GET /api/health/ready`      | `{"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}` |
| `GET /api/openapi.json`      | 200 — OpenAPI **3.0.3**, title "NotebookLM Orchestrator API", version **1.0.0**                                                                                     |
| `GET /api/docs` (Swagger UI) | 200                                                                                                                                                                 |
| `GET /` (Web UI)             | 200 (473 B index)                                                                                                                                                   |
| Orphan check (python.exe)    | only unrelated tooling (`http.server 8899`, `_dnsproxy.py`) — **no stray workers**                                                                                  |

## 4. OpenAPI / Swagger extraction (mission 1.3)

- **Version:** OpenAPI 3.0.3 / API v1.0.0. **Operations: 54** across 43 paths
  (matches the H0/H1 live-verified baseline).
- **Audio-related endpoints:**
  - `POST /api/jobs` — **the audio upload endpoint** (multipart/form-data):
    fields `prompt` (required), `title`, `audio` (file),
    `preferredAccountId`, `preferredNodeId`; returns `201 {id, status}`
    (or 200 on idempotent replay). Security: `apiKeyAuth` (bearer `nlo_…`)
    defined; **locally `NLO_API_AUTH=0` → no token required** (README env
    table; dev convention).
  - `GET /api/jobs/{id}` · `/result` · `/events` · `/attempts` · `/artifacts` ·
    `/artifacts/{artifactId}` · `GET /api/jobs/{id}/audio` ·
    `GET /api/jobs/{id}/audio/download` · `POST /api/jobs/{id}/cancel` ·
    `POST /api/jobs/{id}/requeue`.
  - Text canary: `POST /api/notebooks/from-text`.
- **Auth state:** `components.securitySchemes.apiKeyAuth` = http/bearer
  (`nlo_` tokens via `POST /api/tokens`, admin scope).
- **Schemas** (request/response) for the job flow are inline in
  `openapi.json`; consistent error envelope `{ "error": { "code", "message" } }`.

## 5. REAL python worker verification (mission 1.4 — not the fake worker)

Triggered live by `GET /api/health/ready` → `validateConfiguration()`
(`python-worker-provider.ts:209` spawns a real worker, pings it, closes it).
`tmp\dev4871-phase2.log` (post-restart):

```
[nlo:worker] spawn pid=18164 python=C:/Users/.../data/venv/Scripts/python.exe
[nlo:worker] request sent id=1 op=ping timeoutMs=30000
[nlo:worker] response ok id=1 op=ping
[nlo:worker] close: requesting shutdown pid=18164
[nlo:worker] exit pid=18164 code=null signal=SIGTERM pending=0 stderrTail=
[nlo:worker] cleanup: child pipes closed (pending=0)
```

| Acceptance item (mission 1.4)                     | Evidence                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Worker spawn success                              | `spawn pid=18164` (real venv Python 3.13.15)                                                                                    |
| Ping/protocol OK                                  | `response ok id=1 op=ping`                                                                                                      |
| Clean shutdown, no orphan                         | `exit … signal=SIGTERM pending=0` + `cleanup: child pipes closed`; orphan scan found no stray workers                           |
| Correlation-id structured logs (Phase 1 fix live) | second worker cycle (verify op) logged `… [nlo:worker acct:acc_315776aeb5b74e33] …` — correlation ids present                   |
| stdin-EOF/timeout/queue-recovery                  | covered by the 14 Phase 1 regression tests (commit `87f964b`); the live evidence here proves spawn + shutdown on the fixed code |

**venv:** Python 3.13.15, `notebooklm-py 0.8.5`, `playwright 1.64.0`,
`httpx 0.28.1`.

### Known gap (documented, does NOT block the audio job)

- **Chromium for interactive `login` is missing:**
  `ms-playwright\` contains only a `.links` stub; a direct
  `pw.chromium.launch()` from the venv fails
  (`Executable doesn't exist at …\ms-playwright\chromium_headless_shell-1248\…`).
  `validateConfiguration()` only checks _importability_ of playwright, so
  readiness still reports `configured:true`.
- **Impact:** the audio job path does **not** launch a browser —
  `nbl_worker.py` job/verify ops use `NotebookLMClient.from_storage` (cookie
  session). Only `op_login` (interactive Playwright sign-in,
  `nbl_worker.py:194-251`) needs Chromium. If a re-login must use the
  Playwright `login` op, either `playwright install chromium` or a
  `chrome`/`msedge` channel launch is required (both installed on this
  machine; the API accepts `browser: "chrome" | "msedge"`).
  **`browser-import`** (notebooklm-py CLI reading the real browser's cookie
  jar) needs the user's Chrome fully closed.

## 6. PASS/FAIL — Stage 1 local stabilization

| #   | Criterion                                       | Result                                                                                                                                 |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Healthy server on 4871 after controlled restart | **PASS** (PID 46924, `/api/health` ok)                                                                                                 |
| 2   | Worker configured                               | **PASS** (`configured:true`, issues `[]`)                                                                                              |
| 3   | Real worker spawn success                       | **PASS** (pid 18164, ping ok)                                                                                                          |
| 4   | Exit without orphan                             | **PASS** (SIGTERM, `pending=0`, cleanup logged; orphan scan clean)                                                                     |
| 5   | Queue operational                               | **PASS** (diagnostic job `j_ac986702…` queued, ran, and terminalized in 26 ms — see Stage 2 §3; queue recovery tests green in Phase 1) |
| 6   | Health/OpenAPI/docs/Web UI reachable            | **PASS** (200s above)                                                                                                                  |

**Next:** Stage 2 — Google account & session verification (official API
verify + eligibility re-check).
