# Phase 1 — Critical Stabilization (NLO-MASTER-2026-11)

**Date:** 2026-11-06 (Asia/Tehran, UTC+3:30) · **Host:** local Windows dev workstation
**Deliverable:** worker timeout/queue-wedge fix + regression suite, login/session
verification, LiteLLM credential-hygiene scan, git hygiene, docs + status update.
**Verification level (honest):** `Unit/Integration/E2E-mock passed` + one
`real-worker integration` test (venv). **NOT live-verified** — live NotebookLM
jobs remain a manual gate and were **not** attempted this phase.

---

## 1. Executive summary

- **1.1 — the queue-wedge defect is fixed and proven.** In
  [`worker.ts`](../../apps/server/src/providers/python-worker/worker.ts) the
  Python-worker supervisor now enforces a **settle-once contract**: every path
  (response, timeout, abort, exit, close, stdin-error) settles each in-flight
  request **exactly once**, the timeout settles the promise **before** killing
  the child, stale/late responses are dropped, and `close()`/unexpected exit
  fail all pending requests instead of leaking them. A second, subtler variant
  of the same bug (deleting the pending entry _before_ invoking the
  resolve/reject wrappers, so the wrapper's own settle was a no-op) was found
  **and fixed** during this phase's test work. 14 new regression tests (10
  supervisor-level with a fake child process, 4 queue-level with scripted
  providers) cover the full defect class. No protocol changes.
- **1.2 — login/session behavior verified (read-only).** Browser import uses a
  browser allowlist + email-based account selection for multi-account profiles;
  the session gate blocks job creation when the selected (or preferred)
  account has no usable session; a failed auth **cannot** produce a fake
  SUCCEEDED job (verified in `session-gate.test.ts` + route code). The 10-min
  TTL is **cached eligibility** (`isUsable`/`eligibleAccountIds`), not
  credential expiration. The API surface never exposes cookies.
- **1.3 — LiteLLM key leak contained (redacted scan).** The real key exists
  **only** in two untracked, git-ignored local files
  (`tmp/myterm.env.txt:23`, `tmp/server12848.env.json:39`). Git history
  contains only the 7-char masked prefix `sk-51Rk` (inside
  `PHASE_H0_H1_TEXT_TO_NOTEBOOK.md`). `.env` is git-ignored and contains **no**
  LLM key. **Rotation is a user action and was NOT performed.**
- **1.4 — full suite green:** 213 → **227 tests**, 23 → 25 files, 0 failures;
  typecheck/lint/format/build all clean.
- **B1 (local venv `0xC0000142`) is RESOLVED** — the venv now spawns and the
  real-worker non-ASCII protocol test passes against it. The dev server on
  4871 predates the fix and must be restarted (approval gate, not done).
- **Blocked (recorded, not attempted):** prod deploy/restart, prod API auth,
  Nginx/DNS/TLS/firewall, Docker, public sharing/publication, credential
  rotation, prod data deletion.

---

## 2. Initial state (read-only evidence)

| Area                      | State at phase start                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                      | `main` @ `ed2868b` (hygiene commit), 2 ahead of `origin/main` (`4ae25da`); 2 modified tracked files (worker + provider) from the in-flight fix; 14 new untracked test files/fixtures                                                   |
| Dev server 4871           | `ready:true`, provider `configured:false` — "worker start failed … code=3221225794" (`0xC0000142`, the B1 venv defect). xray runtime `available`                                                                                       |
| Local DB                  | Jobs: 5 CANCELLED / 11 FAILED / 4 SUCCEEDED — **0 in-flight**; 2 proxy nodes (England_1, france1-SeyedSaber, both `enabled`); sessions: 1 AUTHENTICATED (`saber.tabatabaee@gmail.com`, verified 2026-11-06T03:04:33Z), 2 AUTH_REQUIRED |
| Production `172.30.0.133` | **Untouched** this phase (approval gate). Last known: service active @ `d705634`, ready                                                                                                                                                |
| BEFORE suite              | 213 tests / 23 files, 0 failed; typecheck/lint/format:check/build clean                                                                                                                                                                |

---

## 3. Implementation (what changed, why, files)

### 3.1 Worker supervisor — settle-once contract (1.1)

[`apps/server/src/providers/python-worker/worker.ts`](../../apps/server/src/providers/python-worker/worker.ts)

The pre-existing defect (documented in the 2026-11-06 CHANGELOG, attempt #5):
on timeout the supervisor deleted the pending entry **before** `kill()`, so
`kill() → failAll()` could no longer reject the promise — the request never
settled, `Queue.busy` stayed set forever, and the single-worker queue wedged
(all later jobs stuck, cancel a no-op).

The rewrite makes **exactly one** settlement possible per request:

- `request()` stores per-request `resolve`/`reject` wrappers plus a single
  `settle(fn)` helper (worker.ts:220–228): it looks up the pending entry,
  deletes it, clears the timer, removes the abort listener, runs `fn`, and
  reports whether it settled. **Only `settle()` may delete an entry.**
- **Timeout** (worker.ts:230–241): settles first (`timed out after Xs
(op=…)` — `WorkerError(code="timeout", ambiguous=true)`), logs
  `request timeout id=… settled=true`, then `kill()` — so the settle always
  happens **before** the child is terminated.
- **Response path** (worker.ts:316–358): a response for an already-settled id
  is dropped as stale (`continue`) — no duplicate/late delivery. The wrapper
  settles; `onStdout` does **not** delete the entry first (the subtle
  no-op-settle bug found and fixed during this phase).
- **Abort / stdin-write failure**: same settle-then-kill pattern.
- **Unexpected exit** (worker.ts:144–166): fails all pending with
  `python worker exited unexpectedly (code=…, signal=…)` — but only when the
  supervisor is _not_ already in a requested termination (`killing` flag),
  which already settled everything.
- **`kill()`** (worker.ts:388–417): idempotent, tracked escalation timer
  (SIGTERM → 5 s → SIGKILL/`TerminateProcess`), logs
  `kill requested code=…` / `kill: SIGTERM sent pid=…`.
- **`close()`** (worker.ts:427–487): fails all in-flight pending requests with
  a structured ambiguous error, then waits for child close (5 s SIGKILL
  escalation), closes stdin (EOF = worker shutdown), clears timers.
- **Structured logs with correlation ids** (worker.ts:102–105): every
  lifecycle event (`spawn`, `request sent`, `response ok/error`, `timeout`,
  `kill`, `exit`, `cleanup`) is prefixed `[nlo:worker <correlationId>]`.

[`apps/server/src/providers/python-worker/python-worker-provider.ts`](../../apps/server/src/providers/python-worker/python-worker-provider.ts)

Correlation ids are now passed at every spawn site: `acct:<accountId>`,
`login:<accountId>`, `browser-import:<accountId>`, `job:<jobId>`.

**No protocol changes** — the JSON-line wire protocol is untouched.
**No migration** — orphan recovery uses existing job columns.

### 3.2 Regression tests (1.4) — fake child, no venv required

- [`apps/server/test/fixtures/fake-worker.mjs`](../../apps/server/test/fixtures/fake-worker.mjs)
  — a Node child that speaks the **real** JSON-line protocol (ping answered
  immediately; modes: `ok`, `hang`, `late`, `crash` (exit 3), `early-exit`
  (exit 0), `die-on-term` (ignore SIGTERM), stdin-EOF shutdown). Spawned with
  the system Node, so these run on Windows without the (previously broken)
  Python venv.
- [`apps/server/test/worker-supervisor.test.ts`](../../apps/server/test/worker-supervisor.test.ts)
  — 10 tests (see matrix §5).
- [`apps/server/test/worker-queue-recovery.test.ts`](../../apps/server/test/worker-queue-recovery.test.ts)
  — 4 tests running the **real** `Queue` + `JobRunner` + `JobsRepo` with a
  scripted provider, including a restart test that opens a **second DB
  connection** over the same durable data dir and re-runs the orphaned job
  through a fresh queue.

Windows-specific determinism: LIFO dequeue (`ORDER BY created_at DESC`)
handled with ≥5 ms creation gaps; async `exit`-event races handled with
polling (`waitFor`), never immediate asserts.

### 3.3 Repo hygiene (done in `ed2868b`, prior session)

Unstaged 287 scratch files; `.gitignore` now covers `tmp/`, `/HTTP`, `/$out`,
`/'2026-11-05'`. No user files deleted; no `git add -A`.

---

## 4. Git

| Commit            | Scope                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ed2868b`         | `chore: unstage 287 scratch files and ignore local scratch artifacts` (hygiene)                                                                                                                                                                                             |
| `87f964b` (C1)    | `fix(worker): settle-once contract for python-worker requests — settle before kill, fail-all on exit/close, drop stale responses, structured logs with correlation ids; +14 regression tests (supervisor + queue-recovery) with fake-worker fixture; Phase 1 stabilization` |
| `C2` (this phase) | `docs: Phase 1 stabilization report + status/roadmap/changelog updates`                                                                                                                                                                                                     |

Branch `main`; **fast-forward push to `origin/main` only** (no force-push);
local HEAD == `origin/main` verified after push. C1 = `87f964b`; C2 is the
docs commit immediately following C1 on `main`.

---

## 5. Tests (honestly labeled)

**Level: Unit/Integration/E2E-mock + one real-worker integration. NOT live.**

| #   | Test (file)                                              | What it proves                                                                                                                                    |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | normal path — `worker-supervisor`                        | ping + job: result delivered **exactly once**; structured logs carry correlation id                                                               |
| 2   | timeout — `worker-supervisor`                            | request settles with structured ambiguous `timeout` error; worker killed; child **really** gone; sent/timeout logged once each (no double settle) |
| 3   | timeout + second request in flight — `worker-supervisor` | **both** settle; worker killed once                                                                                                               |
| 4   | late response after timeout — `worker-supervisor`        | dropped as stale — no duplicate delivery                                                                                                          |
| 5   | SIGTERM-ignore (`die-on-term`) — `worker-supervisor`     | escalation does not hang the supervisor; `close()` resolves deterministically                                                                     |
| 6   | structured logs — `worker-supervisor`                    | spawn/request/response/timeout/kill/exit/cleanup all carry the correlation id                                                                     |
| 7   | crash (exit 3) — `worker-supervisor`                     | in-flight request rejects (not stuck); supervisor marked exited                                                                                   |
| 8   | exit-before-response (exit 0) — `worker-supervisor`      | request rejects deterministically                                                                                                                 |
| 9   | abort (job cancel) — `worker-supervisor`                 | request settles, worker killed, fresh supervisor works                                                                                            |
| 10  | `close()` while in flight — `worker-supervisor`          | pending request settled by `close()` (no hang, no unhandled rejection)                                                                            |
| 11  | timeout → queue continues — `worker-queue-recovery`      | timed-out job → **NEEDS_ATTENTION** (ambiguous, never auto-retried); next job runs to **SUCCEEDED**                                               |
| 12  | crash ×3 → attempts exhausted — `worker-queue-recovery`  | job **FAILED** after 3 attempts (retryable path); queue continues; no duplicate runs                                                              |
| 13  | single-worker serialization — `worker-queue-recovery`    | slow in-flight job blocks the next job (no double-run); queue continues after                                                                     |
| 14  | restart with RUNNING job — `worker-queue-recovery`       | `recoverInFlight()` resets RUNNING → QUEUED + `restart_recover` event; fresh second DB connection + fresh queue re-runs the orphan to SUCCEEDED   |

**Counts:**

|                             | BEFORE                         | AFTER                                                                     |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `npm test` (all workspaces) | 213 tests / 23 files, 0 failed | **227 tests / 25 files, 0 failed** (shared 53/7, server 144/14, web 30/4) |
| `npm run typecheck`         | clean                          | clean                                                                     |
| `npm run lint`              | clean                          | clean                                                                     |
| `npm run format:check`      | clean                          | clean                                                                     |
| `npm run build`             | ok                             | ok                                                                        |

**Live:** NOT performed this phase (manual gate; real accounts/egress/cost).
Mock/fake results do **not** prove real NotebookLM execution.

---

## 6. Live verification

**Not performed** (by design — approval gate). The local venv repair was
validated by the real-worker integration test instead (see B1 below).

---

## 7. Security

- **1.2 verification (read-only):**
  - Browser import: server-side allowlist of 11 browser names
    (`sessions.ts:245–271`); profile via `chrome::Profile N`; multi-account
    profiles by email (`account` field) — the client never chooses an
    executable or path.
  - Session gate: `selectAccount` refuses when the preferred account is
    unusable (no silent switch), and `eligibleAccountIds`/`isUsable` gate job
    creation; failed login/import transitions the session to
    `AUTH_REQUIRED` with `lastError` — a failed auth **cannot** create a fake
    successful job or SUCCEEDED result.
  - The 10-minute TTL (`auth-sessions.repo.ts:131–149`) is **cached
    eligibility** (re-verify cadence), **not** credential expiration — docs
    now state this explicitly.
  - API responses (`sanitizeAccount`, `sessionView`) never include cookie
    material; cookies live in the encrypted vault (AES-256-GCM) and are never
    logged (redaction module).
- **1.3 LiteLLM credential hygiene (all values redacted):**
  - Working-tree scan (script `tmp/p1_llm_scan.ps1`, prints masked values
    only): real key present **only** in untracked, git-ignored
    `tmp/myterm.env.txt:23` (`LITELLM_API_KEY=sk-5…Eg`, masked) and
    `tmp/server12848.env.json:39` (same key). All other `sk-` hits are
    false positives (e.g. English word "ta**sk-**") or third-party package
    text under `data/venv`.
  - Git history: `git log --all -S LITELLM_API_KEY` → 1 commit
    (`4ae25da`, the H0/H1 report) containing **only** the 7-char masked
    prefix `sk-51Rk` — no full key in history.
  - `.env`: git-ignored (`.gitignore:18`); local `.env` exists with 7
    non-secret vars and **no** LLM key. `loadDotEnv()` (config.ts:84) only
    sets vars not already in `process.env`; secrets are never logged
    (config.ts:109).
  - **Recommended user action (NOT performed):** rotate the LiteLLM key at
    the LiteLLM admin panel and delete/scrub the two `tmp/` files.
- No secrets added to any commit; staged diffs secret-scanned before each
  commit (patterns `sk-`, `ghp_`, `vless://`, `api_key`, UUID, `Bearer`).

---

## 8. Deployment

**No deployment.** Production `172.30.0.133` untouched (approval gate). The
local 4871 dev server still runs the pre-fix code and shows
`configured:false` (its worker start predates both the venv repair and the
fix) — a restart is required but was **not** performed (approval gate).

---

## 9. Data safety

- `data/` (SQLite, vault, archives, venv, vendor binaries) untouched by the
  code changes; tests use **fresh temp dirs** per case (no writes to
  `data/`).
- The DB was read-only inspected for this report (job/session/node counts,
  §2). No writes, no deletions, no backups needed (no destructive action).

---

## 10. Known limitations

1. **win32 SIGTERM = hard TerminateProcess** — a Windows child cannot truly
   "ignore SIGTERM"; the `die-on-term` test exercises the escalation/cleanup
   paths rather than real signal handling. True signal-ignore coverage only
   exists on POSIX (CI).
2. The fix is proven against a **fake** worker (protocol-identical Node
   child) and a scripted provider; real `nbl_worker.py` interaction with the
   new supervisor paths (timeout/kill/close) is **not** live-verified.
3. Orphan recovery is proven at repo+queue level with a second DB connection
   (WAL); an actual process restart on a live host is covered only by the
   existing boot path (`app-context.ts:153` calls `recoverInFlight()`).
4. Dev server 4871 health still shows the old `configured:false` until
   restarted (see §8).
5. `docs/wiki/` not updated — no user-facing behavior changed (internal
   stability fix only).

---

## 11. Blockers (B1–B10 re-check)

| ID  | Status after Phase 1 | Evidence                                                                                                                                                                                                                                              |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **RESOLVED (local)** | `worker-nonascii-protocol.test.ts` spawned the real venv (`data/venv/Scripts/python.exe`), printed its version, ran the full protocol round-trip — **passed** in the AFTER run (1 test, 692 ms). The `0xC0000142` spawn failure no longer reproduces. |
| B2  | **OPEN**             | Both local VLESS nodes (England_1, france1-SeyedSaber) still fail the 15 s staged health check — external tunnel quality; needs fresh node credentials (user input). Not re-tested this phase (no change to the tunnels).                             |
| B3  | OPEN                 | GitLab instance survival unknown (s52 decommissioned); no maintainer PAT.                                                                                                                                                                             |
| B4  | OPEN                 | No GitLab runner; mirror CI inactive.                                                                                                                                                                                                                 |
| B5  | OPEN                 | Prod service restart needs sudo password (user-supplied). Phase 6.                                                                                                                                                                                    |
| B6  | OPEN                 | FFmpeg not installed locally; no conversion code. Phase 4.                                                                                                                                                                                            |
| B7  | **PARTIAL (1.3)**    | Key **found** (local, untracked, git-ignored); rotation recommended (user action). `internal-llm.ts` still has **no production caller** — capability remains deferred.                                                                                |
| B8  | OPEN                 | Webhook destination + shared secret not provided. Phase 2.                                                                                                                                                                                            |
| B9  | OPEN                 | Deep Dive generation mechanism unverified against real NotebookLM. Phase 3 live spike.                                                                                                                                                                |
| B10 | OPEN                 | No `gh` CLI on this machine — GitHub Actions run status cannot be verified locally; CI runs on push.                                                                                                                                                  |

**Approval gates still BLOCKED (not attempted):** prod deploy/restart; prod
API auth activation; Nginx/DNS/TLS/firewall; Docker packaging; public
sharing/publication; credential rotation; prod data deletion.

---

## 12. Rollback

- Code: `git revert 87f964b` (or `git reset --hard ed2868b` locally before any
  further work) restores the pre-fix supervisor. No DB schema, dependency, or
  config changes — nothing to migrate back.
- The dev server can be restarted on any commit at any time
  (`NLO_PORT=4871 npx tsx apps/server/src/main.ts`); `data/` is untouched.
- Production is unchanged; no rollback needed there.

---

## 13. Next phase proposal

**Phase 2 — Webhook infrastructure** (`docs/reports/PHASE_2_WEBHOOKS.md`):
HMAC signing, retry/backoff, SSRF guard for destinations, destination config
API + schema. Requires user input B8 (destination URL + shared secret) before
live verification; implementation can proceed against mocks.

**Prerequisites to settle before/alongside:** restart the 4871 dev server to
pick up the fix + repaired venv (approval); decide on the 2 leaked-key `tmp/`
files (rotate key, then delete) — user action.

---

## 14. Approval request

**STOP.** Phase 1 is complete: fix implemented, 14 regression tests added and
green, full suite green (227/227), docs updated, hygiene scan done, no
deployments. **Awaiting user approval** to: (a) restart the local 4871 dev
server with the fix, (b) start Phase 2, (c) any prod action remains gated as
listed in §11.
