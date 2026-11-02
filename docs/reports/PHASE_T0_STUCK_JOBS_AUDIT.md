# Phase T0 — Stuck Files and Jobs Audit (new production host, READ-ONLY)

- **Date:** 2026-11-02 (audit window ≈ 14:30–14:50 UTC)
- **Host:** `AI-TOOLS` / `172.30.0.133`, user `saber` (SSH publickey)
- **Method:** read-only only — SQLite opened with `mode=ro` (safe concurrent reader
  alongside the WAL writer), disk inventory with sizes/mtimes/sha256, API health
  probes. **No** job was retried, no file moved/renamed/deleted, no DB record
  changed, no session touched, no service restarted, no config changed.
- **Scope guard honored:** no cookies, no session-file contents, no `.env`
  values, no secret ciphertexts were read or printed. The `secrets` table was
  queried for **metadata only** (ref + kind).

## 1. Live deployment identity

| Item | Value (observed) |
| --- | --- |
| Service | `nlo.service` — **active (running)** since 2026-10-31 07:10:44 UTC (Main PID started 07:11:47 UTC, ~2 days uptime at audit) |
| Deployed commit | `b5e9ad3` (clean ancestor of GitHub HEAD `d804e2d`) |
| Working directory | `/home/saber/saberprojects/notebooklm-orchestrator/apps/server` |
| Executable | `node_modules/.bin/tsx src/main.ts` on Node v22.23.4 (`/home/saber/.local/node22/bin`) |
| Binding | **loopback only** `127.0.0.1:4870` |
| `/api/health` | 200 OK |
| `/api/health/ready` | 200 OK |
| Provider | `python-worker` configured (**not** mock); `liveDisabled: true` (`NLO_LIVE_TESTS` unset — this flag only gates live-acceptance scripts, not jobs) |
| Proxy runtime | `xray` available (vendor binary present, per G3-A) |
| Worker process | **No resident worker process** — the Python worker is spawned per job by the provider; `ps` confirmed none running (correct: no in-flight jobs) |
| DB | `data/nlo.sqlite` (164 K); schema migrations 1–5 applied (v5 on 2026-10-28T13:43:17Z) |
| Storage | per-job layout `data/jobs/<jobId>/`; plus `data/backups/`, `data/sessions/` (0700), `data/tmp/`, `data/vault/` (empty dir; `data/vault.key` 0600) |
| On-host `.env` (names/booleans only) | `NLO_HOST=127.0.0.1`, `NLO_PORT=4870`, `NLO_ALLOW_DIRECT_EGRESS=1`, `NLO_PROXY_RUNTIME=xray`, `NLO_PYTHON_BIN` (exists + executable), `NLO_LOGIN_BROWSER`, `NLO_PROVIDER`; **no** `NLO_INTERNAL_API_BASE_URL` (compiled default `http://172.30.0.133:4000` applies — correct on this host) |

Deployment identity is consistent with G3-A: the service found there is still the
running one, untouched for 2 days.

## 2. Job inventory (all jobs, grouped by state)

Total: **3 jobs, all terminal.** No non-terminal jobs exist in any group.

| State | Count | Jobs |
| --- | --- | --- |
| QUEUED | 0 | — |
| RUNNING | 0 | — |
| RETRY_WAIT | 0 | — |
| SUCCEEDED | 2 | `j_34ba…`, `j_6568…` |
| FAILED | 1 | `j_290f…` |
| NEEDS_ATTENTION | 0 | — |
| CANCELLED | 0 | — |
| Unknown | 0 | — |

Cross-checked via `/api/health` + read-only DB (`jobs`, `job_events`,
`job_attempts`); API and DB agree.

### SUCCEEDED (2)

| Field | `j_34ba948a7b1a296e6d062a6ae5397b8f` | `j_6568c109d989bc430be9453f7e9008f9` |
| --- | --- | --- |
| Job ID | j_34ba948a7b1a296e6d062a6ae5397b8f | j_6568c109d989bc430be9453f7e9008f9 |
| Created (UTC) | 2026-10-26T17:21:23.646Z | 2026-10-26T17:27:11.331Z |
| Last update (UTC) | 2026-10-26T17:21:58.344Z | 2026-10-26T17:28:13.358Z |
| Source filename | `nlo-e2e-audio.wav` | `nlo-e2e-audio.wav` |
| Source size | 641,980 B (sha256 `180267db…`) | 641,980 B (sha256 `180267db…`) |
| Provider | python-worker | python-worker |
| Notebook ID | `80f7c37b-10ad-47e9-8b30-74f9a9da502b` (`nlo-j_34ba948a7b1a29`) | `67202ea8-93c8-4173-8bed-a9ce24b4b837` (`nlo-j_6568c109d989bc`) |
| Source ID | `82edad35-4d33-4367-b59c-e678fa087c5a` | `5ef0b347-1d45-4b78-9f00-77b6677ecc2d` |
| Status | SUCCEEDED (progress 100, "retrieved real answer") | SUCCEEDED (progress 100, "retrieved real answer") |
| Last error | `provider` — "python-worker: Server error 502 calling ADD_SOURCE_FILE … Bad Gateway" (**attempt 1, recovered on attempt 2**; residual field, see §3) | none (error_class/message null) |
| Retry count | 2 attempts (max_attempts 3) | 1 attempt |
| Result provenance | **real** (`simulated:false`) | **real** (`simulated:false`) |
| Original file exists | yes — `input/audio-nlo-e2e-audio.wav` 641,980 B, sha256 **matches** input manifest | yes — sha256 **matches** |
| Output exists | yes — `output/answer.md` 193 B | yes — `output/answer.md` 105 B |

Both ran via node `node_bcc676fd5f7f47ad` (france1-SeyedSaber), account
`acc_5a03a60bbda24085`; each produced a real answer (audio→text, numbers 1–5), a
real conversation ID, and a `checkedAt` provider verification.

### FAILED (1)

| Field | `j_290f6f497045e2c732605dc9910b5476` |
| --- | --- |
| Job ID | j_290f6f497045e2c732605dc9910b5476 |
| Created (UTC) | 2026-10-26T17:25:46.422Z |
| Last update (UTC) | 2026-10-26T17:25:46.665Z (lifetime **0.24 s** — failed at validation) |
| Source filename | `nlo-e2e-audio.wav` |
| Source size | 641,980 B (sha256 `180267db…`) |
| Provider | python-worker (configured snapshot) — **never reached the provider** |
| Notebook ID | none (failed before notebook creation) |
| Source ID | none |
| Status | FAILED (progress 0) |
| Last error | `auth` — "requested account \"saber (imported)\" is not usable: session not verified (re-authentication required)" |
| Retry count | 0 attempts (3 job events, last type `validate`) |
| Result provenance | unknown (no provider interaction) |
| Original file exists | yes — sha256 **matches** (copied at 17:25:46.427Z, then validation failed) |
| Output exists | none — **correct** for a validation failure |

Context: this is the first of the three 2026-10-26 E2E-P2 runs. The session was
re-verified 95 s later (17:27:11Z), and the same input succeeded twice
afterwards. It is superseded history, not an active problem.

### Event/attempt summaries

| Job | job_events | job_attempts (max attempt) |
| --- | --- | --- |
| j_290f | 3 (17:25:46.428 → 17:25:46.665, last `validate`) | 0 |
| j_34ba | 12 (17:21:23.651 → 17:21:58.345) | 2 (last ended 17:21:58.341) |
| j_6568 | 7 (17:27:11.333 → 17:28:13.358) | 1 (last ended 17:28:13.355) |

## 3. Stuck job detection

Checks performed (per mission): old QUEUED / RUNNING without progress / missing
source files / notebook-created-but-no-result / result-but-missing-artifacts /
stale error fields / duplicates / vanished worker.

| Check | Result |
| --- | --- |
| Old/stale QUEUED | **None** — zero QUEUED jobs |
| RUNNING without progress | **None** — zero RUNNING jobs |
| RETRY_WAIT / NEEDS_ATTENTION / CANCEL_REQUESTED | **None** |
| Missing source files | **None** — all 3 `input/audio-nlo-e2e-audio.wav` present, sha256 match the recorded manifests |
| Notebook created but no result | **None** — both notebooks exist only on SUCCEEDED jobs that have a real answer |
| Result but missing artifacts | **None** — the `artifacts` table is empty, but these jobs produced **text answers only** (no file artifacts expected); both `output/answer.md` files exist |
| Stale error fields | One, benign: `j_34ba` is SUCCEEDED yet carries `error_class=provider` / 502 message — this is the **attempt-1 residual** (502 Bad Gateway on `ADD_SOURCE_FILE`, auto-recovered on attempt 2). History field, not a stuck state |
| Duplicates | 3 jobs share identical prompt + audio + sha256 — **intentional** (E2E-P2 test ran the same input 3 times on 2026-10-26), not accidental re-submissions; no idempotency keys involved |
| Vanished worker / orphaned in-flight job | **None** — worker is spawned per job by design; no job is in flight, so nothing can be orphaned |

**Verdict: no stuck jobs and no stuck files.** Nothing needs (or is safe for)
an automatic retry. Per mission guidance, old RUNNING jobs were never assumed
retryable — there are none.

## 4. Missing files

**None.** Expected per-job layout (`manifest.json`, `input/`, `execution/`,
`output/`) is complete for all 3 job directories:

| Job dir | Total | Files present |
| --- | --- | --- |
| `data/jobs/j_290f…` | 642,517 B | manifest.json, input/prompt.md, input/audio-….wav, execution/{timeline.jsonl, attempts.json `[]`, errors.json `[]`} |
| `data/jobs/j_34ba…` | 645,161 B | same + output/answer.md (193 B) |
| `data/jobs/j_6568…` | 643,550 B | same + output/answer.md (105 B) |

`data/tmp/` holds only `server.log` (456 B) — no stale temp uploads. No DB
references point at absent files.

## 5. Existing artifacts

- **`artifacts` table:** 0 rows (no file artifacts were ever generated;
  correct — all 3 jobs were text-answer requests).
- **Delivered text outputs:** `output/answer.md` for both SUCCEEDED jobs
  (193 B / 105 B, sha256 recorded in audit dump).
- **Backups (`data/backups/`):** 5× DB (143,360 B each) + 5× `.env` (262 B
  each), newest pair `20261028T134316Z-b5e9ad3` — matches the deployed commit.
- **Sessions (`data/sessions/`, 0700):** `nlo-acc_5a03a60bbda24085.json`
  (12,164 B) + 2 zero-byte lock files. Contents **never read**.
- **Vault:** `data/vault/` empty; `data/vault.key` present (0600, per G3-A).

## 6. Notebook relationships

| Notebook (real) | Job | Source | Conversation | State |
| --- | --- | --- | --- | --- |
| `80f7c37b-10ad-47e9-8b30-74f9a9da502b` | j_34ba | `82edad35-…` | `89d0fad4-…` | SUCCEEDED, real answer |
| `67202ea8-93c8-4173-8bed-a9ce24b4b837` | j_6568 | `5ef0b347-…` | `a19e2bec-…` | SUCCEEDED, real answer |

No orphaned notebooks: the failed job created none (it failed before provider
interaction). All provider meta shows `uploaded:true` and
`simulated:false`.

## 7. Account / session status (read-only, no contents printed)

| Item | Value |
| --- | --- |
| Account | `acc_5a03a60bbda24085` — "saber (imported)", `saber.tabataba@gmail.com`, **ACTIVE**, enabled, **is_default=1** |
| Account last success | 2026-10-26T17:28:13Z (j_6568), `last_error` null |
| Session | `sess_013327da4aff48eb`, provider python-worker, profile default, state **AUTHENTICATED** |
| Session last verified | **2026-10-26T17:27:11Z — ≈ 7 days before this audit** → freshness must be re-verified before the first live job (the service's own session gate fails closed with an `auth` error if stale, which is exactly how j_290f failed) |
| Expiration | no expiration column in DB; cookie file 12,164 B (0600) exists; contents never read |
| Re-auth performed | **none** (read-only mandate) |
| Secrets | 1 reference only: `vless-uuid:3ba88774-b201-41a6-9192-eb6b1471dc49` (metadata; ciphertext never read) |
| Proxy `france1-SeyedSaber` (`node_bcc676fd5f7f47ad`, api3.av-up.ir:443 ws/tls) | last health **ok** — 608 ms to notebooklm.google.com:443, but on 2026-10-28 (≈ 5 days stale → re-check at test time) |
| Proxy `England_1` (`node_9f9b958361b6401b`, eng1.av-up.ir:443 ws/tls) | last health **failing** — "curl exited 35", 2026-10-28 (node still enabled; proxy manager will fail over, but manual review is advisable) |

## 8. Recommended recovery actions

1. **No recovery needed** — there are no stuck jobs, no missing files, no
   orphaned artifacts.
2. **Before Scenario 1 (first live test):** read-only re-check of session
   freshness and both proxy health checks (5–7 days of staleness). If the
   session is stale, the job will fail closed with a clear `auth` error and
   re-authentication will be required — that is an interactive step requiring
   your explicit approval, not something T0 may do.
3. **Manual review (out of T0 scope, do not do now):** the `England_1` proxy
   has been failing since the last check — decide whether to disable it or let
   fail-over handle it.
4. **G3-B deploy** (fast-forward `b5e9ad3` → `d804e2d` + `deploy.sh`): still a
   **hard approval gate** — it changes production code; it is not part of T0
   and was not performed.

## 9. Recommended safe test candidate (ONE)

**A brand-new job with one small Persian audio file** (your Scenario 1),
**not** a retry of any existing job:

- Do **not** retry `j_290f`: it is terminal-FAILED, 7 days old, already
  superseded by two successful runs of the same input, and the requeue API
  only accepts `NEEDS_ATTENTION` jobs anyway. A fresh job exercises the exact
  same path with a fresh input and gives an honest acceptance signal.
- Candidate input: one short Persian `.wav` (e.g. 10–30 s of clear speech
  counting or a simple sentence), uploaded once.
- Execution, **each step shown to you and approved before the next**:
  1. upload the single file →
  2. create job (text output request) →
  3. proxy/session pre-check (read-only) →
  4. notebook create + source add →
  5. text output request →
  6. verify real text + real Notebook ID + real Source ID →
  7. deliver + artifact/download check.
- Expected: `result_provenance=real`, a fresh `notebook_id`/`source_id`,
  `output/answer.md` written, job SUCCEEDED in `data/jobs/<newId>/`.

## 10. Retry table — safe to retry vs manual review

| Job | Verdict | Rationale |
| --- | --- | --- |
| `j_34ba948a7b1a29…` (SUCCEEDED, real) | **Keep as-is — no retry** | Terminal, real provenance, output delivered; the residual 502 error field is attempt-1 history, auto-recovered |
| `j_6568c109d989bc…` (SUCCEEDED, real) | **Keep as-is — no retry** | Terminal, real provenance, output delivered, clean run |
| `j_290f6f497045e2…` (FAILED, auth, 0.24 s) | **Manual review — do NOT auto-retry** | Side-effect-free in principle (failed before provider touch, source intact, idempotent) — but: 7 days old, superseded by 2 successful same-input runs, and the API exposes no retry for terminal FAILED (only `NEEDS_ATTENTION` requeue). Recommendation: leave as historical record; cover the same path via the new Scenario-1 job |

## 11. Mandatory STOP honored

No restart, no deploy, no job retry, no file move/rename/delete, no DB record
change, no session change, no production config change. All observations above
come from read-only channels. **Awaiting approval** for: (a) the Scenario-1
single-file live test, (b) G3-B production deploy.

## 12. Integrity statement

- Level verified: **production-state audit (read-only)** — not a live
  processing run. The two SUCCEEDED jobs are `real`-provenance runs from
  2026-10-26 (pre-migration era, executed on the migrated data/host lineage).
- No secrets printed: account/session cookie contents, vault ciphertexts, and
  `.env` values were never read or displayed; the `secrets` table was queried
  for ref/kind metadata only.
