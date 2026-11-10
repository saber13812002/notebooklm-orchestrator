# NLO — Text Request: Zero-to-Hundred Trace & Verification (2026-11-10)

Requested: "trace the text-request algorithm zero-to-hundred, actually run a
test, and report what a text request looks like end-to-end" — evaluated
against the user's 5-stage expectation:

1. Send a text file (e.g. a book) as a source → a **new notebook** is created.
2. A prompt runs → an output is produced, e.g. a **podcast**.
3. After ~20 minutes the podcast is ready → **download** it.
4. Convert it to **MP3 56 kbps**.
5. Via a **web service, from another server**, publish it to **Bale / Soroush
   / Eitaa / Telegram**.

Verdict up front: **stage 1 is implemented and live-verified; stages 2–5 are
not implemented.** The system today turns a text request into a **markdown
answer stored on the job** — no audio, no file to download, no transcode, no
distribution. All five stages of the expectation exist in the roadmap; this
report maps each one to its phase and blocker.

---

## 1. Fresh test evidence (run 2026-11-10, this session)

Command (repo root):

```
npm test --workspace @nlo/server -- from-text --reporter=verbose
```

Result: **exit 0 — 1 file, 11/11 tests passed** (vitest 3.2.7, duration
3.46 s). Highlights:

- `POST /notebooks/from-text (integration) > accepts text via the legacy
/api surface with the documented 202 payload` — `202 {jobId}`
- `... uses the versioned default master prompt (v1) and honors
summary.enabled=false`
- `... rejects empty / whitespace-only / missing text with 400
validation_error`
- `... rejects oversized text with 400 + the limit in details
(NLO_MAX_TEXT_CHARS)`
- `idempotent text job creation > replays the original job for the same
token + key (200 + header), new job for a new token`
- **E2E (in-process, mock provider) > `POST text -> SUCCEEDED with
notebook/source/summary + mock provenance`** — the zero-to-hundred test
- **E2E > `summary.enabled=false -> SUCCEEDED with null summary text and no
conversation`**

The E2E test ([`apps/server/test/from-text.test.ts`](apps/server/test/from-text.test.ts:259))
asserts, over real HTTP against a live in-process app with account + proxy
node + mock provider:

1. `POST /api/notebooks/from-text` with `{title: "E2E notebook", text}` →
   `202 {jobId}`.
2. `ctx.runner.run(jobId)` → job row `SUCCEEDED`.
3. Archive on disk: `data/jobs/<id>/input/text-source.md` contains the exact
   submitted text; `manifest.json` records `input.text {file, charCount}`.
4. `GET /api/jobs/<id>/result` → `200`:
   - `notebook: {id: "mock_nb_<suffix16>", title: "E2E notebook", url: null,
shareUrl: null}` (URLs **never fabricated**),
   - `source: {id: "mock_src_<suffix16>"}`,
   - `provenance: "mock"`,
   - `summary: {promptVersion: "v1", text: <markdown answer containing the
title + first 200 chars of the source>}`.
5. Jobs DB row carries `notebookId` / `sourceId` / `conversationId`
   (`mock_conv_*`), `resultProvenance: "mock"`, non-null `answerMarkdown`.

Log during the run shows the fail-closed proxy path is exercised
(`[nlo:proxy] selected node n1 ...; tunnel at 127.0.0.1:53756`).

**Honest level: in-process mock E2E. This proves the pipeline, state
machine, archive, and result contract — it does NOT prove real NotebookLM
execution.** (Live text jobs were previously verified on production; see
§6.1.)

---

## 2. The pipeline, zero to hundred (code-verified)

### Stage 0 — Request

`POST /api/notebooks/from-text` (legacy surface) or `POST
/api/v1/notebooks/from-text` (token auth, scope, rate limit, correlation id,
idempotency key). Body: `{text (required), title?, prompt?,
summary?: {enabled}, language?, metadata?}`.

### Stage 1 — Validation & creation

[`apps/server/src/api/job-create-text.ts`](apps/server/src/api/job-create-text.ts:35)
(`createJobFromText`):

- Idempotent replay: same token + key → `200` + replay header (original job);
  new token → new job. (Tested.)
- `text` non-empty; `charCount = Array.from(text).length` must be ≤
  `NLO_MAX_TEXT_CHARS` (default **200 000**) else `400 validation_error`
  with the limit in details. (Tested.)
- `summaryEnabled = body.summary?.enabled !== false`; an empty prompt is
  legal **only** for text jobs (notebook + source are still created; no ask
  step).
- `prompt` = caller prompt (version `custom`) or the versioned master prompt
  (`promptVersion: "v1"`).
- `title` = user title else first non-empty text line else "Untitled
  notebook" ([`packages/shared/src/title.ts`](packages/shared/src/title.ts:62)).
- `language` = normalized caller hint else `detectLanguage(text)`.
- `ctx.jobs.create(...)` → status `CREATED`; archive `init` +
  `storeText(text)` (stored verbatim); on archive failure the job is rolled
  back to `FAILED invalid_input`.
- Response: `202 {jobId}`.

### Stage 2 — Queue & runner

[`apps/server/src/queue/job-runner.ts`](apps/server/src/queue/job-runner.ts:85)
(`JobRunner.run`), one job at a time, state machine from
`packages/shared/src/job-state.ts`:

- `CREATED → VALIDATING`: prompt required (unless text job with
  summary disabled — [`job-runner.ts`](apps/server/src/queue/job-runner.ts:331));
  archive initialized.
- `→ QUEUED → WAITING_FOR_ACCOUNT`: account selection — a requested
  `preferredAccountId` is honored strictly (fails rather than silently
  switching); otherwise default account, then most-recently-successful
  eligible. Eligibility = enabled, not DISABLED/AUTH_REQUIRED, **and** an
  AUTHENTICATED session verified within TTL — a DB flag alone is never
  sufficient ([`job-runner.ts`](apps/server/src/queue/job-runner.ts:389)).
- `→ WAITING_FOR_PROXY`: `proxyManager.selectAuto()` validates config + fresh
  health (self-heals STALE via a real staged check) and starts the VLESS
  tunnel. **Fail-closed:** no usable node → job `FAILED`
  (`errorClass: "proxy"`, "no approved proxy route available").
- `CANCEL_REQUESTED` race handled before the attempt starts.
- `→ RUNNING`: `provider.runJob({textPath, textTitle, notebookTitle,
tunnel, egress, signal, onProgress})` with progress updates persisted.

### Stage 3 — Provider

**python-worker (production):**
[`apps/server/src/providers/python-worker/python-worker-provider.ts`](apps/server/src/providers/python-worker/python-worker-provider.ts:423)

- Fail-closed: job without an approved tunnel throws
  `proxy` (`no approved proxy tunnel ... direct egress is not allowed`);
  missing session file → `auth` (needs re-auth).
- Spawns `nbl_worker.py` via the worker supervisor with
  `requestTimeoutMs = NLO_JOB_TIMEOUT_MS` (**default 30 min**,
  [`apps/server/src/config.ts`](apps/server/src/config.ts:186)).
- Op `job_text` params: `{sessionPath, textPath, textTitle, prompt,
notebookTitle, waitSec: 1800, timeoutSec: 1800}` (30 min source-processing
  wait; worker-stage events map to progress 10→100).
- Empty answer with a non-empty prompt → **provider failure** ("never
  report an unsupported/empty result as successful").
- Returns `{answerMarkdown, providerMeta (simulated:false, real
notebook/source/conversation IDs, route), artifacts: []}` —
  [`python-worker-provider.ts`](apps/server/src/providers/python-worker/python-worker-provider.ts:563):
  **the real provider surfaces zero artifact files for every job** (it must
  not fabricate files the provider did not produce).

**mock (tests only):** [`apps/server/src/providers/mock-provider.ts`](apps/server/src/providers/mock-provider.ts:108)
simulates add-text → index → ask (the ask call still goes **through the
egress/tunnel boundary**, so fail-closed behavior is exercised) and returns
one clearly-labeled sample `.txt` artifact plus deterministic
`mock_nb_*` / `mock_src_*` / `mock_conv_*` IDs.

### Stage 4 — Worker op

[`apps/server/src/providers/python-worker/nbl_worker.py`](apps/server/src/providers/python-worker/nbl_worker.py:503)
(`op_job_text`):

1. Reads the stored text file (must be non-empty).
2. `get_account_email(live_fallback=True)`.
3. **Notebook:** reuse existing notebook with the **exact same title**, else
   create one.
4. **Text source:** reuse an existing source with the same title (the
   idempotency anchor), else `sources.add_text(notebook_id, textTitle,
content)`.
5. `sources.wait_until_ready(notebook_id, source_id, timeout=1800)` — wait for
   NotebookLM to index the source.
6. Empty prompt → skip ask. Else `chat.ask(notebook_id, prompt,
source_ids=[source_id])`.
7. Returns `{email, notebookId, notebookTitle, sourceId, uploaded,
conversationId, turnNumber, answer, references, checkedAt}`.

The worker has exactly two job ops: `job` (audio → transcript + ask) and
`job_text`. **There is no audio-overview / Deep Dive / podcast op** —
[`apps/server/src/providers/types.ts`](apps/server/src/providers/types.ts:16)
declares "generate audio overview" a distinct, not-interchangeable operation
that is out of scope of the current interface.

### Stage 5 — Success path

Back in the runner ([`job-runner.ts`](apps/server/src/queue/job-runner.ts:247)):

- Artifacts from the provider are copied into the job archive and the
  `artifacts` table (real provider: none; mock: one sample).
- Attempt recorded `ok`; account success recorded.
- Job `SUCCEEDED` with `answerMarkdown`, `resultProvenance`
  (`mock` / `real` / `unknown` — measured from the provider's own `simulated`
  flag, never assumed), `notebookId`, `notebookTitle`, `sourceId`,
  `conversationId`, `progress: 100`.
- Archive finalization: `answer.md`, `execution/timeline.jsonl`,
  `execution/attempts.json`. Tunnel stopped in `finally`.

### Stage 6 — Reading the result (what the user gets)

[`apps/server/src/api/routes/jobs.ts`](apps/server/src/api/routes/jobs.ts:145):

- `GET /api/jobs/:id/result` → `{jobId, status, notebook: {id, title,
url: null, shareUrl: null}, source: {id}, summary: {text:
<markdown answer>, promptVersion}, provenance}`.
- `GET /api/jobs/:id/events`, `/attempts`.
- `GET /api/jobs/:id/artifacts` (list) and
  [`/artifacts/:artifactId`](apps/server/src/api/routes/jobs.ts:204)
  (download; server-assigned `storage_key`, path re-derived inside the job
  dir via `resolveWithin`).
- `GET /api/jobs/:id/audio` — streams the **input** audio for the web player
  (audio jobs only).

**Net effect today:** a text request produces a notebook + text source in
Google NotebookLM and a **markdown answer** viewable via the result endpoint
and the web UI. There is **no file output** to download from a real text job.

---

## 3. The 5-stage expectation vs. reality

| #   | Expectation                                                                 | Status                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Text file (book) → source in a new notebook                                 | **Implemented + live-verified** (H1, on prod since `d705634`)                                                                                                             | Live-verified previously on prod; re-verified at mock level today (§1). Caveats in §4.                                                                                                                                                                                                                                                                                 |
| 2   | Prompt → podcast output                                                     | **Not implemented** — output is a markdown `chat.ask` answer                                                                                                              | [`nbl_worker.py`](apps/server/src/providers/python-worker/nbl_worker.py:503) ops; [`types.ts`](apps/server/src/providers/types.ts:16) "audio overview" out of scope; roadmap master **Phase 4**, live gate **B9**.                                                                                                                                                     |
| 3   | Download the podcast after ~20 min                                          | **Partially**: download/result endpoints implemented + tested, but a real job produces **no artifact file at all** (`artifacts: []`) — there is nothing audio to download | [`python-worker-provider.ts`](apps/server/src/providers/python-worker/python-worker-provider.ts:563); endpoints in [`jobs.ts`](apps/server/src/api/routes/jobs.ts:184). Timing: source wait 30 min + job timeout 30 min — the ~20-min expectation is plausible for processing, but audio-overview duration is unverified (B9).                                         |
| 4   | Convert to MP3 56 kbps                                                      | **Not implemented** — no transcode code anywhere                                                                                                                          | Blocker **B6** OPEN (FFmpeg absent locally, no conversion code); scoped in master **Phase 4** ("audio conversion (MP3 56 kbps)").                                                                                                                                                                                                                                      |
| 5   | Publish from a web service on another server to Bale/Soroush/Eitaa/Telegram | **Not implemented** — no distribution module exists                                                                                                                       | Webhooks (Phase 5, **B8**) are outbound job-status callbacks only. Publishing is scoped in master **Phase 4** ("artifact publishing") and the 18-phase roadmap **Phase 13 "Messaging (Bale/Soroush/Eitaa/Telegram/Rubika)"** (open, public-send gate). "Another server" additionally needs master **Phase 6** deploy (prod is behind `origin/main`; **B5** sudo gate). |

### Roadmap mapping (authoritative: `NLO_MASTER_EXECUTION_STATUS.md`

§8, 2026-11-09 reconciliation; 18-phase table in
`docs/ROADMAP_MASTER.md`)

- **Master Phase 4** — "Deep Dive generation + audio conversion (MP3 56 kbps)
  - artifact publishing": covers expectation stages **2, 3 (audio part), 4**.
    PENDING. Live gate **B9** (audio-overview generation unverified against real
    NotebookLM — note: the verified live audio job proved _audio→text
    transcription_, a _different_ NotebookLM capability) and **B6** (FFmpeg
    missing locally, no conversion code).
- **Master Phase 5** — Webhooks + integration (needs **B8**: destination +
  shared secret) — the hook a "web service on another server" would use to
  learn the job is done.
- **Master Phase 6** — Production deploy of the current commit (prod 7+
  commits behind; **B5** sudo gate).
- **18-phase roadmap:** Phase 9 (prompt engine + output catalog), 11
  (artifacts/downloads), 13 (messaging to the four platforms), 17
  (production E2E + release) are the long-tail of this expectation.

---

## 4. Key constraints found (relevant to the "book → podcast" vision)

1. **200 000 character input limit** (`NLO_MAX_TEXT_CHARS`, default) — a full
   book is typically far larger; multi-source/batch input is roadmap Phase 7
   and Drive/ZIP input Phase 8.
2. **30-minute hard timeout** (`NLO_JOB_TIMEOUT_MS`) with a 30-minute
   source-processing wait (`waitSec: 1800`) — workable for text, but a real
   audio-overview job's duration is unknown until the B9 live spike.
3. **Notebook/source reuse is by exact title match** — the idempotency
   anchor. "A new notebook" per book is guaranteed only when the title
   differs; re-sending the same title reuses the existing notebook and source
   (by design, so retries are idempotent against NotebookLM).
4. **Real jobs have no downloadable artifacts** — `artifacts: []` by
   construction (no fabricated files). Output today = markdown on the job
   row only.
5. **Fail-closed egress** — a job without a verified VLESS tunnel fails;
   direct egress is never a fallback (dev-only opt-in exists and is off by
   default).

---

## 5. Document discrepancy found (recorded for correction)

`FULL_PROJECT_AUDIT_2026-11-10.md` §14 carries a simplified blocker table
that disagrees with the authoritative post-reconciliation table
(`NLO_MASTER_EXECUTION_STATUS.md` §7): it lists B6/B7 as DNS, B9 as "LiteLLM
key", B10 as "Wiki.js credentials", and omits B2/B4. The checkpoint §7 table
(B2 = local VLESS health PARTIAL, B6 = FFmpeg absent, B7 = LiteLLM key
hygiene PARTIAL, B8 = webhook destination+secret, B9 = audio-overview live
gate, B10 = no `gh` CLI) is the source of truth. The audit doc's table was
corrected in the commit accompanying this report.

---

## 6. Verification levels (honest)

- **§1 fresh run:** in-process mock E2E + integration, 11/11 passed, this
  session.
- **Stage 1 live status:** **re-verified live in this session** — a real
  NotebookLM text job succeeded on dev 4871 at 13:53–13:54 UTC 2026-11-10
  through the france1 tunnel with `provenance: "real"` (full evidence in §7).
  Prior live verification (H1 on prod since `d705634`) remains valid
  context. This is a manual live gate; it is never run in CI.
- Stages 2–5 remain **not implemented**: the live run produced no audio and
  no artifacts (`/artifacts` → `[]`), consistent with §3 and §4.4.

## 7. Live execution evidence (2026-11-10, 13:53–13:54 UTC, dev 4871)

Executed at the user's explicit request ("اجرا کنیم" → live real text job).

Gates:

1. `GET /api/health/ready` → ready; provider `python-worker`; xray present.
2. `POST /api/sessions/acc_315776aeb5b74e33/verify` → FAILED ("Authentication
   expired or invalid" — session was 4 days stale, `sessionUsable: false`).
3. User-approved `POST .../browser-import`
   (`{"browser":"chrome","account":"saber.tabatabaee@gmail.com","timeoutSec":600}`)
   → first attempt failed (Chrome held its cookie DB, OS error 32); after the
   approved Chrome kill, the retry → `state: AUTHENTICATED`,
   `lastVerifiedAt: 2026-11-10T13:53:05Z` (re-verified against the real
   service through the tunnel).

Job:

- `POST /api/notebooks/from-text` — title
  `Live Trace Coffee Origins 20261110-1353` (unique → new notebook), 415-char
  English text → `202 {jobId: j_599fc5300d20a2ec682ef956d42f66c1}`.
- Events (`GET /api/jobs/<id>/events`, 7): `created` 13:53:55.502 →
  `validate` → `account_selected` (صابر) → `proxy_selected`
  (`france1-SeyedSaber`, tunnel `127.0.0.1:58929`, health fresh at
  13:52:21) → `proxy_candidate_rejected` (`node_1e238ac8aed440cb`
  ECONNRESET — correctly excluded) → `running` (attempt 1) → `succeeded`
  13:54:32.
- `GET /api/jobs/<id>/result` → `200`:

```json
{
  "jobId": "j_599fc5300d20a2ec682ef956d42f66c1",
  "status": "SUCCEEDED",
  "notebook": {
    "id": "4b56c514-c2a4-4c94-a80e-6f68a50ed894",
    "title": "Live Trace Coffee Origins 20261110-1353",
    "url": null,
    "shareUrl": null
  },
  "source": { "id": "89d960db-63e0-4864-8243-3733f4dbd1cb" },
  "summary": { "text": "### 1. Overview ...", "promptVersion": "v1" },
  "provenance": "real"
}
```

- Job row `resultProviderMeta`: `simulated: false`,
  `email: saber.tabatabaee@gmail.com`, `sourceKind: text`,
  `notebookId: 4b56c514-…`,
  `conversationId: 8c3f83b8-5b01-42fe-b695-188b0c7a1f30`, `turnNumber: 1`,
  `references[0].sourceId: 89d960db-…`,
  `route: {nodeId: node_23e81d9a6ca04d10, port: 58929}`.
- `GET /api/jobs/<id>/artifacts` → `[]` (no file output by design — the
  answer is markdown on the job; §4.4).
- Wall clock: created 13:53:55.496Z → succeeded 13:54:32.403Z = **37 s** for
  short text. The "~20 minutes" in the 5-stage expectation is not a system
  setting; the hard limit is the 30-min `NLO_JOB_TIMEOUT_MS`, and longer
  inputs/answers simply take longer.

## 8. Actions taken / not taken

- Actions: ran the from-text suite (evidence above); wrote this report;
  corrected the stale blocker table in the audit doc; re-authenticated the
  «صابر» session via the approved browser-import; created, monitored, and
  verified the live text job of §7.
- Not taken (approval gates, unchanged): no prod deploy/restart, no new code,
  no push.

## 9. Integrity statement

Every capability label in this report is backed by the cited file (code
read today), the fresh test run of §1 (exit 0, 11/11), or the live run of
§7 (terminal `SUCCEEDED`, `provenance: "real"`, real UUIDs). Nothing is
claimed that is not implemented. The five-stage expectation is a target
state, not the current product; §3 states exactly which stages exist.
