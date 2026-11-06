# Phase 2 — Stage 0: Baseline (NLO-PHASE-2-AUDIO-LIVE-2026-11)

**Date:** 2026-11-06 (evidence window 20:05–20:30 UTC)
**Mission:** PROXY + GOOGLE SESSION + REAL AUDIO LIVE ACCEPTANCE
**Scope of this stage:** read-only baseline of repo, GitHub, production, local
runtime, data, sessions, and known risks. **No changes were made** except the
pre-mission backups listed in §9.

---

## 1. Executive summary

- Repo is **in sync with GitHub** at `28e2f1e` (Phase 1 Stabilization C1+C2),
  clean working tree, no stashes, no untracked files.
- Production (`172.30.0.133`) **read-only verified healthy**: service active,
  ready, provider configured, deployed commit `d705634`. Untouched.
- Local dev server on **4871** (PID 6932) is running **pre-Phase-1-fix code**
  (started 02:55 UTC; fix committed 12:32 UTC) **and is currently
  spawn-broken**: every python-worker spawn since ~03:07 UTC exits with
  `code=3221225794` (0xC0000142, STATUS_DLL_INIT_FAILED), while a fresh shell
  spawns the same venv Python successfully. A controlled restart is mandatory
  before any live work (Stage 1).
- Google session for account `acc_315776aeb5b74e33` (صابر) is AUTHENTICATED
  but `lastVerifiedAt` is **13.5 h stale** — the 10-min eligibility TTL is
  long expired; a re-verify via the official API is mandatory before the real
  job (Stage 2).
- Port 4870 is free; RDP session 2 (`s.tabatabaei`) is **Active** (the known
  Disconnected-session spawn hazard is _not_ the obvious current cause — the
  new 0xC0000142 episode needs re-observation after restart).
- No suitable **in-repo** Persian speech test file exists (all repo audio is
  synthetic tones). Real candidates are outside the repo; the test-file
  decision is deferred to Stage 4 per the mission's "ask the user" clause.

---

## 2. Repository & git state (local)

| Item                            | Value                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| Path                            | `c:\Users\s.tabatabaei\Documents\saberprojects\notebooklm-orchestrator` |
| Branch                          | `main`                                                                  |
| HEAD                            | `28e2f1e51458a11eec9ae56157fc29734728a396`                              |
| origin                          | `https://github.com/saber13812002/notebooklm-orchestrator.git`          |
| origin/main (after `git fetch`) | `28e2f1e51458a11eec9ae56157fc29734728a396` — **in sync, no divergence** |
| Working tree                    | clean (0 modified, 0 staged, 0 untracked)                               |
| Stashes                         | none                                                                    |

Recent history (newest first):

```
28e2f1e docs: Phase 1 stabilization report + status/roadmap/changelog updates (NLO-MASTER-2026-11)  [C2]
87f964b fix(worker): settle-once contract for python-worker requests … +14 regression tests        [C1]
ed2868b chore: unstage 287 scratch files and ignore local scratch artifacts
a7f7a42 docs: production readiness audit 172.30.0.133 (read-only)
4ae25da docs: PHASE_H0_H1 final acceptance report (consolidated)
d6213df docs(evidence): P0 audio attempt #5 — final retry result
```

`C1` (`87f964b`) contains the settle-once worker fix
(`apps/server/src/providers/python-worker/worker.ts`
`settle()`), which the **currently running 4871 process does not include**.

## 3. Environment matrix

### 3.1 Local (Windows 10, user `s.tabatabaei`, Tehran UTC+3:30)

| Item         | State                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port 4870    | **free** (no listener)                                                                                                                            |
| Port 4871    | `127.0.0.1` listener, OwningProcess **6932**                                                                                                      |
| PID 6932     | `"C:\Program Files\nodejs\node.exe" --require …\tsx\dist\preflight.cjs --import …/loader.mjs apps/server/src/main.ts` — **NLO server, this repo** |
| Parent chain | 6932 ← 39304 (`tsx` CLI, same tree) ← 14256 (`npx tsx apps/server/src/main.ts`) ← VSCode terminal                                                 |
| Start time   | 2026-11-06 06:25:21 local = **02:55:21 UTC → pre-C1 code**                                                                                        |
| RDP sessions | `rdp-tcp#8` s.tabatabaei = **Active** (ID 2); `rghanbari` = Disc (ID 3); console = Conn                                                           |
| `.env`       | present, 864 B, git-ignored (values never read/printed)                                                                                           |
| Chrome       | **running (24 processes)** — browser-import would be blocked by the cookie-DB lock until it is closed                                             |
| venv         | `data\venv` — Python 3.13.15; `notebooklm-py 0.8.5`, `playwright 1.64.0`, `httpx 0.28.1` (spawn-verified from a fresh shell: OK)                  |

**Pre-restart health (live, 20:22 UTC):**

```
GET /api/health        → {"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-06T20:22:19.194Z"}
GET /api/health/ready  → {"ok":true,"ready":true,
    "provider":{"name":"python-worker","configured":false,
      "issues":["worker start failed: python worker exited unexpectedly (code=3221225794, signal=none); stderr: "]},
    "proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}
```

`/api/health/ready` runs `validateConfiguration()` **live per request**
(`apps/server/src/api/routes/health.ts:20`), so `configured:false` is a
**current, reproducible** spawn failure — not cached state.

### 3.2 New critical finding — spawn breakage of the running instance

From `tmp/dev4871-retry5.log` (40 lines, the server's stdout of this PID):

- Spawns that **worked** (02:55–03:06 UTC): pids 20984, 47024, 46132 — the
  latter produced the P0 attempt-5 audio job (`j_10d3fbe7…`) and its
  `RPC GET_NOTEBOOK (TransportServerError) RemoteProtocolError` / retry
  `1/3` lines (06:36 local) before the job was cancelled.
- Every spawn **after** that (pids 18168, 39480, 46168, 23536, 12420) exits
  immediately with `code=3221225794 signal=none` (0xC0000142,
  STATUS_DLL_INIT_FAILED), empty stderr.
- A **fresh shell** in the same directory runs
  `data\venv\Scripts\python.exe --version` → `Python 3.13.15` successfully.

Interpretation (one level deep, to be re-tested post-restart): the breakage is
**scoped to this server's process tree**, not the venv itself. Known
historical triggers are a Disconnected RDP session and/or a stale Chrome
instance; session 2 is currently Active, and Chrome is currently running.
Whichever the true trigger, the remedy is identical: **launch a fresh server
from the active terminal** (Stage 1) and observe whether spawns succeed.

### 3.3 GitHub

- Fetched; `origin/main` == local HEAD (`28e2f1e`). GitHub remains the source
  of truth. No pushes are made in this stage.

### 3.4 Production `172.30.0.133` (READ-ONLY — no deploy/restart/configure)

Via `ssh -o BatchMode=yes saber@172.30.0.133` (publickey):

| Check                         | Result                                                   |
| ----------------------------- | -------------------------------------------------------- |
| `systemctl is-active nlo`     | `active`                                                 |
| `GET :4870/api/health/ready`  | `ready:true`, provider `configured:true`, xray available |
| Bind                          | loopback 4870 only                                       |
| Repo path                     | `/home/saber/saberprojects/notebooklm-orchestrator`      |
| HEAD / `data/deployed-commit` | `d705634dacff5e3b97cdb29cb3968a8d91e90cab` / `d705634`   |
| Working tree                  | clean                                                    |

Production is on an **older commit** than local HEAD by design (deploy is a
separate, approval-gated action — not part of this mission).

## 4. Database snapshot (read-only, node:sqlite `readOnly:true`)

Jobs: `SUCCEEDED 4`, `FAILED 11`, `CANCELLED 5`, **in-flight: 0**.
No orphaned RUNNING jobs to terminalize (Phase P0 attempt-5 cleanup already
done: `j_94d36895…` terminalized, backup `nlo-pre-retry5-2026-11-06T02-52Z.sqlite`).

| Account                | Label    | Auth state    | Notes                                                  |
| ---------------------- | -------- | ------------- | ------------------------------------------------------ |
| `acc_9ef8fd4d431c49fc` | sas      | AUTH_REQUIRED | default; expired 2026-10-23                            |
| `acc_315776aeb5b74e33` | صابر     | DEGRADED      | last error: worker request cancelled (op=job, timeout) |
| `acc_f95b0872c0d344cc` | صابر1404 | AUTH_REQUIRED | prior stdin-lock exit                                  |

| Session                 | Account  | State             | lastVerifiedAt                                                                   |
| ----------------------- | -------- | ----------------- | -------------------------------------------------------------------------------- |
| `sess_8f079d7e3ebe4abc` | صابر     | **AUTHENTICATED** | `2026-11-06T03:04:33.282Z` — **≈17 h before baseline → 10-min TTL long expired** |
| `sess_af33bf051ce04892` | sas      | AUTH_REQUIRED     | 2026-10-23                                                                       |
| `sess_5e495357abcd4482` | صابر1404 | AUTH_REQUIRED     | null                                                                             |

Eligibility rule (`packages`/`apps/server/src/domain/auth-sessions.repo.ts:131`
`isUsable(ttlMs=10*60*1000)`): **no account is currently eligible** — a real
re-verify through the worker/proxy is required before any job (Stage 2).

Proxy nodes: `france1-SeyedSaber` (`node_23e81d9a6ca04d10`, prio 100, enabled)
and `England_1` (`node_1e238ac8aed440cb`, prio 100, enabled). Historical
behaviour: france1 stable for short ops, 3/3 failures on long-held audio ops
(`ConnectTimeout`/`RemoteProtocolError` after ~15+ min); England_1
`read ECONNRESET`. Both must be re-tested fresh in Stage 3 — no assumptions
carried.

## 5. Non-NLO processes identified (do NOT kill)

| PID      | What                                  | Note                                                                                                          |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 24840    | `xray.exe`                            | created 2026-10-26, empty cmdline, parent 28632 — predates NLO; not an NLO tunnel                             |
| —        | python `http.server 8899` (PyManager) | unrelated tooling                                                                                             |
| —        | python `server52and53/_dnsproxy.py`   | unrelated tooling                                                                                             |
| 24 procs | Chrome                                | user's browser; **blocks browser-import** (cookie-DB lock) but must not be force-killed without user approval |

## 6. Data directory inventory (names/status only — never values)

| Path                                          | Size     | Note                                                      |
| --------------------------------------------- | -------- | --------------------------------------------------------- |
| `.env`                                        | 864 B    | git-ignored                                               |
| `data/nlo.sqlite` (+`-wal` 3213632 B)         | 143360 B | WAL active                                                |
| `data/sessions/nlo-acc_315776aeb5b74e33.json` | 21055 B  | 2026-11-06 06:35 local                                    |
| `data/sessions/nlo-acc_9ef8fd4d431c49fc.json` | 12139 B  | 2026-10-23                                                |
| `data/vault.key`                              | 64 B     | AES-256-GCM key (0600 equivalent on Windows ACL)          |
| `data/vendor/xray`                            | —        | xray runtime (available per readiness)                    |
| `data/venv`                                   | —        | Python 3.13.15 worker env                                 |
| `data/tmp`                                    | —        | synthetic tone WAVs (in-repo test audio is all synthetic) |
| `data/jobs/*`                                 | —        | per-job archives                                          |
| stale 0-B `.lock` files                       | 0 B      | harmless leftovers                                        |

## 7. Audio test-file survey (decision deferred to Stage 4)

- **In-repo:** only synthetic tones (440 Hz WAVs, silent MP3) — unsuitable
  for a real transcription acceptance.
- **Real Persian speech candidates (outside the repo, never to be git-added):**
  - `C:\Users\s.tabatabaei\Documents\saberprojects\iranseda-corpus-wt\downloads\asr\roshan\3\sample_90s.mp3` — 720,429 B, 90 s, radio Ma'aref (public-corpus sample)
  - `C:\Users\s.tabatabaei\Downloads\دو بال علم و عمل.mp3` — 4,003,930 B (downloaded 2026-11-06 ~21:21 local, i.e. minutes before mission start)
  - `C:\Users\s.tabatabaei\Downloads\دو بال علم و عمل(1).mp3` — 2,648,656 B (~21:22 local)
- The two fresh Downloads MP3s are minutes-long (mission prefers 10–30 s) and
  are private user files. Per the mission clause ("if no suitable file
  exists, ask the user"), **the file choice will be confirmed with the user in
  Stage 4** before submission.

## 8. Known risks carried into the mission

| #   | Risk                                                                 | Mitigation stage                                                                                                    |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1  | Running 4871 is pre-fix code **and** spawn-broken (0xC0000142)       | Stage 1 controlled restart from the active terminal; observe first spawn                                            |
| R2  | france1 long-held tunnel instability (3/3 historical audio failures) | Stage 3 fresh diagnostics; Stage 4 runbook: early-stop at 15 min, cancel before the 30-min timeout, no blind re-run |
| R3  | England_1 `read ECONNRESET` history                                  | Stage 3 fresh test (≤1 controlled test/node)                                                                        |
| R4  | Session TTL expired (no eligible account right now)                  | Stage 2 official re-verify; re-check eligibility immediately before the job                                         |
| R5  | Chrome running → browser-import blocked if re-login is needed        | Documented; ask user to close Chrome only if Stage 2 requires it                                                    |
| R6  | Possible duplicate-notebook ambiguity on timeout                     | Check DB + NotebookLM state before any re-run; cancel cleanly first                                                 |

## 9. Backups taken this stage (pre-mission)

- `data/backups/nlo-pre-phase2-2026-11-06T20-18Z.sqlite` (143,360 B) +
  `nlo-pre-phase2-2026-11-06T20-18Z-wal.sqlite-wal` (3,213,632 B) — DB copy
  before the Stage 1 restart.
- Git bundle: **not needed** — working tree is fully clean (0 uncommitted
  changes, 0 untracked, no stashes); `origin/main` already holds all work.
  Recorded honestly rather than producing a redundant artifact.

## 10. Compliance with mission Phase 0 requirements

- [x] Git state captured (path, branch, HEAD, origin URL, origin/main, status, stashes, latest commits)
- [x] Local ↔ GitHub sync verified via `git fetch` (prior SHAs treated as references only)
- [x] Three-environment matrix captured (Local / GitHub / Production **read-only**)
- [x] No deploy / restart / configure performed on Production
- [x] Uncommitted changes backed up (none exist — verified, bundle N/A)
- [x] `.env`/DB/data checked by **names and status only**; no values printed
- [x] No files deleted without confirmation
- [x] All evidence read-only (DB opened `readOnly:true`)

**Next:** Stage 1 — local stabilization: controlled restart of 4871
(backup log → verify PID 6932 identity → kill tree → relaunch from active
terminal → health + OpenAPI/Swagger extraction → real worker verification).
