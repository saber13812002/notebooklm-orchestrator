# Phase H1 — Text-to-Notebook API (report)

Status: **implemented + tested (mock level) — Live NOT verified** (blocked on Google
re-login; runbook in §10)
Date: 2026-11-05
Design note: [`docs/architecture/h1-text-to-notebook.md`](../architecture/h1-text-to-notebook.md)

Honesty statement (per AGENTS.md §5): everything below verified at
**Unit / Integration / E2E (in-process, mock provider)** level only.
Real NotebookLM execution is **not** verified and is explicitly labeled
**Live: NOT verified** wherever it would matter.

---

## 1. What was delivered

| # | Deliverable | Status |
| - | ----------- | ------ |
| 1 | Design note | done — `docs/architecture/h1-text-to-notebook.md` |
| 2 | `POST /notebooks/from-text` (both surfaces) | done + tested |
| 3 | `GET /jobs/{id}/result` (both surfaces) | done + tested |
| 4 | Job execution: archive text source + `job_text` provider op (python worker) + mock provider text flow | done + tested (mock) / worker path live-untested |
| 5 | OpenAPI: spec + bidirectional drift test | done (54 operations) |
| 6 | Frontend parity (small) | done + tested |
| 7 | Tests (unit / integration / E2E-mock / web) | done — 212/212 green |
| 8 | Docs (API README, CHANGELOG, `.env.example`) | done |
| 9 | This report + mock E2E evidence | done |

No production changes, no push, no proxy/auth logic changes (P0 baseline
`fc54fc45`, 185/185 green — no regressions: suite grew 185 → 212).

## 2. API contract (implemented, tested)

### 2.1 Create — `POST /api/notebooks/from-text` (and `/api/v1/…`)

Request (zod-validated):

```jsonc
{
  "title": "optional, ≤200 chars", // absent/empty -> derived from text
  "text": "required, non-empty",   // ≤ NLO_MAX_TEXT_CHARS (default 200 000, code points)
  "metadata": { "language": "fa", "customer": "…", "category": "…" }, // all optional
  "summary": { "enabled": true, "prompt": "optional custom prompt" }  // optional
}
```

- **202** fresh: `{ jobId: "j_<hex32>", status: "CREATED", correlationId, createdAt,
  statusUrl }`; **200** + `x-idempotent-replay: true` on replay
  (`Idempotency-Key`, token-scoped, same rules as `POST /jobs`).
- **400** `validation_error`: missing/empty/whitespace-only text
  (`"text is required"`); oversized text with
  `details: { maxTextChars, charCount }` (limit from `NLO_MAX_TEXT_CHARS`,
  default **200 000**, count in code points — Persian counts one per char).
- **Chunking policy: reject, don't split** (one text = one source).
- v1 scope: `jobs:write`; correlation ids, rate limiting, audit apply automatically.

### 2.2 Result — `GET /api/jobs/{id}/result` (and `/api/v1/…`)

```jsonc
{
  "jobId": "j_…",
  "status": "CREATED|…|SUCCEEDED",
  "notebook": { "id": "…", "title": "…", "url": null, "shareUrl": null }, // null until SUCCEEDED
  "source":   { "id": "…" },                                            // null until SUCCEEDED
  "summary":  { "text": "…", "promptVersion": "v1" },                   // null until SUCCEEDED
  "provenance": "real" | "mock" | "unknown"
}
```

Honesty rules: `url`/`shareUrl` are **never fabricated** — always `null` today
(no provider reports shareable URLs yet). Unknown id → 404 `not_found`.
Pre-SUCCEEDED → `200` with the null shape + `provenance: "unknown"` (tested).
v1 scope: `jobs:read`.

### 2.3 Title + prompt strategy

- Title: request `title` (trimmed) if present, else
  `deriveTitleFromText` — first non-empty line, whitespace-collapsed, 80-char
  word-boundary cut, fallback `"Untitled text source"`. Resolved **at creation
  time**, used for both notebook title and text-source title (idempotency
  anchor for reuse-by-title in the worker).
- Prompt: empty `summary.prompt` → versioned default **`v1`** master prompt
  (bilingual, structured overview/key-points/notable-items, faithful,
  dominant-language, ≤500 words — `packages/shared/src/text-source.ts`);
  non-empty → `promptVersion: "custom"`. `summary.enabled: false` → empty
  prompt, `promptVersion: null`; job still creates notebook + source, providers
  skip the `chat.ask` step. Both prompt text and version are persisted in
  `input_json` and reported in the result.

## 3. Text-source mechanism + evidence

- **Library verified** (venv `data/venv`, notebooklm-py **0.8.5**,
  `notebooklm/_web/sources.py`): `WebSourcesAPI.add_text(notebook_id, title,
  content, *, wait=False, wait_timeout=120.0, idempotent=False) -> Source` is
  fully implemented; no documented hard text-size limit → the app-level
  `NLO_MAX_TEXT_CHARS` + 400 policy is app policy, not a library limit.
- **Worker** (`apps/server/src/providers/python-worker/nbl_worker.py`,
  `op_job_text`): read the archived text file → notebook reuse-by-title (create
  if missing) → source reuse-by-title else `sources.add_text` →
  `wait_until_ready` → `chat.ask` unless the prompt is empty → same result-dict
  shape as `op_job` (operation IDs + provenance metadata).
- **Runner** (`job-runner.ts`): passes `textPath` (archive
  `input/text-source.md`), `textTitle`, `notebookTitle`; `validate()` requires
  a prompt only for non-text jobs.
- **Archive**: server-chosen name `input/text-source.md` (never a user path
  component); `manifest.json` records `input.text: {file, charCount,
  sizeBytes, language}`.
- **DB**: **no migration** — `input_json` is free-form JSON; existing columns
  (`notebook_id`, `notebook_title`, `source_id`, `conversation_id`,
  `answer_markdown`, `result_provenance`) carry the result.
- **Mock provider**: text flow validates the text file exists, skips the ask
  when the prompt is empty, and emits deterministic text-only IDs
  (`mock_nb_<suffix>`, `mock_src_<suffix>`, `mock_conv_<suffix>`,
  suffix = last 16 hex of the job id) with `simulated: true` →
  `provenance: "mock"`. Audio-mock behavior unchanged (its "ID columns stay
  null" lifecycle test still passes).

## 4. OpenAPI

`spec.ts`: **52 → 54 operations** (+ `POST /notebooks/from-text`,
`GET /jobs/{id}/result`), new schemas `FromTextRequest`, `FromTextCreated`,
`JobResult`. The pre-existing **bidirectional drift test** (spec ↔ live app,
both surfaces) keeps them in lockstep — still green.

## 5. Frontend parity (small)

- `apps/web/src/lib/api.ts`: `jobCreateFromText()` (JSON POST to the legacy
  surface — the frontend contains no business logic).
- `apps/web/src/features/jobs/create-job.tsx`: audio/text mode toggle
  ("فایل صوتی" / "متن مستقیم"); text mode uses the same form (optional title,
  optional summary prompt, `max_text_chars` shown from
  `GET /settings` → `defaults.max_text_chars`, read-only).
- `apps/server/src/api/routes/settings.ts`: `defaults.max_text_chars` exposed
  (read-only; not in `writableKeys`).

## 6. Test results (final run, all green)

`npm test` (repo root): **212/212 passed**, 22 files, 3 workspaces.

| Workspace | Files | Tests | H1 additions |
| --------- | ----- | ----- | ------------ |
| `@nlo/shared` | 7 | 53 | `text-source.test.ts` — **9** (prompt resolution, title derivation incl. 80-char cut + fallback) |
| `@nlo/server` | 11 | 129 | `from-text.test.ts` — **11**: create integration (6: legacy-surface 202 payload + charCount/sha256/promptVersion, title derivation, v1 default prompt + `enabled=false`, custom prompt, 400 empty/whitespace, 400 oversized with limit in details), result integration (2: 404 both surfaces, pre-SUCCEEDED null shape), idempotency (1: replay 200 + header, token-scoped), E2E mock (2: POST→SUCCEEDED full result + archive assertions; `enabled=false` → null summary, no conversation). `openapi-v1.test.ts` **24 → 30** (new H1 describe: spec documents both paths, v1 202 shape, idempotent replay, 403 `jobs:read`, 400 empty text, 404 result) |
| `@nlo/web` | 4 | 30 | `create-job.test.tsx` **4 → 5** (text mode: switches mode, disables submit without text, submits via `POST /api/notebooks/from-text` with `summary: {enabled: true, prompt: null}`, never calls `/api/jobs`) |

Other gates (repo root, all green):

- `npm run typecheck` — clean (shared, server, web)
- `npm run lint` — clean (after excluding `tmp/` scratch from lint; see §8)
- `npm run format:check` — clean
- `npm run build` — clean (web: tsc + vite production build)

## 7. Mock E2E evidence (actual run, 2026-11-05T19:29Z)

Harness: `tmp/h1_evidence.ts` (scratch, not committed) — in-process app with
the mock provider, real Fastify routes, real SQLite archive.

```
POST /api/notebooks/from-text  ->  202
{
  "jobId": "j_9052ca0586bcf5aaf6b6ad03004fde35",
  "status": "CREATED",
  "correlationId": null,
  "createdAt": "2026-11-05T19:29:00.072Z",
  "statusUrl": "/api/jobs/j_9052ca0586bcf5aaf6b6ad03004fde35"
}
[nlo:proxy] selected node n1 (node_e99ea13e06764b2e); tunnel at 127.0.0.1:52458

runner.run(j_9052ca0586bcf5aaf6b6ad03004fde35) -> status "SUCCEEDED"

GET /api/jobs/j_9052ca0586bcf5aaf6b6ad03004fde35/result  ->  200
{
  "jobId": "j_9052ca0586bcf5aaf6b6ad03004fde35",
  "status": "SUCCEEDED",
  "notebook": {
    "id": "mock_nb_f6b6ad03004fde35",
    "title": "جلسه معماری NLO — H1 evidence",
    "url": null,
    "shareUrl": null
  },
  "source": { "id": "mock_src_f6b6ad03004fde35" },
  "summary": {
    "text": "# Mock Answer\n> This is a **deterministic mock** response. No real
            NotebookLM request was made.\n**Prompt:** Summarize the provided
            source text as a faithful, structured digest. … **Text source
            (first 200 chars):**\n\nگزارش جلسه: بررسی معماری NotebookLM
            Orchestrator\n…",
    "promptVersion": "v1"
  },
  "provenance": "mock"
}

archive: data/jobs/<jobId>/input/text-source.md exists, 306 bytes
manifest.input.text: { "file": "input/text-source.md", "charCount": 182,
                       "sizeBytes": 306, "language": null }
```

Note: `charCount` is code points (182) vs UTF-8 bytes (306) — the size limit
counts characters, as documented. The mock summary honestly labels itself as
simulated and includes the v1 prompt + a slice of the source text.

## 8. Files changed

**New**

- `packages/shared/src/text-source.ts` (master prompts, `resolveMasterPrompt`,
  `deriveTitleFromText`)
- `packages/shared/test/text-source.test.ts`
- `apps/server/src/api/job-create-text.ts`
- `apps/server/test/from-text.test.ts`
- `docs/architecture/h1-text-to-notebook.md`
- `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md` (this file)

**Modified**

- `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- `apps/server/src/config.ts` (`maxTextChars` / `NLO_MAX_TEXT_CHARS`)
- `apps/server/src/domain/archive.ts` (`storeText`, manifest text metadata)
- `apps/server/src/providers/types.ts` (`textPath?`, `textTitle?`,
  `notebookTitle?` — additive, nullable)
- `apps/server/src/providers/mock-provider.ts`
- `apps/server/src/queue/job-runner.ts`
- `apps/server/src/providers/python-worker/nbl_worker.py` (`op_job_text`)
- `apps/server/src/providers/python-worker/protocol.ts` (`OpCodes += job_text`)
- `apps/server/src/providers/python-worker/python-worker-provider.ts`
- `apps/server/src/api/routes/jobs.ts` (both routes)
- `apps/server/src/api/routes/settings.ts` (`defaults.max_text_chars`)
- `apps/server/src/api/v1.ts` (scope mapping)
- `apps/server/src/api/openapi/spec.ts`
- `apps/server/test/openapi-v1.test.ts`
- `apps/web/src/lib/api.ts`, `apps/web/src/features/jobs/create-job.tsx`,
  `apps/web/src/features/jobs/create-job.test.tsx`
- `docs/api/README.md`, `CHANGELOG.md`, `.env.example`
- `eslint.config.js` + `.prettierignore` — **governance fix**: `tmp/`
  (scratch probes/evidence, never committed) was failing `lint` /
  `format:check` with pre-existing errors; it is now excluded exactly like
  `data/` and `vendor/`. No effect on real source.

## 9. Known limitations

1. **Live execution NOT verified** — requires a fresh Google session (blocked
   on user re-login). All evidence above is mock-level.
2. `url`/`shareUrl` are always `null` today — the contract field exists, but no
   provider reports shareable URLs.
3. Text jobs do not support `preferredAccountId` / `preferredNodeId`
   (both stored `null`); account selection uses the normal pool.
4. Oversized text is rejected, never split (intentional policy; see design §2).
5. The python-worker `op_job_text` path is code-complete and protocol-tested
   (mock provider + unit coverage) but has **not** run against a real
   NotebookLM account — the runbook in §10 covers the first live run.
6. The frontend uses the legacy `/api` surface for text jobs (the web UI has no
   token concept); the v1 surface is for API consumers.

## 10. Live-acceptance runbook (when Google re-login is done)

Precondition: user re-authenticates the provider account (fresh Google session
file under `data/sessions/`), and a dedicated instance configured with the real
provider (`NLO_PROVIDER=python-worker`) + a healthy, verified egress proxy node
(fail-closed). Do **not** run live acceptance on the 4871 dev server.

1. Confirm the session: `GET /api/sessions` (provider overview) → the account
   is usable; if needed `POST /api/sessions/:id/verify`.
2. Create a small text job:
   `POST /api/notebooks/from-text`
   `{"text": "H1 live acceptance — <timestamp>. One short factual sentence."}`
   (≤ a few hundred chars) and record `jobId` + `statusUrl`.
3. Poll `GET /api/jobs/{id}` until `SUCCEEDED` or terminal failure (timeout
   ~10 min).
4. `GET /api/jobs/{id}/result` and assert:
   - `provenance == "real"` (provider metadata `simulated: false`);
   - `notebook.id` is a real NotebookLM notebook id (NOT `mock_nb_*`);
   - `source.id` is a real source id (NOT `mock_src_*`);
   - `summary.text` is a genuine digest of the submitted sentence (human
     check), `summary.promptVersion == "v1"`.
5. Verify the archive: `data/jobs/<jobId>/input/text-source.md` matches the
   submitted text byte-for-byte; `manifest.json` charCount/sizeBytes correct.
6. (Optional, human) Open the notebook in NotebookLM with the logged-in session
   and confirm the text source and notebook title exist as reported.
7. Append a **"Live verification (YYYY-MM-DD, job j_…)"** section to this
   report with the captured result JSON, then update the CHANGELOG entry from
   "Live NOT verified" to "Live verified".

Rollback note: nothing about the text endpoint requires a rollback path — it is
additive; the previous-good commit (P0, `fc54fc45`) remains the rollback
anchor per AGENTS.md §8.

## 11. Live acceptance evidence (2026-11-05) — BLOCKED on re-verify

**Attempt window:** 2026-11-05 20:31–21:13 UTC. Step 0 (verify the user's
just-completed login of `sas` = `acc_9ef8fd4d431c49fc`) was checked three
times (20:33, 21:00, 21:12 UTC). **The account is NOT authenticated
server-side → the canary text job was NOT submitted** (per the acceptance
protocol: stop and report evidence, no jobs).

### Evidence (read-only)

1. `GET /api/accounts` (21:12:16 UTC): `acc_9ef8fd4d431c49fc`
   `status: AUTH_REQUIRED`, `hasAuth: false`,
   `lastSuccessAt: 2026-10-22T05:33:29.745Z`.
2. `GET /api/sessions` (3 polls, 20:33 / 21:00 / 21:12 UTC):
   `sess_af33bf051ce04892` → `state: AUTH_REQUIRED`,
   `lastVerifiedAt: 2026-10-23T02:52:36.745Z` (13 days old),
   `sessionUsable: false`.
3. DB `auth_sessions`: sas row `updated_at = 2026-11-04T22:12:34.070Z` —
   no write after the 4871 server start (19:46 UTC) or after the reported
   ~20:31 UTC login.
4. `data/sessions/nlo-acc_9ef8fd4d431c49fc.json` last written 2026-10-23 —
   no fresh storage-state from today's sign-in.
5. `tmp/dev4871-h1.log` (pid 12088, new code `5e28c20`): no login/verify
   worker spawn after startup; no `auth op routed` line.
6. Chrome processes that appeared 20:55–20:58 UTC belong to the user's
   regular `Program Files\Google\Chrome`, not a Playwright Chromium — no
   NLO login window was opened.
7. `query session`: session 2 = `Disc` (worker/xray spawn hazard
   0xC0000142); `proxy_health` rows for both nodes today failed with
   `xray exited early (code=3221225794)` (16:24:46 / 16:35:03 UTC).
8. Server is otherwise healthy: `/api/health` and `/api/health/ready` →
   `ok: true`, `ready: true` (provider configured, xray available).

### Interpretation

The ~20:31 UTC sign-in never reached the 4871 server: no `AUTH_IN_PROGRESS`
→ `AUTHENTICATED` transition, no worker spawn, no session-file rewrite. The
UI badge is derived from `state === "AUTHENTICATED" && usable`, which the
server does not report — so the reported "AUTHENTICATED" view cannot be
reproduced from server state. Likely a stale tab / sign-in completed in a
browser context that never called the 4871 login endpoint (or that targeted
the killed 4870 server).

### PASS/FAIL — H1 text live acceptance

| Criterion                                    | Status                            |
| -------------------------------------------- | --------------------------------- |
| Job `SUCCEEDED`                              | **FAIL** — not executed (Step 0 precondition not met) |
| Real notebook id (not `mock_*`)              | N/A                               |
| Meaningful Persian title (not Untitled)      | N/A                               |
| Real source id (not `mock_*`)                | N/A                               |
| Genuine summary text, `promptVersion: v1`    | N/A                               |
| `provenance == "real"`                       | N/A                               |
| DB persistence (notebook/source/answer, prompt version) | N/A                     |

**Verdict: H1 text live = NOT verified (BLOCKED on re-verify).** Status of
this feature remains **implemented + tested (mock level)**; the §10 runbook
applies unchanged. Re-run after the user re-authenticates through the 4871
server's login flow (and preferably with session 2 `Conn`); then append the
captured result JSON here and flip the CHANGELOG line
"Live NOT verified" → "Live verified".

## 12. Second live-acceptance attempt (2026-11-05 23:32–23:42 UTC) — BLOCKED: cookie DB lock

**Outcome: canary text job NOT submitted** — the Step 0 precondition
(browser-import + server-side `AUTHENTICATED`) could not be reached.
Detailed evidence and the same-day P0 attempt are recorded in
`PHASE_P0_AUDIO_RECOVERY.md` §11 (both attempts share the same blocker);
summary:

- The user believed all Chrome windows were closed, but
  `tasklist | findstr /I chrome` (23:32 UTC) showed **32 `chrome.exe`
  processes**, including PID 8392 — the **active, visible Profile 3 window**
  (`chrome.exe --profile-directory="Profile 3"`) that holds an **exclusive
  lock** on `Profile 3\Network\Cookies`.
- Probe with the importer's exact access pattern (`tmp/probe_cookie_lock.py`):
  `shutil.copyfile` → `PermissionError [Errno 13]`; `sqlite3 ro` →
  `unable to open database file`; copy+`sqlite3` → `PermissionError [Errno
  13]`. A browser-import attempt would have failed with
  "browser database is locked" — per the acceptance protocol the import was
  **not fired** (no wasted 3-minute worker spawn) and no job was submitted.
- Server-side truth at stop (23:40 UTC, read-only): `sas`
  `state: AUTH_REQUIRED`, `lastVerifiedAt: 2026-10-23T02:52:36.745Z`
  (13-day-old), `sessionUsable: false`, `hasAuth: false`; session file
  `data/sessions/nlo-acc_9ef8fd4d431c49fc.json` last written 2026-10-23.
- Latent hazard: session 2 dropped to `Disc` at ~23:40 UTC and a worker
  spawn on the 4871 server exited with `0xC0000142` (3221225794) — the known
  RDP-disconnect spawn hazard (P0 report §11).

### PASS/FAIL — H1 text live acceptance (attempt 2)

| Criterion                                    | Status                                    |
| -------------------------------------------- | ----------------------------------------- |
| Job `SUCCEEDED`                              | **NOT executed** (Step 0 precondition not met) |
| Real notebook id (not `mock_*`)              | N/A                                       |
| Meaningful Persian title (not Untitled)      | N/A                                       |
| Real source id (not `mock_*`)                | N/A                                       |
| Genuine summary text, `promptVersion: v1`    | N/A                                       |
| `provenance == "real"`                       | N/A                                       |
| DB persistence (notebook/source/answer, prompt version) | N/A                     |

**Verdict (unchanged): H1 text live = NOT verified.**

### Known limitation discovered (UI Login button removed)

`f8a9ba4` ("single-user local app — remove admin token + auth gate") removed
the interactive **Login** button (`doLogin`/`sessionLogin`, `LogIn` icon)
from `apps/web/src/features/accounts/accounts.tsx` without a replacement —
the accounts page no longer offers the browser-based sign-in flow, leaving
**browser-import** as the only in-UI path to authenticate an account. This
makes the (rare) "browser database is locked" failure a full auth dead-end
until the user closes Chrome. A follow-up commit should restore the Login
button (or a re-export of the same `sessionLogin` flow); documented in
CHANGELOG as a known limitation.
