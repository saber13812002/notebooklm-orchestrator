# Phase P0 — NLO Audio Submission Repair

**Date:** 2026-11-05 · **Mode:** local dev (`127.0.0.1:4871`) · **Scope:** reproduce → root-cause → fix (scopes 1+2, user-confirmed) → verify → commit (no push)

## 1. Executive summary

Audio jobs (WAV/MP3 upload → NotebookLM audio→text) were **accepted by the API
(201) but failed in ~0.2 s with `errorClass: "auth"`**:
`no eligible google account with a verified session`. The submission pipeline
(upload, validation, queuing) works; the job runner correctly refuses to run
because **none of the 3 registered Google accounts has a usable auth session**
(all `AUTH_REQUIRED`). Two secondary defects amplified the confusion:

1. The UI offered no warning before submit, so a user could queue a job that
   was _guaranteed_ to fail at account selection.
2. Passing a **session id** (e.g. `sess_af33…`) into a session route that
   expects an **account id** surfaced a generic **500 `internal_error`**
   instead of a clean **404 `not_found`**.

Both are fixed, tested, and committed. **Real NotebookLM execution is still
blocked by an expired Google session (user action) and an environmental xray
spawn failure** — see §8.

## 2. State at start (PHASE 0 — stabilization)

| Item                      | State                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Local branch              | `main` = `d705634dacff5e3b97cdb29cb3968a8d91e90cab` = `origin/main` (in sync)                                             |
| Pre-work backup           | `data/backups/nlo-pre-P0-2026-11-05.bundle` (671,700 B) — full repo bundle                                                |
| Dev server                | `127.0.0.1:4871` (pid 18700, `NLO_PROVIDER=python-worker`), `/api/health` OK                                              |
| Production `172.30.0.133` | **read-only**, untouched (out of scope this phase)                                                                        |
| Legacy `s52`              | decommissioned 2026-11-01, not contacted                                                                                  |
| Untracked junk            | `$out`, `HTTP`, `tmp/*` forensic scripts present in the working tree; **excluded** from the commit (no `git add -A` used) |

## 3. Reproduction evidence (PHASE 1)

- **User's failing job:** `j_54c17a54ca96c1982aeab8bc4bd1fff6` — created
  2026-11-05T15:26:59Z, `FAILED` in 0.287 s, `error_class: "auth"`,
  `error_message: "no eligible google account with a verified session"`.
- **Controlled repros (this session, real dev server, real provider):**
  - `j_1e24a3932c02cc93e81d98c216d7d359` — 5 s 440 Hz WAV (32 KB) → **201**
    @ ~111 ms, then `FAILED` auth ~0.2 s.
  - `j_47be1a64cfae6a3c03cd478c84de66f7` — MP3 variant → **201** @ ~25 ms,
    then `FAILED` auth ~0.2 s.
- Upload, multipart validation, archive storage, and queue hand-off all
  worked; failure occurred in `JobRunner.selectAccount`
  ([apps/server/src/queue/job-runner.ts:374](../../apps/server/src/queue/job-runner.ts)),
  which requires an account with a session that is `AUTHENTICATED` **and**
  verified within the 10-min TTL
  ([apps/server/src/domain/auth-sessions.repo.ts:131](../../apps/server/src/domain/auth-sessions.repo.ts)).

## 4. Root cause + evidence chain

1. **DB audit** (`tmp/p0_db_audit.py`, output in `tmp/p0_db_audit.txt`): all 3
   accounts are `status = AUTH_REQUIRED`, `enabled = 1`; the default account
   `acc_9ef8fd4d431c49fc` (`sas`) has
   `last_error: "session rejected by service (re-login required):
Authentication expired or invalid …"`.
2. **Session audit** (`tmp/p0_sessions.txt`):
   - `sess_af33bf051ce04892` → `AUTH_REQUIRED`, last verified
     **2026-10-23T02:52:36Z** (13 days stale), same "Authentication expired"
     last error.
   - `sess_8f079d7e3ebe4abc`, `sess_5e495357abcd4482` → `AUTH_REQUIRED`,
     worker exit `code=3221225477` (0xC0000142, STATUS_DLL_INIT_FAILED).
3. **Eligibility rule:** `selectAccount` filters on
   `AuthSessionsRepo.isUsable()` = state `AUTHENTICATED` +
   `lastVerifiedAt` within `10 * 60 * 1000` ms. No account passes ⇒
   `ProviderFailure { code: "auth" }` ⇒ job `FAILED` with `errorClass "auth"`.
   **The runner behaved exactly as designed** — the missing verified session
   is a data problem (expired Google login), not a code bug.
4. **500-instead-of-404:** `AccountsRepo.getOrThrow`
   ([apps/server/src/domain/accounts.repo.ts:65](../../apps/server/src/domain/accounts.repo.ts))
   threw a plain `Error`, which the server error handler maps to a generic
   500 `internal_error`. Session routes
   ([apps/server/src/api/routes/sessions.ts:317](../../apps/server/src/api/routes/sessions.ts))
   call `getOrThrow(req.params.id)` **before** any session-file lookup, so an
   unknown id (including a pasted `sess_…` id) produced a 500 with no useful
   code in the error envelope.
5. **UX gap:** the create-job page
   ([apps/web/src/features/jobs/create-job.tsx](../../apps/web/src/features/jobs/create-job.tsx))
   never consulted `GET /api/sessions`, so the page showed no hint that every
   submit would fail with an auth error.

**Conclusion:** submission pipeline healthy; jobs fail due to expired
credentials (expected, correctly classed) plus two fixable secondary defects
(404 mapping, preflight UX).

## 5. Fixes (scope 1 + 2, user-confirmed)

### Scope 2 — 404 mapping (server)

[`apps/server/src/domain/accounts.repo.ts`](../../apps/server/src/domain/accounts.repo.ts):
`getOrThrow` now throws
`new ApiError(ApiCodes.notFound, "account not found: <id>", 404)`, so all
session routes (`/verify`, `/refresh`, `/import`, `DELETE /:id`) return the
standard 404 envelope `{ error: { code: "not_found", message } }` for unknown
account ids. Internal callers that rely on throw-on-missing (create/update/
setDefault) are unaffected.

### Scope 1 — create-job preflight (web)

[`apps/web/src/features/jobs/create-job.tsx`](../../apps/web/src/features/jobs/create-job.tsx):

- On mount the page now also loads `sessionsList()` (`GET /api/sessions`).
- Eligibility mirrors the runner's rule exactly (`sessionUsable` per account):
  - **explicit account selected** → usable only if _that_ account's session is
    usable (the runner never switches away from a preferred account);
  - **auto mode (no selection)** → usable if _any_ account's session is usable.
- When accounts are loaded and the effective account is unusable: the Submit
  button is disabled and a Persian warning (`role="alert"`) is shown with a
  link to `/accounts` ("go log in / verify the session first").
- No false alarm before the session data resolves (button state unchanged
  until `sessionsLoaded`).

## 6. Tests (honest level: **Unit/Integration passed — mock level; Live NOT verified**)

| Suite                                                  | Result                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/test/sessions-404.test.ts` (new)          | **6/6 pass** — unknown id → 404 `not_found` on `/verify`, `/refresh`, `/import`, `DELETE`; valid id never yields `not_found`/`internal_error`; repo-level `getOrThrow` throws `ApiError { code: not_found, httpStatus: 404 }` (built with `NLO_PROVIDER=python-worker` so the guard is bypassed and the 404 path is actually exercised) |
| `apps/web/src/features/jobs/create-job.test.tsx` (new) | **4/4 pass** — blocked + alert + `/accounts` link when no usable session; blocked for an explicitly-selected unusable account even when another is usable; submit allowed + job POST made when a session is usable; no false alarm before data loads                                                                                    |
| Full regression `npm test` (all workspaces)            | **185/185 pass** — shared 44, server 112 (incl. existing `accounts.repo`, `session-gate`, `api`, `openapi-v1`), web 29                                                                                                                                                                                                                  |
| `npm run typecheck`                                    | clean (3 workspaces)                                                                                                                                                                                                                                                                                                                    |
| `npm run lint` (`eslint apps packages`)                | clean — all remaining `tmp/` lint findings are pre-existing untracked forensic scripts, deliberately not committed and not modified                                                                                                                                                                                                     |
| `npm run format:check`                                 | clean for all committed files (the 4 touched files verified individually); only untracked `tmp/` scratch fails repo-wide check                                                                                                                                                                                                          |
| `npm run build`                                        | clean (web tsc + vite build)                                                                                                                                                                                                                                                                                                            |

Live verification is **not** claimed: no real NotebookLM job was run to
completion (see §8).

## 7. Verification checklist

- [x] typecheck / lint (source tree) / format / tests / build all green
- [x] repro evidence recorded (2 fresh failed jobs + user's job)
- [x] backup taken before any change
- [x] no push performed; commit is local-only
- [ ] live end-to-end audio job (blocked — §8)

## 8. Remaining blockers & next steps (user actions)

1. **Expired Google sessions (the original P0 data problem).** All 3 accounts
   are `AUTH_REQUIRED`. The user must restart the dev server and re-login /
   verify a session from `/accounts` (user has committed to do this). Until
   then every real job will — correctly — fail with `errorClass "auth"`.
2. **Environmental xray failure:** worker spawn exits with
   `code=3221225477` (0xC0000142, STATUS_DLL_INIT_FAILED) for two accounts;
   also seen when the server (pid 18700) spawns xray. This is an OS/AV/DLL
   issue on this dev box, outside NLO code; the server restart the user is
   about to do is the first mitigation step.
3. **10-minute session TTL design note:** a _just-verified_ session becomes
   "unusable" 10 minutes after `lastVerifiedAt` without another verify. The
   preflight warning therefore can appear even right after a successful
   verify. Consider raising the TTL or auto-refreshing `lastVerifiedAt` on
   successful job completion in a future phase (out of scope here — no
   behavior change was requested).
4. Production (`172.30.0.133`) remains at `b5e9ad3`; deploying this fix
   follows the normal git-based `deploy/deploy.sh` flow once approved.

## 9. Changed files (commit scope — exact list, no `git add -A`)

1. `apps/server/src/domain/accounts.repo.ts` — 404 mapping (scope 2)
2. `apps/web/src/features/jobs/create-job.tsx` — preflight UX (scope 1)
3. `apps/server/test/sessions-404.test.ts` — new (6 tests)
4. `apps/web/src/features/jobs/create-job.test.tsx` — new (4 tests)
5. `docs/reports/PHASE_P0_AUDIO_RECOVERY.md` — this report
6. `CHANGELOG.md` — entry for the user-visible changes

Commit message: `fix(audio): session preflight on create-job + 404 for unknown
account ids (P0 audio submission recovery)`.
