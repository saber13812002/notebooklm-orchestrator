# Phase 2 — Stage 2: Google Account & Session Verification (NLO-PHASE-2-AUDIO-LIVE-2026-11)

**Date:** 2026-11-06 (evidence window 21:08–21:22 UTC; re-auth 23:05–23:08 UTC)
**Result:** **PASS (after user action).** Initial verify was **BLOCKED — USER
ACTION REQUIRED** (stored session rejected by the real NotebookLM service:
credentials expired, not our 10-min cache TTL). The user chose recovery
**Option A (browser-import)**; after the user's Chrome was fully closed,
`POST /api/sessions/…/browser-import` succeeded and the official re-verify
**passed against the real service** (453 notebooks). Session is now
`AUTHENTICATED`, `sessionUsable:true`. See §6.

---

## 1. Account & session audit (via API, redacted)

`GET /api/sessions` + `GET /api/accounts` (live, post-restart):

| Account                | Label    | email (display)                  | Default | Account status | Session id / state                                                     | lastVerifiedAt           | sessionUsable (10-min TTL) | Stored session file                  |
| ---------------------- | -------- | -------------------------------- | ------- | -------------- | ---------------------------------------------------------------------- | ------------------------ | -------------------------- | ------------------------------------ |
| `acc_9ef8fd4d431c49fc` | sas      | `saber.tababa…@gmail.com`        | **yes** | AUTH_REQUIRED  | `sess_af33bf051ce04892` AUTH_REQUIRED                                  | 2026-10-23T02:52:36Z     | **no**                     | yes (12,139 B, 10/23)                |
| `acc_315776aeb5b74e33` | صابر     | `saber.tabatabaee@gmail.com`     | no      | DEGRADED       | `sess_8f079d7e3ebe4abc` AUTHENTICATED → **AUTH_REQUIRED after verify** | was 2026-11-06T03:04:33Z | **no**                     | **yes (21,055 B, 11/6 06:35 local)** |
| `acc_f95b0872c0d344cc` | صابر1404 | `sabar.tabatabaei1404@gmail.com` | no      | AUTH_REQUIRED  | `sess_5e495357abcd4482` AUTH_REQUIRED                                  | null                     | **no**                     | **no**                               |

Cookies/session values were **never printed**; only IDs, states, timestamps.

## 2. Official re-verification (mission 2.3–2.5)

- Chosen account: `acc_315776aeb5b74e33` (صابر) — the only account with a
  stored session file and a prior live success (H1 text, `provenance:"real"`).
- Endpoint used (official, via API — not manual cookie handling):
  `POST /api/sessions/acc_315776aeb5b74e33/verify`
- Flow executed by the server (observed in `tmp\dev4871-phase2.log`):
  1. proxy self-heal: staged health checks on both nodes against the real
     target (see Stage 3), **france1-SeyedSaber selected** (tunnel
     `127.0.0.1:52217`);
  2. real python worker spawned (`acct:acc_315776aeb5b74e33`, pid 10800),
     ping ok;
  3. `op=verify` sent with `timeoutMs=300000` (5-min hard cap);
  4. worker responded `code=auth` (real service response, NOT a network
     failure);
  5. clean shutdown (`exit … SIGTERM pending=0`, cleanup).
- **HTTP result (21:21:36 UTC):**

```json
{
  "ok": false,
  "email": null,
  "detail": "session rejected by service (re-login required): Authentication expired or invalid. https://notebook.google.com/ served a signed-out page, and its sign-in check redirected to https://accounts.google.com/<redacted>…",
  "mismatch": false,
  "session": {
    "id": "sess_8f079d7e3ebe4abc",
    "state": "AUTH_REQUIRED",
    "lastVerifiedAt": "2026-11-06T03:04:33.282Z",
    "lastError": "session rejected by service (re-login required)…"
  }
}
```

### Interpretation (root cause, evidence-backed)

- This is **NOT** the 10-min eligibility cache
  (`apps/server/src/domain/auth-sessions.repo.ts:131` `isUsable(ttlMs=10*60*1000)`
  — that gate produces "no eligible google account…" at job-run time, Stage 2 §3).
- The **stored credentials themselves are expired**: the real NotebookLM
  front-end served a signed-out page and redirected to
  `accounts.google.com`. The cookies in the 21 KB storage-state file no longer
  authenticate. A re-login (or cookie re-import) is the only recovery path.
- The session row transitioned AUTHENTICATED → **AUTH_REQUIRED** (correct
  state machine behaviour; `lastError` recorded, no cookies leaked).

## 3. Eligibility re-check before any job (mission 2.5)

Performed with a **diagnostic no-audio job** (`POST /api/jobs`, prompt only):

- Job `j_ac986702272c42f8b85af59c302e91b7` → 201 CREATED (21:08:18.252Z) →
  **FAILED in 26 ms** with:
  - `errorClass: "auth"`,
  - `errorMessage: "no eligible google account with a verified session"`,
  - events: `created → validate → no_account` ("no eligible account with
    verified session"),
  - `accountId: null, nodeId: null, attempts: []` — the job **never reached
    the proxy/worker stage** (no network, no notebook risk, no ambiguity).

**Root-cause trace of the mission's target error (mission 4.x):** the
`no eligible google account with a verified session` message is produced in
`apps/server/src/queue/job-runner.ts` `selectAccount()` (eligibility resolver,
~L389-440): it filters accounts by `sessions.isUsable()` (state
AUTHENTICATED + `lastVerifiedAt` within 10 min). It is **server-side, before
any provider call** — not a frontend or provider defect. In the current state
(0 accounts with a fresh verified session) it fires **by design**. Once Stage 2
re-authentication succeeds and the session is re-verified, the same job path
will select the account and proceed to the proxy/worker stages. No code change
is required for the eligibility gate itself; the missing input is a valid
Google credential.

## 4. Recovery options (all official, no cookies pasted in chat)

| Option                          | Endpoint                                                                                              | Precondition                                                                                                                                                                                        | Status                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A. Browser cookie import        | `POST /api/sessions/{id}/browser-import` (notebooklm-py CLI reads the user's real browser cookie jar) | **user's Chrome fully closed** (cookie DB lock; Chrome currently running, 24 procs); allowed browsers only (`BROWSER_COOKIE_NAMES` allowlist in `nbl_worker.py:258-260`); session file written 0600 | Available                       |
| B. Interactive Playwright login | `POST /api/sessions/{id}/login` (a real browser window opens; user signs in)                          | needs a launchable browser channel — bundled Chromium is **missing** (Stage 1 §5 gap); installed `chrome`/`msedge` channels exist and are accepted by the API (`browser:"chrome"                    | "msedge"`)                      | Available with channel override |
| C. Paste storage-state JSON     | `POST /api/sessions/{id}/import`                                                                      | user exports a JSON storage-state                                                                                                                                                                   | Available (user must supply it) |

## 5. PASS/FAIL — Stage 2

| #   | Criterion                                                                       | Result                                                                                                                        |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every account audited (masked IDs, state, last-verified, usability, last error) | **DONE** (§1)                                                                                                                 |
| 2   | TTL understood and verified in code                                             | **DONE** (`isUsable` 10 min, `session-gate.test.ts` covers stale-flag rejection)                                              |
| 3   | Official API verify executed, real NotebookLM result obtained                   | **DONE** — real service response: **credentials expired**                                                                     |
| 4   | Timestamp recorded                                                              | `2026-11-06T21:21:36.971Z` (session `updatedAt`)                                                                              |
| 5   | Eligibility re-checked immediately before job                                   | **DONE** — 0 eligible accounts; job failed fast at the auth gate with the exact mission-target error, no network side-effects |
| 6   | No cookies requested in chat, no secret printed                                 | **DONE**                                                                                                                      |
| 7   | Recoverable without user?                                                       | **NO** → **STOP — USER ACTION REQUIRED**                                                                                      |

**Next (at time of writing):** STOP and ask the user to choose recovery
option A/B/C (and, for A: close Chrome). Stage 3 (proxy diagnostics) is
independent of this and is reported in
`PHASE_2_STAGE_3_PROXY_DIAGNOSTICS.md`.

## 6. Re-authentication (user-chosen Option A) — 2026-11-06 23:05–23:08 UTC

**User decision (21:52 UTC):** "A: I'm closing Chrome now (I'm signed in to
NotebookLM in it) — run browser-import, then re-verify and proceed to the one
real audio job."

### 6.1 Chrome pre-flight (cookie DB lock)

- Chrome was **not** actually closed across three re-checks (22:43, 22:47,
  22:54 UTC): 24 `chrome.exe` processes alive, all from one window —
  PID 36728, started 06:57 local, title
  `دستیار پژوهش در آثار علامه مصباح` (a NotebookLM tab), **minimized**
  (detected via `GetWindowPlacement`, showCmd=2) on a different virtual
  desktop, so manual close attempts affected other windows only.
- With explicit user approval, the whole Chrome tree was force-killed
  (`taskkill /F /IM chrome.exe`, 23:05:58 UTC): **24 → 0 processes**.

### 6.2 Browser import (one attempt)

- `POST /api/sessions/acc_315776aeb5b74e33/browser-import`, body
  `{"browser":"chrome::Profile 3","timeoutSec":180}` — the P0-proven spec
  (P0 attempt #4 passed with the same target; the cookie JAR read is a local
  disk read and does not traverse the tunnel).
- **HTTP 200 in 53 s** (23:06:11→23:07:04 UTC):

```json
{"session":{"id":"sess_8f079d7e3ebe4abc","state":"AUTHENTICATED",
 "email":"saber.tabatabaee@gmail.com","lastVerifiedAt":"2026-11-06T23:07:24.889Z",
 "lastError":null,"hasStoredFile":true},"mismatch":null,
 "routingNote":"cookie jar read from your local browser (direct); the session
 verification and all NotebookLM requests use the configured tunnel"}
```

- Worker log (`tmp\dev4871-phase2.log`, correlation
  `browser-import:acc_315776aeb5b74e33`, pid 26080):
  `request sent id=2 op=browser-import timeoutMs=300000` →
  `response ok id=2 op=browser-import` → `exit … SIGTERM pending=0`,
  `cleanup: child pipes closed`.
- Honest caveat: the CLI's internal cookie-verify emitted
  `Could not verify cookies due to network error` (the CLI's own verify step
  uses direct egress, which is blocked on this host — fail-closed policy).
  This is **non-blocking by design**: the route's authoritative check is the
  server-side verify through the tunnel (§6.3), which passed.

### 6.3 Official re-verify (real service)

- `POST /api/sessions/acc_315776aeb5b74e33/verify` — **HTTP 200 in 8 s**
  (23:07:43→23:07:51 UTC):

```json
{
  "ok": true,
  "email": "saber.tabatabaee@gmail.com",
  "detail": "verified against service (453 notebooks)",
  "mismatch": false,
  "session": {
    "state": "AUTHENTICATED",
    "lastVerifiedAt": "2026-11-06T23:07:51.195Z",
    "lastError": null
  }
}
```

- Worker log (correlation `acct:acc_315776aeb5b74e33`, pid 14804,
  france1 tunnel `127.0.0.1:60890`): `op=verify timeoutMs=300000` →
  `response ok id=2 op=verify` → clean shutdown `pending=0`.

### 6.4 Eligibility confirmed (immediately before job)

- `GET /api/sessions` (23:08 UTC): `acc_315776aeb5b74e33` →
  **`sessionUsable:true`**, `AUTHENTICATED`, `lastVerifiedAt
2026-11-06T23:07:51.195Z` (within the 10-min TTL of
  `auth-sessions.repo.ts:131`). The other two accounts remain unusable
  (`sas` AUTH_REQUIRED since 10/23; `صابر1404` AUTH_REQUIRED, no stored
  file) — they are not selected; the job uses the preferred account.

### 6.5 Stage 2 final status

| #   | Criterion                                               | Result                                     |
| --- | ------------------------------------------------------- | ------------------------------------------ |
| 1–6 | (as in §5)                                              | **PASS**                                   |
| 7   | Re-authentication completed via official API (Option A) | **PASS** — §6.2/6.3, real service response |
| 8   | `sessionUsable:true` confirmed before Stage 4           | **PASS** — §6.4, 23:08 UTC                 |

**Stage 2 result: PASS (user action required and performed). Proceeding to
Stage 4 (one real audio job).** Note: the user's Chrome was force-killed per
their instruction; any unsaved tabs from the morning session (e.g. the
minimized NotebookLM tab) were not restored — the import only reads cookies,
and the session file is intact (`hasStoredFile:true`, 0600).
