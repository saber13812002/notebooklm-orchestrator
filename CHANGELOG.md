# Changelog

All notable changes to the NotebookLM Orchestrator are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is commit-based (no semantic versions yet — tags are the next
step in the API productization phase).

Honesty rule: an entry may say "implemented" only with tests; "live-verified"
only with a recorded live run; otherwise "planned".

## [2026-11-06] — Mission NLO-PHASE-2-AUDIO-LIVE-2026-11: real audio live acceptance — **LIVE AUDIO VERIFIED** (local, no code changes)

### Verified (live — real NotebookLM, local dev server 4871)

- **One real Persian audio job, end-to-end, SUCCEEDED.**
  `j_367ea5baa8382e2ec42d7a29dcfe5b3b` — multipart `POST /api/jobs` with
  user-selected `sample_90s.mp3` (720,429 B, `audio/mpeg`, SHA-256
  `85de5f0a…0748a`, integrity byte-identical in `input_json`) → HTTP 201 →
  account gate (fresh verified session) → france1 VLESS tunnel → python
  worker → **real NotebookLM**: notebook + audio source uploaded
  (`uploaded:true`), conversation turn 1 → verbatim Persian transcript.
  **50.2 s total**; attempt 1 outcome `ok`.
- **Provenance: real.** DB row: `result_provenance="real"`,
  `result_provider_meta_json.simulated=false`,
  `provider="python-worker"`, real notebook/source/conversation IDs;
  `GET /api/jobs/{id}/result` → `provenance:"real"`; job visible in the
  Web UI data feed.
- **Google session re-auth (browser-import)** unblocked the run:
  `chrome::Profile 3` import (200, 53 s) after the user's Chrome was
  force-killed with explicit approval (cookie-DB lock); official
  re-verify against the real service: `ok:true, "verified against service
(453 notebooks)"`; `sessionUsable:true` at submission.
- **Proxy diagnostics:** france1 healthy (staged check PASS 771 ms) and
  carried the job live; England_1 rejected by the selector
  (`read ECONNRESET`) — no node mutated.
- **Regression:** all suites green after the run — `npm test` 227/227
  (shared 53 / server 144 / web 30), `typecheck`, `lint`, `format:check`,
  `build` (Stage 5).

### Notes

- **Zero code changes** in this mission — operational actions + report
  documentation only (no root-cause fix was required: no code failure was
  found). The mission-target error `no eligible google account…` was
  confirmed as the by-design 10-min session-eligibility gate, satisfied by
  a fresh verify.
- Honest caveats: MP3 worked live but is not in the provider's
  provider-verified extension list (label stays `.wav`); the P0 15–17 min
  long-hold failure mode was **not** reproduced and is **not** claimed
  fixed; audio-file content was never printed or committed; no secrets in
  any report/commit.
- Scope: **local only** — production `172.30.0.133` untouched; GitHub
  source of truth updated by docs-only FF push; GitLab check-only (mirror
  inactive).
- Reports: `docs/reports/PHASE_2_STAGE_0_BASELINE.md` …
  `PHASE_2_STAGE_5_REGRESSION.md`, plus the consolidated
  `PHASE_2_AUDIO_LIVE_ACCEPTANCE.md` (27 sections, final status
  `COMPLETE — LIVE AUDIO VERIFIED`).

## [2026-11-06] — Mission NLO-MASTER-2026-11, Phase 1 stabilization: worker-wedge fix + 14 regression tests + repo hygiene + credential scan

### Fixed

- **Worker timeout/kill queue wedge** in
  `apps/server/src/providers/python-worker/worker.ts`: the old timeout
  handler deleted the pending entry _before_ `kill()`, so a timed-out
  request could never settle and the single-worker queue wedged until
  restart. The worker now has a **settle-once contract**: every pending
  request is settled exactly once (response, error, timeout, abort,
  stdin-write failure, worker exit, or `close()`); settlement happens
  **before** the worker is killed; `close()` and unexpected exit fail all
  in-flight requests with a structured error; stale late responses are
  dropped as orphaned (no duplicate delivery); SIGTERM→SIGKILL
  escalation is tracked and cleared deterministically; every structured
  log line (spawn, request sent, response, timeout, kill, exit, cleanup)
  carries a **correlation id** (e.g. `job:<jobId>`, `login:<accountId>`).
  No protocol change; no schema change.
- **Orphaned-job recovery on restart**: in-flight jobs are reset to
  `QUEUED` at boot (`recoverInFlight()`, existing columns — no
  migration) with a `restart_recover` event, so a restart never leaves a
  job stuck in `RUNNING`/`RETRY_WAIT`/….

### Added

- **14 regression tests** (fake child processes — no venv, Windows-safe):
  `apps/server/test/worker-supervisor.test.ts` (10: normal path, timeout
  settle-before-kill, dual in-flight timeout, late-response drop, crash,
  early-exit/EOF, SIGTERM-ignore escalation, abort, correlation-id log
  audit, `close()` with in-flight request) and
  `apps/server/test/worker-queue-recovery.test.ts` (4: timeout →
  `NEEDS_ATTENTION` + queue continues; crash → `FAILED` + queue
  continues; single-worker serialization; restart orphan recovery →
  re-run to `SUCCEEDED`), plus the `apps/server/test/fixtures/fake-worker.mjs`
  fixture.

### Verified (mock level — Live NOT verified)

- Full suite: **227 tests / 25 files, 0 failed** (before: 213 / 23);
  `npm run typecheck`, `npm run lint`, `npm run format:check`, and
  `npm run build` all clean.
- **B1 resolved:** the local Python venv (spawn failure `0xC0000142`) was
  repaired out-of-band; the real-worker non-ASCII protocol test
  (`worker-nonascii-protocol.test.ts`) now **runs** (not skipped) and
  passes. Dev server 4871's `configured:false` is stale (process predates
  the repair); restart is an approval-gated action, not performed.
- **1.2 login/session verification (read-only, code-level):** browser
  import is allowlist-restricted (11 browsers); multi-account is
  per-account-by-email; failed auth returns 401 `AUTH_REQUIRED` — a
  failed login **never** creates a fake successful job; the 10-minute
  session TTL is **cached eligibility** (not credential expiry); the
  API/UI never expose cookie values.
- **1.3 LiteLLM credential hygiene (redacted scan, values never printed):**
  no LLM-key env var exists — the key is passed per request via
  `opts.apiKey` → `Authorization: Bearer`. The previously-leaked key was
  found **only** in two untracked, git-ignored files:
  `tmp/myterm.env.txt` and `tmp/server12848.env.json`. Git history
  contains only the 7-char masked prefix `sk-51Rk` (in the P0 report),
  never the full key. `.env` is git-ignored and holds no LLM key.
  **Recommended user action (NOT performed):** rotate the LiteLLM key and
  delete/scrub the two `tmp/` files.

### Notes

- Repo hygiene: 287 staged scratch files unstaged; `.gitignore` additions
  (`tmp/`, scratch artifacts) — commit `ed2868b`.
- No deployment performed; no production changes. Full report:
  `docs/reports/PHASE_1_STABILIZATION.md`.

## [2026-11-06] — Live acceptance attempt #5 (سaber, `acc_315776aeb5b74e33`) — P0 audio final retry: BLOCKED (long-connection failure reproduced); orphan job cleaned up

### Status

- **P0 audio live — still NOT verified (BLOCKED).** Final authorized
  audio retry `j_10d3fbe7c2f97890dfc4932fa3d951fa` (fresh 20 s WAV,
  640044 bytes, multipart `POST /api/jobs`) → `RUNNING`/progress 55
  from 03:05:28 UTC; at 03:06:36 the worker hit `RPC GET_NOTEBOOK
(RemoteProtocolError)` ("retrying 1/3") and then made **zero
  progress for 16+ min** through the source-processing phase — the
  same long-connection failure pattern as attempt #4, now reproduced
  3/3 on long ops. Early-stopped at the 15-min mark (03:20:14 UTC)
  per the runbook; `POST /api/jobs/:id/cancel` → terminal
  `CANCELLED` 03:22:47 UTC (clean: worker timeout had not fired).
  No notebook/source/conversation ids, no `answer_markdown`,
  `provenance=unknown`. H1 text remains LIVE-verified (attempt #4).
  Evidence: `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` §14.
- **Orphan cleanup (attempt #4 job) — done.**
  `j_94d3689555e347e409b5ad9f9734b23f` was left `RUNNING`/progress 55
  with no re-schedule. The cancel API returned `cancelled:true` but
  the job stayed non-terminal: root cause is that in
  `apps/server/src/providers/python-worker/worker.ts` the per-request
  timeout timer deletes the pending entry **before** `kill()`/
  `failAll()`, so the request Promise never settles — the in-process
  queue wedges (`Queue.busy` stuck) and cancel's `onAbort` is a
  no-op. Terminalized the row to `FAILED`/`worker_timeout` after a DB
  backup (`data/backups/nlo-pre-retry5-2026-11-06T02-52Z.sqlite`),
  then force-restarted the dev server to un-wedge the queue.
  (Code fixes documented as follow-ups — not implemented here.)
- **Session re-verify — PASS.** `POST /api/sessions/:id/verify`
  (import refused from `AUTHENTICATED`) succeeded after 3 transient
  fail-closed 500s (both tunnels 15 s health-check timeouts):
  "verified against service (452 notebooks)",
  `lastVerifiedAt=2026-11-06T03:04:33.282Z`.

## [2026-11-06] — Live acceptance attempt #4 (سaber, `acc_315776aeb5b74e33`) — environment unblocked; H1 text LIVE-verified; P0 audio BLOCKED

### Status

- **H1 text live — LIVE VERIFIED.** Job
  `j_27d5753a15ed88a3d06072f03c4aebe6` via
  `POST /api/v1/notebooks/from-text` (Persian canary text,
  `summary.enabled=true`, default master prompt v1) → SUCCEEDED in
  ~28 s against real NotebookLM: real notebook/source/conversation
  ids, `provenance: "real"`, `simulated: false`, genuine structured
  Persian summary with `[1]` source references, DB persistence
  confirmed. Account `سaber` (`acc_315776aeb5b74e33`,
  `saber.tabatabaee@gmail.com`), routed via `france1-SeyedSaber`.
  Evidence: `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md` §14.
- **P0 audio live — still NOT verified (BLOCKED).** All 3 multipart
  `POST /api/jobs` submissions failed: #1
  `j_b45e039af33911ea2de580b7e9d14268` FAILED (auth) — repeated
  `GET_NOTEBOOK ConnectTimeout` through the france1 tunnel, and the
  queue's connectivity retry ran after the 10-min session TTL had
  expired; #2 `j_7f10a3c5f6c524600187882878d86711` FAILED (auth,
  instant) — submission error (stale `lastVerifiedAt`; re-import was
  refused from the `AUTHENTICATED` state and no re-verify was run);
  #3 `j_94d3689555e347e409b5ad9f9734b23f` — worker hit repeated
  `GET_NOTEBOOK RemoteProtocolError`, was force-killed at the 30-min
  worker request timeout, and the job was left orphaned at
  `RUNNING`/progress 55 (no queue re-schedule observed). Root cause:
  unstable france1-SeyedSaber tunnel on long-held connections,
  interacting with the 10-min session TTL. 2-retry budget exhausted.
  Evidence: `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` §13.
- **Auth (browser-import) — PASS.** `chrome::Profile 3` import → 200
  `AUTHENTICATED` (`lastVerifiedAt=2026-11-06T01:07:59.259Z`), later
  re-verified via `POST /api/sessions/…/verify` ("verified against
  service (452 notebooks)", `lastVerifiedAt=01:25:41.224Z`).
- **Environment unblocked:** stale Chrome PID 8392 killed (34
  processes; Profile 3 cookie DB unlocked); dev server 4871 restarted
  (pid 18492 → 45412, SessionId 2) with `provider.issues` clean — no
  further 0xC0000142/3221225794 worker-spawn failures.
- **Ops note:** orphaned job `j_94d3689555e347e409b5ad9f9734b23f`
  remains `RUNNING` in `data/nlo.sqlite` (worker dead, session TTL
  lapsed) and should be cancelled/marked failed by a follow-up ops
  action; it cannot complete.

### Re-verify (P0 audio only)

1. Keep Chrome closed; verify `france1-SeyedSaber` is stable for
   long-held connections (e.g., `POST /api/proxies/node_23e81d9a6ca04d10/health`
   green) before submitting.
2. Fresh `browser-import` (or `POST /:id/verify` if already
   `AUTHENTICATED`) → confirm a fresh `lastVerifiedAt`.
3. Within the 10-min TTL submit the P0 audio job (fresh 15–30 s WAV,
   multipart `POST /api/jobs`,
   `preferredAccountId=acc_315776aeb5b74e33`).

## [2026-11-06] — Live acceptance attempt #3 (سaber, `acc_315776aeb5b74e33`) — BLOCKED: 0xC0000142 at proxy spawn

### Status (no flows verified this attempt)

- **Live acceptance NOT completed.** Browser-import for `سaber`
  (`acc_315776aeb5b74e33`, `saber.tabatabaee@gmail.com`) via
  `POST /api/sessions/…/browser-import` (`chrome::Profile 3`, 180 s) was
  **fired** (unlike attempt #2, which was gated pre-flight) and returned
  **HTTP 401 in 1.08 s**: `browser import failed: proxy route unhealthy
(fail-closed): England_1: xray exited early (code=3221225794,
signal=none)`. The failure occurred at the **xray tunnel spawn** during
  the staged proxy health check — before any cookie read and before any
  python worker spawn. No profile-variant retry (the error is not
  cookie-related). No P0 audio or H1 text job was submitted (auth
  precondition not met; report + STOP per protocol).
- **Both live flows remain NOT verified** (status unchanged):
  - P0 audio live — **NOT verified** (see `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` §12).
  - H1 text live — **NOT verified** (see `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md` §13).
- **Hazard confirmed in a new form:** `query session` showed session 2 =
  `Disc` for the whole attempt (00:34–00:43 UTC) despite a reported
  re-attach at 00:33 UTC. On that `Disc` session the xray health-check
  spawn exited `0xC0000142` (3221225794) — the RDP-disconnect spawn
  hazard, previously observed only on python worker spawns, now also
  killing **xray spawns**, which trips the fail-closed egress gate and
  refuses any live op (correct behavior, surfaced as a clean error).
- **Secondary blocker (would fail next):** the 2026-11-04 Chrome
  instance (PID 8392) was still running — 32–33 `chrome.exe`, with
  `Profile 3\Network\Cookies` mtime actively updating at check time — so
  the cookie DB exclusive lock from attempt #2 was still in place.
- Server-side truth at stop (00:43 UTC): `سaber` → `AUTH_REQUIRED`,
  `lastVerifiedAt: null`, `sessionUsable: false`, `hasAuth: false`, no
  session file.

### Re-verify (exact unblock, then re-run)

1. **Fully close Chrome** (kill the 2026-11-04 instance, PID 8392);
   verify `tasklist | findstr /I chrome` is empty.
2. **Re-attach RDP so session 2 = `Conn`/`Active` before firing the
   import** — attempt #3 proved the proxy gate fails closed at xray
   spawn (0xC0000142) on a `Disc` session.
3. Re-run browser-import for `acc_315776aeb5b74e33` → confirm
   `GET /api/sessions` shows `AUTHENTICATED` + fresh `lastVerifiedAt`
   → immediately (10-min TTL) submit both acceptance jobs.
4. On success, flip the P0 + H1 "Live NOT verified" lines to
   "Live verified" here and in the two phase reports.

## [2026-11-05] — Live acceptance attempt #2 (browser-import + P0 audio + H1 text) — BLOCKED

### Status (no flows verified this attempt)

- **Live acceptance NOT completed.** The second attempt to authenticate
  `sas` (`acc_9ef8fd4d431c49fc`) via `POST /api/sessions/…/browser-import`
  (`chrome::Profile 3`) was **not fired** because a pre-flight check found the
  user's Chrome still running (32 `chrome.exe` processes, PID 8392 = the
  active, visible **Profile 3** window) holding an **exclusive lock** on
  `Profile 3\Network\Cookies`. Probed with the importer's exact access
  pattern: `shutil.copyfile`/`sqlite3 ro`/copy+`sqlite3` all fail
  (`PermissionError [Errno 13]` / `unable to open database file`). Per the
  acceptance protocol the import was skipped (a guaranteed
  "browser database is locked") and **no P0 audio or H1 text job was
  submitted**. Server-side truth at stop: `sas` still `AUTH_REQUIRED`,
  `lastVerifiedAt 2026-10-23` (13 days old), `hasAuth: false`.
- **Both live flows remain NOT verified** (status unchanged):
  - P0 audio live — **NOT verified** (see `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` §11).
  - H1 text live — **NOT verified** (see `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md` §12).
- **Latent hazard observed:** while session 2 dropped to `Disc`, a worker
  spawn on the 4871 dev server exited `0xC0000142` (3221225794) — the known
  RDP-disconnect spawn hazard.

### Known limitation (UI Login button removed — follow-up needed)

- `f8a9ba4` ("single-user local app — remove admin token + auth gate") removed
  the interactive **Login** button (`doLogin`/`sessionLogin`, `LogIn` icon)
  from `apps/web/src/features/accounts/accounts.tsx` **without a
  replacement**. The accounts page no longer offers the browser-based
  sign-in flow, leaving **browser-import** as the only in-UI path to
  authenticate an account — which now also surfaces (correctly, thanks to
  this release's worker fix) a hard dependency on Chrome being fully closed.
  A follow-up commit should restore the Login button (or re-export the same
  `sessionLogin` flow). **Documented as a known limitation; fix not yet
  landed.**

### Re-verify (exact unblock, then re-run)

1. Fully close the user's Chrome (esp. the visible Profile 3 window);
   verify `tasklist | findstr /I chrome` shows no Profile 3 holder.
2. Re-attach RDP (session 2 → `Conn`) to avoid the 0xC0000142 spawn hazard.
3. Re-run browser-import → confirm `GET /api/sessions` shows `AUTHENTICATED`
   - fresh `lastVerifiedAt` → immediately submit both acceptance jobs
     (10-min session TTL).
4. On success, flip the P0 + H1 "Live NOT verified" lines to
   "Live verified" here and in the two phase reports.

## [2026-11-05] — Worker protocol encoding fix (auth)

### Fixed

- **Python worker crashed (exit `0xC0000005`) when any op error contained
  non-ASCII text** (e.g. Persian account/profile names such as `'صابر'`).
  `emit()` serialized protocol frames with `ensure_ascii=False`; on Windows
  the worker's stdout pipe uses the ANSI codepage (cp437), so the write
  raised `UnicodeEncodeError` inside the feed loop's error path, killed the
  loop, and the interpreter crashed at finalization — the real error (e.g.
  the browser-import "browser database is locked. Close your browser and try
  again.") was never delivered and the API reported a cryptic
  "python worker exited unexpectedly". Reproduced live on 2026-11-02
  (account `صابر1404`) and 2026-11-05 (account `sas`); fix is
  `json.dumps(obj)` (pure-ASCII frames, `\uXXXX` escapes parse identically)
  with a regression test (`worker-nonascii-protocol.test.ts`) that spawns
  the real worker and asserts a non-ASCII error is delivered and the worker
  stays alive (test fails with the pre-fix `0xC0000005` symptom).
  **Verified: unit/integration passed** (worker test runs locally where the
  venv exists; skipped otherwise). Note: browser-import on a machine whose
  Chrome is running still fails with the (now properly surfaced)
  "browser database is locked" error — close Chrome first.

## [2026-11-05] — Phase H1 (text-to-notebook API)

### Added

- **`POST /notebooks/from-text`** (both `/api` and `/api/v1` surfaces, scope
  `jobs:write`): create a notebook from a **text string** (JSON body
  `{ title?, text, metadata?, summary? }`). `text` is required and capped by
  `NLO_MAX_TEXT_CHARS` (default 200,000 code points — oversized ⇒ 400 with
  `details.maxTextChars`, reject-don't-split). Missing `title` is derived from
  the first non-empty line of the text. Empty `summary.prompt` applies the
  **versioned default master prompt (v1)**; a caller prompt is recorded as
  version `custom`. `Idempotency-Key` supported (token-scoped replay ⇒ 200 +
  `x-idempotent-replay`). Returns `202 { jobId, status, correlationId,
createdAt, statusUrl }`.
- **`GET /jobs/:id/result`** (scope `jobs:read`): consolidated H1 result —
  `{ jobId, status, notebook: { id, title, url, shareUrl }, source: { id },
summary: { text, promptVersion }, provenance: "real"|"mock"|"unknown" }`.
  `url`/`shareUrl` are **never fabricated** (null until a provider confirms).
- **Runner/provider wiring:** job-runner stores the text at
  `input/text-source.md` and passes `textPath` to the provider; python-worker
  gained the `job_text` op (notebooklm-py `sources.add_text`, verified present
  in notebooklm-py 0.8.5); mock provider extended deterministically
  (`mock_nb_*`/`mock_src_*`/`mock_conv_*`, text-only).
- **OpenAPI:** spec documents both new operations + `FromTextRequest`,
  `FromTextResponse`, `JobResult` schemas (54 ops; bidirectional drift test).
- **Frontend parity (small):** web create-job page gains a **متن مستقیم
  (text)** mode that calls the SAME `POST /api/notebooks/from-text` API
  (legacy surface, no business logic in the frontend); settings response now
  exposes read-only `defaults.max_text_chars`.
- `NLO_MAX_TEXT_CHARS` env var (default 200,000).

### Verified (mock level — Live NOT verified)

- Unit: `packages/shared/test/text-source.test.ts` (7 tests).
- Integration/E2E: `apps/server/test/from-text.test.ts` (11 tests, incl.
  2 full in-process E2E runs to SUCCEEDED with the mock provider),
  `apps/server/test/openapi-v1.test.ts` extended (30 tests total), web
  `create-job.test.tsx` extended (5 tests total). Full `npm test` green.
- **Live NOT verified:** a real NotebookLM text run requires the user's
  Google re-login (sessions expired — see Phase P0 report); runbook in
  `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md`.

## [2026-11-05] — Phase P0 (audio submission repair: preflight UX + 404 mapping)

### Fixed

- **Create-job preflight (web):** the new-job page now loads
  `GET /api/sessions` and, when the effective account (explicitly selected, or
  auto mode with no usable account) has no usable session, disables Submit and
  shows a warning with a link to `/accounts` instead of letting the job fail
  in the queue with `errorClass "auth"` (mirrors the runner's
  AUTHENTICATED + 10-min-TTL rule exactly).
- **404 for unknown account ids (server):** `AccountsRepo.getOrThrow` now
  throws `ApiError(not_found, 404)`, so session routes (`/verify`,
  `/refresh`, `/import`, `DELETE /api/sessions/:id`) return the standard 404
  envelope instead of a generic 500 `internal_error` when an unknown id
  (e.g. a pasted `sess_…` id) is used.

### Added

- `apps/server/test/sessions-404.test.ts` (6 tests) and
  `apps/web/src/features/jobs/create-job.test.tsx` (4 tests).
- `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` — reproduction evidence, root
  cause (expired Google sessions: all accounts `AUTH_REQUIRED`), fixes, and
  remaining blockers (user re-login, xray 0xC0000142 environment issue).

### Verified (mock level — Live NOT verified)

- Unit/Integration passed: full `npm test` 185/185 green; typecheck, lint
  (source tree), format (touched files), and build all clean. No real
  NotebookLM job was run to completion; live verification remains blocked on
  the user's re-login and the dev-box xray spawn failure.

## [2026-11-02] — Phase T0 (stuck files & jobs audit on the live new-host deployment, read-only)

### Verified (read-only)

- **Live deployment identity on `172.30.0.133`:** `nlo.service` active
  (running ~2 days) at commit `b5e9ad3`, loopback-only `127.0.0.1:4870`,
  `/api/health` + `/api/health/ready` OK, python-worker provider configured
  (not mock), xray runtime available, no resident worker process (spawned per
  job), DB `data/nlo.sqlite` (migrations 1–5), per-job layout `data/jobs/<jobId>/`.
- **Job inventory (API cross-checked with read-only DB, `mode=ro`):** exactly
  3 jobs, **all terminal** — `j_34ba…` SUCCEEDED (real provenance; 502
  `ADD_SOURCE_FILE` on attempt 1, auto-recovered on attempt 2), `j_6568…`
  SUCCEEDED (real provenance, clean run), `j_290f…` FAILED in 0.24 s at
  validation (`auth` — "session not verified"; 2026-10-26 E2E-P2, superseded
  by the two successful runs). No QUEUED / RUNNING / RETRY_WAIT /
  NEEDS_ATTENTION / CANCELLED jobs exist.
- **Stuck detection: nothing stuck.** All 3 source files present with
  sha256-matching checksums; no notebook-created-but-no-result cases;
  `artifacts` table empty (correct — text-answer jobs only); both delivered
  `answer.md` outputs present; the 3 identical-input jobs are the
  intentional 2026-10-26 E2E-P2 test trio, not accidental duplicates.
- **Account/session (no contents printed):** `acc_5a03a60bbda24085` ACTIVE
  - default; session `AUTHENTICATED` but last verified
    2026-10-26T17:27:11Z (≈ 7 days stale → freshness re-check required before
    the first live job); proxies: `france1-SeyedSaber` healthy (608 ms,
    2026-10-28, stale → re-check), `England_1` failing (`curl exited 35`) —
    manual review recommended; 1 secret ref (metadata only).
- **Retry table:** both SUCCEEDED jobs = keep as-is (terminal, real);
  `j_290f…` FAILED = **manual review, do NOT auto-retry** (7 days old,
  superseded, side-effect-free in principle but no API retry for terminal
  FAILED — only `NEEDS_ATTENTION` requeue).

### Added

- `docs/reports/PHASE_T0_STUCK_JOBS_AUDIT.md` — 12-section audit: live
  deployment identity, job inventory by state, stuck detection, missing files,
  existing artifacts, notebook relationships, account/session status,
  recovery actions, one recommended safe test candidate, retry table, STOP.

### Notes

- **Mandatory STOP honored:** no restart, deploy, job retry, file
  move/rename/delete, DB record change, session change, or config change.
  Recommended next step (awaiting approval): Scenario-1 live test — one small
  Persian audio file, end-to-end with per-step approval (new job, not a retry
  of `j_290f…`).

## [2026-11-02] — Endpoint-migration addendum, Phase G3-A (new production host secure access + read-only audit)

### Verified (read-only)

- **SSH access to the new production host `172.30.0.133` (`AI-TOOLS`) is
  provisioned and verified:** publickey login as `saber` (local `id_ed25519`),
  host key `ssh-ed25519 SHA256:BP+9ekCAA+LaalRmqt84JQydR+PUwx0GQ8a33t4U7WY`
  pinned; OpenSSH 9.6p1 (host) ↔ OpenSSH_for_Windows 9.5p2 (client), KEX
  `curve25519-sha256`. Passwordless sudo: **no** (firewall state therefore
  unverified — recorded limitation).
- **Host:** Ubuntu 24.04.4 LTS, kernel 6.8.0-147-generic, 20× Xeon Gold 6458Q,
  78 GiB RAM, 686 GiB disk (37 % used), uptime 2 days; Node v22.23.4 at
  `/home/saber/.local/node22/bin` (not on default PATH), Python 3.12.3,
  Docker 29.1.3, ffmpeg 6.1.1, git 2.43.0; systemd `degraded` due to one
  unrelated failed unit (`llmhub-feedback.service`).
- **NLO is already deployed and running on the new host** (found, not assumed):
  `nlo.service` active since 2026-10-31 07:10 UTC, bound **loopback-only**
  `127.0.0.1:4870`, deployed commit `b5e9ad3` (clean ancestor of `50b31e7`),
  `/api/health` + `/api/health/ready` OK (python-worker configured, xray
  runtime available, live egress disabled).
- **LiteLLM on `127.0.0.1:4000` (on-host, read-only):** liveliness + readiness
  healthy, `info.version = 1.101.0`, `/v1/models` 401 without key; **LLM key
  not provisioned** (no key/token/secret lines in the on-host `.env`); no
  inference sent.
- **Legacy s52 data already migrated and intact:** `data/` with `nlo.sqlite`
  (164 K), 5 DB + 5 `.env` backups (0600), `vault.key` (0600), `sessions/`
  (0700, 1 account), `vendor/xray` (40 M), `venv` (198 M, Python 3.12.3),
  3 historical job dirs. No copy/delete/migrate performed; no cookie or
  session contents printed.
- **Deployment prep:** `deploy.sh` (host-agnostic, already prepends
  `node22/bin`) and `nlo.service` (paths + Node PATH verified identical on
  host) require **no adaptation**; advancing to `50b31e7` is a clean
  fast-forward from `b5e9ad3`. On-host `.env`: loopback host/port,
  `NLO_ALLOW_DIRECT_EGRESS=1`, `NLO_INTERNAL_API_BASE_URL` absent (compiled
  default is correct).
- **Security findings (read-only):** live `.env` perms `0664` (recommend
  `0600` in G3-B); firewall unverified (no sudo); LiteLLM binds `0.0.0.0`
  (property of the LLM-proxy service, not NLO); no secrets in repo or on-host
  `.env`.

### Added

- `docs/reports/PHASE_G3A_NEW_HOST_AUDIT.md` — full audit: SSH verification +
  fingerprint, host inventory, running NLO state, LiteLLM verification,
  legacy data inventory (sizes/ownership/permissions only), deploy-file
  review, security findings, and the G3-B deploy/backup/rollback plan.

### Notes

- **Mandatory STOP honored:** no install, deploy, restart, `.env` change, DB
  migration, or firewall/proxy/TLS change was made. Awaiting explicit
  approval for G3-B (deploy to `50b31e7`).

## [2026-11-02] — Endpoint-migration addendum, Phases G1+G2 (live endpoint verification + production readiness)

### Verified (read-only)

- **G1 — live probes from the authorized company network:** TCP
  `172.30.0.133:4000` connected (112 ms); `GET /` 200 (LiteLLM Swagger UI);
  `GET /openapi.json` 200 (1,517,449 B; `info.version = "1.101.0"`);
  `/health/liveliness` 200 (3 ms); `/health/readiness` 200
  (`{"status":"healthy","db":"connected"}`, 2–6 ms over 5 calls);
  `GET /v1/models` without key → deterministic **401** `auth_error`
  ("No api key passed in.") — i.e. **TCP and unauthenticated HTTP are
  live-verified; authenticated `/v1/models` is NOT verified** (LLM key not
  provisioned; no inference request sent).
- **G1 negative control:** `172.30.0.133:4870` refused (NLO still not on the
  new host); DNS `nlo.ai.ismc.ir` A → `172.30.0.133` (TTL 600).
- **G2:** SSH port 22 open (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20`,
  15 ms; banner only, **no login attempted**); local ssh config/known_hosts
  audited (only legacy s52/jump53 entries — no new-host entry); deploy path
  (`deploy.sh` + `nlo.service`) host-agnostic and ready; `data/` + backups
  absent locally (fresh-host scenario).
- **G2 config sweep:** `NLO_INTERNAL_API_BASE_URL` default
  `http://172.30.0.133:4000` equals the live-verified endpoint; local `.env`
  does not set it; Docker/CI unaffected; client not yet wired into routes
  (Phase E scope). No configuration change made.
- **Regression:** `npm test` on `0e5b8b8` — **175/175** (shared 44 + server
  106 + web 25), including `config-internal-api` (5) and `internal-llm` (6,
  in-process mock — NOT live).

### Added

- Reports:
  [`docs/reports/PHASE_G1_ENDPOINT_LIVE_VERIFICATION.md`](docs/reports/PHASE_G1_ENDPOINT_LIVE_VERIFICATION.md)
  and
  [`docs/reports/PHASE_G2_PRODUCTION_READINESS.md`](docs/reports/PHASE_G2_PRODUCTION_READINESS.md)
  (initial state, commands+results, connectivity evidence, auth status
  without secrets, deployment SHA, config findings, missing credentials,
  backup/rollback readiness, risks, next action).
- [`docs/ROADMAP_MASTER.md`](docs/ROADMAP_MASTER.md) addendum table: G split
  into G1/G2 (done) + G3 (pending, hard approval gate).

### Notes

- Level: **Live (unauthenticated) + Unit/Integration** — mock suite 175/175;
  the live part never sent credentials or inference.
- **Mandatory STOP honored:** no production change, no restart, no `.env`
  change, no deployment, no DNS/proxy/TLS change. G3 is blocked on:
  (1) SSH access to `172.30.0.133` (user + credential, secure channel),
  (2) LLM API key via secret store, (3) on-host fact confirmation
  (paths, Node/Python, `data/` continuity). Awaiting explicit approval.

## [2026-11-01] — Endpoint-migration addendum, Phase F (local verification)

### Verified

- 4871 dev server restarted onto the full addendum tree
  (`3f796a6` + `30b03cd` + `6b9a3ab`, all on `origin/main`):
  `/api/health` and `/api/health/ready` pass (`ready:true`, provider
  `python-worker` configured, proxy runtime `xray` available, live tests
  disabled); web UI served (HTTP 200).
- Full regression on the final tree: **175/175** (shared 44 + server 106 +
  web 25).

### Notes

- Level: **local process verification + Unit/Integration — NOT live.** No
  live provider/egress or real `/v1/models` calls (LLM key still pending).
- Diagnostic: per-readiness worker `spawn → SIGTERM` in the 4871 log was
  investigated and confirmed as the designed transient-probe lifecycle of
  `validateConfiguration()` (clean exit, empty stderr) — not a regression.
- No deployment, DB, or runtime-config change; Phase G (production
  migration on `172.30.0.133`) remains a hard approval gate.
- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_F.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_F.md).
- Phase E commit `6b9a3ab` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase E (integration tests)

### Added

- New module
  [`apps/server/src/internal-llm.ts`](apps/server/src/internal-llm.ts):
  minimal client for the internal LLM proxy (LiteLLM, OpenAI-compatible).
  Every request targets `config.internalApiBaseUrl`
  (`NLO_INTERNAL_API_BASE_URL`) — no hardcoded host; only `/v1/...` paths are
  accepted; Bearer key sent only when provided; error messages contain only
  the target host, HTTP status, and the upstream `error.message` — never the
  key, never a stack.
- New tests
  [`apps/server/test/internal-llm.test.ts`](apps/server/test/internal-llm.test.ts)
  (6 tests, in-process `node:http` mock on 127.0.0.1 ephemeral ports):
  default base URL is the new host with no reference to the legacy
  `172.20.1.52` (string-level, no network); `GET /v1/models` with correct
  Bearer header + parsed 200 body; proxy down → `llm_unreachable` (clean
  message, no stack, no key); exact LiteLLM 401 envelope → `llm_error` with
  upstream message but no key/header leak; accept-but-never-respond →
  `llm_timeout` (AbortController); non-`/v1` paths (incl. traversal) rejected
  before any network call.

### Tests

- Level: **Unit/Integration — in-process mock HTTP, NOT live.** Full suite
  175/175 (shared 44 + server 106 + web 25).
- Live `/v1/models` against the real proxy remains a manual gate pending an
  LLM API key via secret store (carried to Phase F/G).

### Unchanged (explicit non-goals)

- No route/API surface, provider, DB, or deployment change — the client is a
  standalone module not yet wired into any route.
- No network traffic to any real endpoint from CI.

### Notes

- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_E.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_E.md).
- Phase D commit `30b03cd` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase D (documentation migration)

### Changed

- Migrated all **current operational** references to the legacy production
  host s52 (`172.20.1.52`) in: [`AGENTS.md`](AGENTS.md),
  [`README.md`](README.md), [`docs/operations/README.md`](docs/operations/README.md),
  [`docs/deployment/s52-deploy.md`](docs/deployment/s52-deploy.md),
  [`docs/wiki/13-developer-guide.md`](docs/wiki/13-developer-guide.md),
  [`docs/wiki/14-deployment-operations.md`](docs/wiki/14-deployment-operations.md),
  [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/api/README.md`](docs/api/README.md)
  (annotated), [`deploy/deploy.sh`](deploy/deploy.sh) (comment),
  [`deploy/systemd/nlo.service`](deploy/systemd/nlo.service) (comment).
- Phrased honestly per the migration state: legacy host s52 decommissioned
  (unreachable); **NLO is not yet running on the new host `172.30.0.133`**
  (re-deployment pending, addendum Phase G); GitLab/Wiki.js already re-homed;
  LiteLLM (`172.30.0.133:4000`) is the internal LLM proxy, **not** NLO.
- Dead guidance removed: standing s52 SSH tunnel (port 14870) no longer
  presented as working access.

### Unchanged (explicit non-goals)

- All `docs/reports/*` + historical CHANGELOG entries (class ② — verbatim
  historical records).
- Other-service references (class ③): `git.ai.ismc.ir`, `docs.ai.ismc.ir`,
  edge `80.191.92.189`, jump53.
- Every `4870` that is the **app's own port** (config default, Dockerfile,
  compose, CI smoke, vite, scripts) — untouched.
- `docs/deployment/s52-deploy.md` **filename kept** (links from
  `docs/operations/README.md`, wiki 14, README, CONTRIBUTING stay valid);
  content notes the filename is historical.
- No code, config, or runtime behavior change — docs/comments only.

### Notes

- Report + evidence:
  [`docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_D.md`](docs/reports/SERVER_ENDPOINT_MIGRATION_PHASE_D.md).
- Phase C commit `3f796a6` pushed to `origin/main` 2026-11-01 (approved).

## [2026-11-01] — Endpoint-migration addendum, Phase C (centralized config)

### Added

- `NLO_INTERNAL_API_BASE_URL` (default `http://172.30.0.133:4000`) in
  [`apps/server/src/config.ts`](apps/server/src/config.ts) →
  `config.internalApiBaseUrl`. Documented as the **internal LLM proxy
  (LiteLLM, OpenAI-compatible)** — verified 2026-11-01 (read-only) to be an
  LLM API endpoint, not the NLO web address/SSH/proxy. Normalized (trailing
  slashes stripped) and validated (http/https scheme required, fail fast).
- Unit tests: `apps/server/test/config-internal-api.test.ts` (default value,
  override + normalization, https, scheme validation).
- `.env.example` + README env-var table updated.

### Notes

- No runtime consumer yet — the prompt-engine phase (roadmap Phase 9) will
  read `config.internalApiBaseUrl`; no requests are made in this change.
- Audit + connectivity evidence: `docs/reports/SERVER_ENDPOINT_MIGRATION_AUDIT.md`,
  `docs/reports/SERVER_ENDPOINT_CONNECTIVITY.md`; mission: `docs/ROADMAP_MASTER.md`.

## [2026-10-28] — Phase C (API productization)

### Added

- OpenAPI 3.x contract: `/api/openapi.json` (and `/api/v1/openapi.json`) +
  Swagger UI at `/api/docs` (and `/api/v1/docs`), auth-exempt. Spec lives in
  `apps/server/src/api/openapi/spec.ts` and is asserted against the live
  route table in **both directions** by `apps/server/test/openapi-v1.test.ts`
  (no spec↔live drift in either direction).
- Versioned surface `/api/v1/*` mirroring the legacy resource model (52
  operations); the legacy `/api/*` surface is unchanged and un-gated.
- API tokens (C4): create/list/enable/disable/revoke at `/api/v1/tokens`,
  scopes (`jobs:read`, `jobs:write`, `jobs:cancel`, `jobs:download`,
  `meta:read`, `admin`), SHA-256-only storage, plaintext shown exactly once.
  Optional by default (loopback keeps working); `NLO_API_AUTH=1` enforces
  tokens on non-exempt v1 routes (401 + `auth_required`/`auth_failed` audit
  rows). Token management is always `admin`-gated (defense in depth).
- Per-token sliding-window rate limiting
  (`NLO_API_RATE_LIMIT_MAX`, `NLO_API_RATE_LIMIT_WINDOW_MS`) →
  `429 rate_limited` with `details.retryAfterSeconds` + audit row.
- Append-only audit trail (`api_audit_log`) queryable via
  `GET /api/v1/audit` (admin); anonymous traffic is never audited; token
  plaintexts never appear in the log.
- Idempotent job creation (C5): `Idempotency-Key` honored only with a
  resolved token (per-token scoped); replay → `200` +
  `x-idempotent-replay: true`, no duplicate job/archive.
- Correlation IDs: every `/api/v1` response carries `x-correlation-id`
  (echoed or generated `cr_<32hex>`).
- Docs: `docs/api/README.md` rewritten (auth model, scopes, cURL +
  runnable TypeScript client `docs/api/examples/client.ts` + Python
  example), `docs/wiki/08-api-authentication.md` and
  `docs/wiki/09-api-guide.md` updated, `.env.example` + root README
  updated.
- Migration `0005_api_tokens.sql` (api_tokens + api_audit_log tables).

### Fixed

- **Production bug (found by the new tests):** the v1 child-encapsulation
  `onRequest`/`onResponse` hooks were synchronous 2-arg functions;
  Fastify 5's hook runner only advances on a returned Promise or an explicit
  `next` call, so **every `/api/v1` request deadlocked** on a live server.
  Hooks are now async.
- `loadConfig(overrides)`: `NLO_*` integer/boolean vars were read from
  `process.env` directly, silently ignoring overrides (tests and any
  programmatic config injection were bypassed). `intEnv`/`boolEnv` now
  honor the override map.

### Verified

- `npm test` all workspaces green (152 tests: shared 44, server 83 incl. 24
  new, web 25); `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run build` all clean.
- Verification level: **Unit/Integration/E2E (in-process, mock provider)
  passed.** Live (`NLO_LIVE_TESTS`) remains a manual gate only.
- No push, no deploy: s52 continues serving from its current commit until
  a reviewed deploy is requested (Phase D territory).

### Verified (2026-10-28 — live acceptance, `b5e9ad3` deployed on s52 at 13:43Z)

- **Production smoke (s52):** `/api/health` + `/api/health/ready` 200;
  `/api/openapi.json` (52 operations) + `/api/docs` (Swagger UI) live-verified;
  legacy + v1 surfaces green; Web UI (index/asset/SPA fallback) 200; single
  service instance; 3 jobs intact (no data loss); rollback `80a9e66` ready.
- **Deployed-code feature checks** (sandbox, deployed code, mock provider,
  `NLO_API_AUTH=true`): enforced auth (401/403/429 + audit), scopes,
  revoked/disabled tokens, idempotent replay (`x-idempotent-replay`, no
  duplicate job), correlation IDs (echo/generate), and the runnable
  TypeScript client + Python client from `docs/api/README.md`.
- **Not performed (honest):** the one controlled live audio-to-text job —
  session re-verify failed at the NotebookLM region/anti-abuse gate
  (`location=unsupported`, both egress nodes); mock results were never
  reported as live. Full report:
  `docs/reports/PHASE_C_LIVE_ACCEPTANCE.md`.

### Unchanged

- Legacy `/api/*` behavior, loopback trust model, queue/provider/proxy
  internals, docker/compose, deploy scripts.
- Webhooks remain **planned** (Phase G).

## [2026-10-29] — Phase 2 (API Authentication — first-admin bootstrap)

### Added

- **First-admin bootstrap (closes F2):** the token chicken-and-egg
  (`POST /api/v1/tokens` requires an `admin` token, so the first token
  could not be created through the API) is solved by an **offline,
  host-only CLI** — deliberately with **no** unauthenticated (or any)
  network endpoint:
  `npm run bootstrap:admin --workspace @nlo/server`
  (`apps/server/src/domain/first-admin.ts` +
  `apps/server/scripts/bootstrap-first-admin.ts`).
- One-shot: refuses while ANY active (enabled, not-revoked) token exists;
  documented recovery = revoke all active tokens → re-run the CLI (name is
  auto-suffixed `first-admin-2`, … if a revoked row still holds the name).
- Secret hygiene: plaintext (`nlo_<slug>_<64hex>`, 32-byte CSPRNG) shown
  exactly once to the operator; only the SHA-256 hash is stored (same as
  `ApiTokensRepo.create`).
- Attributable, secret-free audit row `first_admin_bootstrapped`
  (`method: CLI`, token id only).
- Tests: `apps/server/test/first-admin.test.ts` — unit (format,
  hash-only storage, one-shot gate, rejection with an active API-created
  token, recovery, name collision/suffix, custom name+scopes, audit row)
  - integration/API-level with `NLO_API_AUTH=true` (chicken-and-egg
    proven: even `POST /api/v1/tokens` is 401 anonymously; bootstrap
    unblocks enforced auth; admin creates scoped tokens via API; revocation
    invalidates the token and re-opens recovery; legacy `/api` untouched).
- Docs: root README (API section + feature-status table),
  `docs/api/README.md` (new "First token (bootstrap)" section),
  `docs/wiki/08-api-authentication.md`, `SECURITY.md` (§1 trust model —
  replaced the stale "no API token" statement), `.env.example`.

### Fixed

- (Found by the new tests) the documented "revoke all → re-run" recovery
  would have failed on the UNIQUE `api_tokens.name` constraint once a
  revoked row still held the name; the bootstrap now auto-suffixes the
  name.

### Verified

- `npx vitest run test/first-admin.test.ts` → 12/12 passing (unit +
  integration, in-process, mock provider). Full gate (`npm test`,
  `typecheck`, `lint`, `format:check`, `build`) green.
- Verification level: **Unit/Integration passed.** No deploy, no
  production restart, and **no** enforced auth activation on s52 in this
  phase (production activation procedure is in
  `docs/reports/PHASE_2_API_AUTHENTICATION.md` and awaits explicit
  approval).

## [Unreleased]

### Added (governance & documentation)

- `AGENTS.md` — permanent development rules for all agents/contributors.
- `CONTRIBUTING.md` — how to propose and land changes.
- `SECURITY.md` — security policy + vulnerability reporting channel.
- `CHANGELOG.md` — this file.
- `docs/` restructured by topic: `architecture/`, `development/`,
  `deployment/`, `security/`, `api/`, `testing/`, `operations/`, `reports/`,
  `wiki/`.
- `docs/wiki/` — customer documentation source (Markdown; published to
  Wiki.js when API credentials are authorized).
- CI: GitHub Actions workflow (lint, typecheck, tests, build) and a ready
  `.gitlab-ci.yml` for the internal GitLab (`git.ai.ismc.ir`).

### Unchanged (explicit non-goals of this change)

- No API changes: no versioning, no new auth, no webhooks — those are Phase C.
- No production restart; s52 continues serving from its current commit until
  a reviewed deploy is requested.

## [2026-10-27] — P3 (repository & deployment audit)

### Added

- `deploy/deploy.sh` — reproducible git-based deployment with DB+env backup
  (5 retained), preflight checks, post-restart health/ready/port/journal
  verification, regression test run, and `ROLLBACK=1` rollback.
- `deploy/systemd/nlo.service` — secret-free production unit (tracked).
- `docs/deployment/s52-deploy.md` — canonical deployment procedure.

### Fixed

- `deploy.sh`: PATH-hardened dependency install + repo-local vitest for
  non-interactive SSH shells.

### Removed

- Tracked Python bytecode cache (`__pycache__/*.pyc`) — regenerable artifact.

## [2026-10-26] — P2 (deployed & live-verified)

### Fixed

- Proxy: probe curl candidates at startup so a broken distro curl is skipped.
- Runner: clear stale error fields when a job succeeds; cancel-vs-late-success
  race; worker cancel/redaction; Windows worker stdin.
- Worker: honor shutdown via stdin EOF + loop signal handlers.

### Verified

- Real NotebookLM job (audio → grounded answer) executed end-to-end through
  the Python worker and Xray tunnel (live-verified; evidence in
  `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md`).

## [2026-10-25] — P1 (foundation, deployed)

### Added

- Monorepo (npm workspaces): `apps/server` (Fastify + node:sqlite),
  `apps/web` (React + Vite, Persian RTL), `packages/shared`.
- Job state machine (shared, tested), durable queue with restart recovery,
  job archives (manifest, timeline, attempts, artifacts).
- Provider abstraction: `NotebookLMProvider` interface; MockProvider
  (default) + PythonWorkerProvider (explicit opt-in) with capability matrix.
- Proxy runtime: VLESS URI parser, masking, MockRuntime + Xray adapter;
  fail-closed egress guard (tested).
- Secrets: file vault AES-256-GCM (0600 key), log redaction, safe names,
  SSRF guard (all unit-tested).
- REST API: jobs (create/list/get/events/attempts/artifacts/cancel/requeue),
  accounts + sessions, proxies, settings, secrets (redacted), provider,
  health/readiness.
- Docker: `Dockerfile` (self-contained live-mode image) +
  `docker-compose.yml` (loopback-only, `./data` persistence).
