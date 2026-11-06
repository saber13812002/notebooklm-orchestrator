# Phase H0 + H1 — Final Acceptance Report (Consolidated)

- **Date:** 2026-11-06 (UTC)
- **Scope:** Mission "Repository Governance (H0) + Text-to-Notebook MVP (H1)", consolidated with the P0 audio recovery attempts that ran in the same window.
- **Working tree:** `main` @ `d6213df7961a53aee4f395ddfc636d6d0244c955`, 11 commits ahead of `origin/main`.
- **Status label:** this is an **acceptance report**, not a marketing summary. Every claim below is labeled with its verification level: `implemented+tested` / `implemented+live-verified` / `BLOCKED` / `not implemented` / `not locally verifiable`.

Primary per-phase reports (linked, not duplicated):

- [`PHASE_H1_TEXT_TO_NOTEBOOK.md`](PHASE_H1_TEXT_TO_NOTEBOOK.md) — H1 implementation + 4 live-acceptance attempts
- [`PHASE_P0_AUDIO_RECOVERY.md`](PHASE_P0_AUDIO_RECOVERY.md) — P0 audio repair + 5 live-acceptance attempts
- [`docs/architecture/h1-text-to-notebook.md`](../architecture/h1-text-to-notebook.md) — H1 design note
- [`docs/operations/gitlab-sync.md`](../operations/gitlab-sync.md) — GitLab mirror plan

---

## 1. Executive Summary

| Workstream                                                                         | Result                                                                                                                                                                                                                                                                                                                  | Verification level            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **H1 text-to-notebook** (`POST /notebooks/from-text`)                              | Delivered, tested, and **live-verified against real NotebookLM** (real account, real notebook/source/conversation IDs, `provenance: "real"`)                                                                                                                                                                            | `implemented + live-verified` |
| **H0 repository governance** (GitHub publication, repo hygiene, CI/CD mirror plan) | 11 commits prepared on `main`, regression fully green, secret-scan clean on the unpushed diff. **Not pushed** (explicit mission constraint).                                                                                                                                                                            | `committed-but-unpushed`      |
| **P0 audio submission recovery**                                                   | **BLOCKED.** 5 live-acceptance attempts; short operations (session verify, browser-import, H1 text) succeed, long-held audio operations fail 3/3 on the `france1-SeyedSaber` VLESS tunnel (`GET_NOTEBOOK ConnectTimeout` / `RemoteProtocolError`). A code-level worker wedge bug was additionally identified (§6, §16). | `BLOCKED` — not live-verified |
| **Final full regression**                                                          | All five gates green: typecheck, lint, format:check, **213/213 tests** (3 workspaces), build.                                                                                                                                                                                                                           | `passed 2026-11-06`           |

Nothing was pushed, no PR was created, no production change was made, and no live job was submitted after the acceptance runs (final regression is mock-only, per test policy).

## 2. Repository State

Captured 2026-11-06, read-only:

- **Branch:** `main`; **HEAD:** `d6213df7961a53aee4f395ddfc636d6d0244c955`
- **Ahead of `origin/main`:** 11 commits (list in §14)
- **Staged (index):** empty — nothing pre-staged
- **Stash:** empty
- **Working tree:** 4 untracked stray items, **unstaged, not to be committed**:
  - `$out` (2,135 B) — s52/AI-TOOLS systemd status + loopback probe dump from the production audit
  - `'2026-11-05'` (3,704 B) — forensic jobs-table dump (15 job rows, IDs/statuses only, no secrets). **The filename literally contains single-quote characters** (git quotes it).
  - `HTTP` (0 B) — empty file
  - `tmp/` (~250 scratch files: live-acceptance JSON captures, forensics scripts, vendored Python lib tree under `tmp/zoo-p1/pylib`)
- **Gitignore compliance:** `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.sqlite`, `*.key`, `*.pem`, `*.log`, `vendor/`, and `.prettierignore` excludes `tmp/`. Verified: **0 tracked files** under `data/`, `.env`, or `tmp/`.
- **Backups:** pre-P0 bundle at `data/backups/nlo-pre-P0-2026-11-05.bundle`; DB backup taken before orphan cleanup (`data/backups/nlo-pre-retry5-2026-11-06T02-52Z.sqlite`).
- **Local dev server:** port 4871 (pid 6932) left running per mission constraint — not restarted.

## 3. GitHub State

- **Remote `origin`:** `github.com/saber13812002/notebooklm-orchestrator` (public, source of truth per dual-repo policy).
- **Unpushed commits:** 11 (§14). **Diff stat:** `37 files changed, 4296 insertions(+), 131 deletions(-)`.
- **Secret scan of the unpushed diff** (full `git diff origin/main..HEAD`, 251,721 B, saved to `tmp/secret-scan-diff.txt`):
  - No `vless://` URIs, no `PRIVATE KEY` blocks, no real tokens/cookies/session material.
  - All `token` / `Bearer` / `cookie` / `api_key` hits are documentation placeholders (e.g. `nlo_...`), code identifiers (`tokenId`), or forensic descriptions of the Chrome cookie-DB lock — no values.
  - The one real email and the internal IP `172.30.0.133` appear only in `docs/reports/*` and `docs/operations/*`, which are already-public documentation (exempt per mission instruction; consistent with prior phase reports).
  - **Verdict: diff is clean and safe to push.**
- **Secret scan of untracked strays (working tree):** one real credential hit — a live **LiteLLM API key** (`LITELLM_API_KEY=sk-51Rk…` masked) in untracked `tmp/myterm.env.txt:23` and `tmp/server12848.env.json:39`. These files are untracked and unstaged and **will not be pushed**; the key should be rotated and the files removed (see §16, §17). Remaining `tmp/litellm-openapi.json` hits (`sk-QWr…`, `sk-Fn8…`) are placeholders inside a LiteLLM OpenAPI spec dump, not live keys.
- **CI:** `.github/workflows/ci.yml` exists (lint, typecheck, unit + feature tests, build). `gh` CLI is **not installed** on this machine, so GitHub Actions run status **cannot be verified locally**; CI will run on push. Stated honestly per mission constraint.
- **No push, no PR** — both explicitly out of scope for this mission.

## 4. GitLab State

Per [`docs/operations/gitlab-sync.md`](../operations/gitlab-sync.md) (H0 governance work):

- Internal host `git.ai.ismc.ir` (GitLab CE 16.3.9, container on the decommissioned s52) exists and was reachable during Phase B, but **no NLO project exists** and **no usable credentials (PAT) were found**.
- Setup is **blocked on a personal access token with `api` scope** (user action). One-time setup procedure is documented (`gitlab-sync.md` §4): create project → add remote → first one-way mirror push → optional internal CI.
- **One-way mirror policy** (GitHub → GitLab) is the committed policy; no GitLab runner was created; `.gitlab-ci.yml` is committed mirroring the GitHub workflow so internal CI can start once the mirror exists.
- **Not re-verified in this phase** — no GitLab credentials available locally. Stated honestly: GitLab mirror status = `planned, blocked on PAT`.

## 5. Capability Matrix

Derived from the live code (`apps/server/src/providers/python-worker/python-worker-provider.ts:187-207`, `apps/server/src/providers/types.ts`) cross-checked against live evidence from this mission. Levels use `CapLevel` semantics:

| Operation                                  | Declared level                                        | Evidence from this mission                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `validateConfiguration`                    | `implemented_tested`                                  | Worker ping + import check; covered by unit/integration tests                                                                  |
| `getAccountStatus`                         | `implemented_untested_live` (live-verified)           | `verify-live` PASS on 2026-11-06 03:04:33 UTC — "452 notebooks" for `acc_315776aeb5b74e33`                                     |
| `login`                                    | `implemented_untested_live` (live-verified)           | Browser-import (cookie export) PASS 2026-11-06 01:07:59 UTC after Chrome lock released                                         |
| `submitAudioJob`                           | `implemented_untested_live` (**BLOCKED in practice**) | 3/3 long audio runs failed on `france1-SeyedSaber` long-held connections (see §12, §16). Short ops on the same tunnel succeed. |
| `retrieveResult`                           | `implemented_untested_live` (live-verified for text)  | H1 text job `j_27d5753a…` returned a genuine grounded summary, `provenance: "real"`                                            |
| `retrieveArtifacts`                        | `unsupported`                                         | Chat answers are text; this workflow produces no downloadable artifacts (not fabricated — endpoints report accordingly)        |
| `cancelJob`                                | `experimental`                                        | Attempt #5 cancel was clean; but a timeout-path wedge bug exists (§16) — declared `experimental` is correct, not an overclaim  |
| **H1 `POST /notebooks/from-text`**         | `implemented + live-verified`                         | Live job `j_27d5753a15ed88a3d06072f03c4aebe6` SUCCEEDED in ~28 s with real IDs (§12)                                           |
| **Session auth (browser import + verify)** | `implemented + live-verified`                         | Import PASS, verify PASS (above)                                                                                               |
| **API tokens** (0005 migration)            | `implemented + tested`                                | Unit/integration tests; not exercised in live runs this phase                                                                  |
| **Webhooks**                               | **not implemented**                                   | Target capability only (docs/wiki/10 describes the planned contract). Not shipped, not claimed.                                |
| **Text-source ingestion (`add_text`)**     | `implemented + live-verified`                         | Real source `d9bd0118-ec34-431b-8097-89eae3e9f4a5` created in the live notebook                                                |

## 6. Architecture

- NLO remains **API-first and async**: every long operation is a job (`j_<hex32>`) with status, events, attempts, and results queryable via `/api/*` (legacy) and `/api/v1/*`. The frontend talks only to `/api/*` — no direct DB/worker/MCP/provider access.
- **H1 adds no new infrastructure.** Text-to-notebook reuses the existing job/queue/provider pipeline; the only new provider request fields are additive (`textPath`, `textTitle`, `notebookTitle` in `ProviderJobRequest`, `apps/server/src/providers/types.ts`). Design rationale: [`docs/architecture/h1-text-to-notebook.md`](../architecture/h1-text-to-notebook.md) (202-vs-201 semantics, title derivation, versioned prompt `v1`, `add_text` mechanism verified against notebooklm-py 0.8.5, security invariants).
- **Fail-closed egress preserved:** provider traffic goes only through verified xray VLESS tunnels; on auth failure the job fails closed (observed live, §12).
- **Code-level defect identified (documented, NOT fixed in this mission):** `apps/server/src/providers/python-worker/worker.ts:168-186` — the request timeout path calls `this.pending.delete(id)` **before** `this.kill(err)`, so `failAll()` finds no pending entry, the request Promise never settles, and the queue's `busy` flag stays stuck; `onAbort` also early-returns on `!this.pending.has(id)`, making a cancel during a timeout non-terminal. Observed live as orphaned job `j_94d36895…` (RUNNING after the 30-min worker timeout). This is the reason `cancelJob` stays `experimental`. Fix belongs to the next phase (see §17).

## 7. API Contract

H1 endpoints (both surfaces: `/api/...` and `/api/v1/...`):

- **`POST {base}/notebooks/from-text`**
  - Request: `{ text, prompt?, language?, notebookTitle?, idempotencyKey? }` (zod-validated)
  - `202` → `{ jobId }` for a fresh job
  - `200` + header `x-idempotent-replay: true` → replay of the job derived by notebook title (reuse-by-title idempotency)
  - `400` with error envelope `{ "error": { "code": "validation_error", "message": ..., "details": { "maxTextChars": n } } }` for empty/whitespace/oversized text
  - Limit: `NLO_MAX_TEXT_CHARS` (default 200,000 **code points**)
- **`GET {base}/jobs/{id}/result`**
  - Returns `{ jobId, status, notebook { id, title, url, shareUrl }, source, summary { text, promptVersion }, provenance }`
  - `provenance` ∈ `real | mock | unknown` — honest labeling per run
  - `url` / `shareUrl` are **never fabricated**: `null` unless the provider actually returned them
- **Title strategy:** derived from source text, 80-char cap (`deriveTitleFromText`, shared package, tested).
- **Prompt strategy:** versioned master prompt `v1` (bilingual fa/en, ≤500 words); `promptVersion` is recorded on the result and in `result_provider_meta`.
- **Error envelope** is consistent across all routes: `{ "error": { "code", "message" } }` via `ApiCodes` in `packages/shared/src/api-error.ts`.
- **Client examples** shipped: `docs/api/examples/from-text.md`, `from-text.ts`, `from-text.py`.

## 8. OpenAPI Changes

- Spec lives in `apps/server/src/api/openapi/spec.ts`; operation count went **52 → 54** with the H1 addition.
  - `FromTextRequest` schema at `spec.ts:199`; updated `JobResult` schema (notebook/source/summary/provenance) at `spec.ts:251`.
- **Bidirectional drift test** (`apps/server/test/openapi-v1.test.ts`) keeps spec and route handlers in sync — 10 describe blocks, including a dedicated **"text-to-notebook API (H1)"** block covering the new operation and schemas. This test is in the final green run (§10).
- Served at `/openapi.json` + Swagger UI (existing capability, unchanged).

## 9. Database Changes

- Migration set (5 files, all already applied, no new migration required by H1):
  1. `0001_initial.sql` — base schema, `answer_markdown`
  2. `0002_real_runtime.sql` — `ALTER TABLE jobs ADD` `notebook_id`, `notebook_title`, `source_id`, `conversation_id`, `result_provenance` with `CHECK (result_provenance IN ('real','mock','unknown'))`
  3. `0003_account_default.sql`
  4. `0004_session_profile_per_account.sql`
  5. `0005_api_tokens.sql`
- **H1 required no schema change:** text input is stored in the free-form `input_json` (sha256 + charCount recorded in `result_provider_meta`); notebook/source/conversation IDs and provenance are covered by migration 0002.
- Data lives in `data/nlo.sqlite` (git-ignored, survives checkout/deploy per deploy rules).

## 10. Tests and Results

**Final full regression, run from repo root 2026-11-06, all gates green:**

| Gate      | Command                | Result                                              |
| --------- | ---------------------- | --------------------------------------------------- |
| Typecheck | `npm run typecheck`    | PASS (exit 0; 3 workspaces)                         |
| Lint      | `npm run lint`         | PASS (exit 0)                                       |
| Format    | `npm run format:check` | PASS — "All matched files use Prettier code style!" |
| Tests     | `npm test`             | **PASS — 213/213 tests, 23 test files**             |
| Build     | `npm run build`        | PASS — `@nlo/web` tsc + vite (`✓ built in 8.06s`)   |

Per-workspace test breakdown:

| Workspace     | Test files | Tests   |
| ------------- | ---------- | ------- |
| `@nlo/shared` | 7          | 53      |
| `@nlo/server` | 12         | 130     |
| `@nlo/web`    | 4          | 30      |
| **Total**     | **23**     | **213** |

(H1's own report recorded 212; the +1 is `worker-nonascii-protocol.test.ts` added in `19fba24` — worker protocol frames must stay pure-ASCII so non-ASCII error text can't crash the worker.)

Notable coverage relevant to this mission: `from-text.test.ts` (validation 400/`validation_error` + `details.maxTextChars`, replay/idempotency semantics, result shape), OpenAPI drift (H1 block), job state machine, SSRF guard, safe names, retry policy, redaction, session 404 mapping (`sessions-404.test.ts`), fail-closed egress (`fail-closed.test.ts`).

## 11. Mock vs Live Verification

Honest split — mock tests do **not** prove real NotebookLM execution:

- **Mock (CI-runnable, always):** the entire 213-test suite runs against the mock provider / in-process app. E2E flow (upload → job → result → artifact listing) is verified at mock level. This is what CI will check on push.
- **Live (manual gate only, never in CI — real Google accounts, real egress, cost):**
  - **H1 text-to-notebook: LIVE VERIFIED** — job `j_27d5753a15ed88a3d06072f03c4aebe6` SUCCEEDED (~28 s) against real NotebookLM with a real account, real notebook/source/conversation, `provenance: "real"`, `simulated: false` (§12, §13).
  - **Browser-import auth: LIVE VERIFIED** — PASS 2026-11-06 01:07:59 UTC.
  - **Session verify: LIVE VERIFIED** — PASS 03:04:33 UTC ("452 notebooks").
  - **P0 audio: NOT live-verified — BLOCKED** after 5 attempts (2026-11-05 → 2026-11-06). Pattern: short operations (verify, browser-import, H1 text) succeed on the `france1-SeyedSaber` tunnel; long-held audio operations fail 3/3 (`GET_NOTEBOOK ConnectTimeout` at retry, `RemoteProtocolError` mid-processing). Root-cause evidence and the learned retry runbook are in [`PHASE_P0_AUDIO_RECOVERY.md`](PHASE_P0_AUDIO_RECOVERY.md) §14–§15.
- **Scripts:** `apps/server/scripts/e2e-live.ts`, `verify-live.ts` (manual only).

## 12. Actual Job Evidence

### H1 text (LIVE, PASS)

Job **`j_27d5753a15ed88a3d06072f03c4aebe6`** — created 2026-11-06 01:09:08.380Z, finished 01:09:36.753Z (~28 s), status `SUCCEEDED`:

- Notebook `8e4e3b67-8580-47ce-8a80-7a90192c3d62` (title derived from the Persian carpet-weaving input, 80-char cap applied)
- Text source `d9bd0118-ec34-431b-8097-89eae3e9f4a5`; conversation `2a884bd4-63d1-4b61-a230-6d352f061572`
- Account `acc_315776aeb5b74e33` (`saber.tabatabaee@gmail.com`); route `france1-SeyedSaber` (node `node_23e81d9a6ca04d10`, tunnel `127.0.0.1:52316`)
- `result_provider_meta`: `simulated: false`, `provider: python-worker`, `sourceKind: "text"`, text sha256 `aebddeaabd40d0c371d2464fc14dd8d8c1ed50f1bfa659c61bb1c1763931f36c`, `charCount: 345`, `language: fa`, `promptVersion: v1`
- `configSnapshot`: `maxTextChars: 200000`
- Result: genuine Persian structured summary (Overview / Key points / Notable items with `[1]` source references; `answer_markdown` length 1305), `provenance: "real"`, `notebook.url`/`shareUrl` = `null` (not fabricated)
- DB trail verified: job row + `job_events` (created → validate → account_selected → proxy_selected → running → succeeded) + `job_attempts` (attempt 1, ok)
- Full JSON captured locally in `tmp/live-h1-result.json` and `tmp/live-h1-job.json` (git-ignored forensics); narrative evidence in `PHASE_H1_TEXT_TO_NOTEBOOK.md` §14.

### P0 audio (LIVE, BLOCKED — attempt trail)

All on `france1-SeyedSaber`, account `acc_315776aeb5b74e33`:

| Job                                  | Attempt    | Outcome                                                                                                                                                                                                                 |
| ------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `j_b45e039af33911ea2de580b7e9d14268` | #4         | FAILED — session TTL expired mid-retry (10-min `isUsable` window), fail-closed on 401                                                                                                                                   |
| `j_7f10a3c5f6c524600187882878d86711` | #4         | FAILED — instant auth error (agent did not re-verify before submit)                                                                                                                                                     |
| `j_94d3689555e347e409b5ad9f9734b23f` | #4         | Orphaned — worker 30-min timeout; Promise never settled (worker.ts wedge bug, §6); cleaned via DB edit after backup                                                                                                     |
| `j_10d3fbe7c2f97890dfc4932fa3d951fa` | #5 (final) | 201 at 03:05:14; stuck at progress 55; `GET_NOTEBOOK RemoteProtocolError` 03:06:36 then silence; early-stopped at the 15-min mark; CANCELLED cleanly at 03:22:47.818Z. `England_1` fallback rejected with `ECONNRESET`. |

Conclusion: **P0 audio remains BLOCKED** on long-connection tunnel reliability (plus the 10-min session TTL interacting with long ops). The retry runbook learned in attempt #5 is documented in `PHASE_P0_AUDIO_RECOVERY.md` §15.

## 13. Screenshots or API Responses

No screenshots are available (headless server-side runs; the web UI has no from-text capture this phase). Actual API responses instead:

**Live `GET /api/jobs/j_27d5753a15ed88a3d06072f03c4aebe6/result` (real run, 2026-11-06 01:09:36 UTC):**

```json
{
  "jobId": "j_27d5753a15ed88a3d06072f03c4aebe6",
  "status": "SUCCEEDED",
  "notebook": {
    "id": "8e4e3b67-8580-47ce-8a80-7a90192c3d62",
    "title": "قالی‌بافی ایران ریشه در تمدن کهن فلات ایران دارد. بافندگان در شهرهایی چون مراغه،",
    "url": null,
    "shareUrl": null
  },
  "source": { "id": "d9bd0118-ec34-431b-8097-89eae3e9f4a5" },
  "summary": {
    "text": "**۱. نمای کلی (Overview)** … [full Persian structured summary, 1305 chars, with [1] references — complete text in tmp/live-h1-result.json and PHASE_H1_TEXT_TO_NOTEBOOK.md §14] …",
    "promptVersion": "v1"
  },
  "provenance": "real"
}
```

**`POST /api/notebooks/from-text` fresh-accept example (mock E2E run, 2026-11-05T19:29Z, from `PHASE_H1_TEXT_TO_NOTEBOOK.md` §7):**

```json
HTTP/1.1 202 Accepted
{ "jobId": "j_<hex32>" }
```

Replay returns `HTTP/1.1 200 OK` with header `x-idempotent-replay: true` and the same `jobId`. Validation failure:

```json
HTTP/1.1 400 Bad Request
{ "error": { "code": "validation_error", "message": "text must be non-empty and within the size limit", "details": { "maxTextChars": 200000 } } }
```

## 14. Commit Hashes

Unpushed mission commits on `main` (11), oldest → newest, as of report writing:

| #   | SHA                                        | Date       | Subject                                                                                                                |
| --- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `fc54fc45ded92fabda266ee83c7476c61dbd1fa5` | 2026-11-05 | fix(audio): session preflight on create-job + 404 for unknown account ids (P0 audio submission recovery)               |
| 2   | `a32547dab640e58c3d9c18a7aa9d0695379dbf70` | 2026-11-05 | feat(api): add text-to-notebook endpoint (H1)                                                                          |
| 3   | `07d1475f2da2bbc94aac91fea2dcfe0d1e0f7d4b` | 2026-11-05 | test(api): cover text-to-notebook (H1)                                                                                 |
| 4   | `5e28c20a8e9fc6e16f4048056a8be0bd2e14edd0` | 2026-11-05 | docs: update API and mission reports for H1 text-to-notebook                                                           |
| 5   | `19fba24fe9919712d4cd5ca35308ead3dbfdcdc9` | 2026-11-06 | fix(auth): keep worker protocol frames pure-ASCII so non-ASCII errors don't crash the worker                           |
| 6   | `dcd0c2320c2600623ef10772e660d3998d81d1ea` | 2026-11-06 | docs(evidence): live acceptance results — P0 audio + H1 text-to-notebook                                               |
| 7   | `6adc746b6c1cdd5829214eb98e3ebfa0b2b29dba` | 2026-11-06 | docs(evidence): live acceptance results — browser-import auth + P0 audio + H1 text                                     |
| 8   | `58e90b27b8cbf0b0a40aac64fe826dbcd3f12978` | 2026-11-06 | docs(api): H1 from-text client examples + regression verification; fix minor gaps                                      |
| 9   | `6f7e8f45e89ef55c95784efa3bb1d8efc640e674` | 2026-11-06 | docs(evidence): live acceptance attempt #3 — BLOCKED: 0xC0000142 at xray spawn on Disc session, Chrome lock still held |
| 10  | `3344b32ddb4929368ddea149042c520183030b48` | 2026-11-06 | docs(evidence): live acceptance attempt #4 — unblocked environment, results                                            |
| 11  | `d6213df7961a53aee4f395ddfc636d6d0244c955` | 2026-11-06 | docs(evidence): P0 audio attempt #5 — final retry result                                                               |

This report is committed **on top** of the above as one additional commit with message `docs: PHASE_H0_H1 final acceptance report (consolidated)` — its SHA is recorded in the delivery summary (not listed here to avoid self-reference in the committed file).

## 15. Deployment Readiness

- **Production path unchanged:** git-based `deploy/deploy.sh` → systemd service `nlo`; only commits reachable from `origin/main` are deployable, so **nothing from this mission is deployable until the push happens** (user approval gate).
- `deploy/deploy.sh` already backs up `data/nlo.sqlite` + `.env` on every deploy and prints the previous-good commit (rollback path); DB restore from `data/backups/`.
- **Production host `172.30.0.133`:** read-only during this mission — still running deployed commit `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9`; **no production change was made**. (Legacy host s52 decommissioned 2026-11-01.)
- Docker Compose remains local single-user only; production stays on systemd per deployment rules.
- Readiness checklist: regression green (§10) ✔ · secret-scan clean on diff (§3) ✔ · docs + CHANGELOG updated ✔ · OpenAPI in sync (drift test) ✔ · deploy scripts untouched this mission ✔. **Remaining gates: user-approved push → CI green on GitHub → GitLab mirror (blocked on PAT) → deploy decision for 172.30.0.133.**

## 16. Known Limitations

1. **P0 audio is BLOCKED, not fixed.** Long-held operations on `france1-SeyedSaber` drop (`GET_NOTEBOOK ConnectTimeout` / `RemoteProtocolError`); the 10-min session TTL (`auth-sessions.repo.ts` `isUsable`) expires mid-run; 0xC0000142 at xray spawn on RDP `Disc` sessions; Chrome Profile-3 cookie-DB exclusive lock during import. Retry runbook documented, but no stable long-connection route has been demonstrated.
2. **`worker.ts` timeout/cancel wedge** (`apps/server/src/providers/python-worker/worker.ts:168-186`): timeout deletes the pending entry before kill → Promise never settles → queue `busy` sticks; cancel during timeout is non-terminal. Observed live (orphaned `j_94d36895…`). Documented; **not fixed in this mission**.
3. **Webhooks: not implemented.** Planned contract only (`docs/wiki/10`); never claimed as available.
4. **UI Login button removed** (`f8a9ba4`) — interactive login is currently dead UI code; auth works via browser-import only.
5. **GitLab mirror not established** — no NLO project, blocked on a `api`-scope PAT; status not re-verified this phase.
6. **GitHub CI status not locally verifiable** — `gh` CLI not installed; CI only runs after push.
7. **Working-tree hygiene:** 4 untracked strays (`$out`, `'2026-11-05'`, `HTTP`, `tmp/`) left in place; `tmp/myterm.env.txt:23` and `tmp/server12848.env.json:39` contain a live LiteLLM API key (masked here) that should be rotated and the files deleted.
8. **Production not yet running this code** — `172.30.0.133` is at `b5e9ad3`; H1 is live-verified on the local 4871 instance only.

## 17. Next Phase Recommendations

1. **Push (user approval):** push the 12 commits (11 mission + this report) to `origin/main`; let GitHub Actions run the CI gate; then mirror to GitLab.
2. **GitLab:** obtain a `api`-scope PAT, execute `docs/operations/gitlab-sync.md` §4 (project → remote → first mirror push), verify per its §5 checklist.
3. **Fix the `worker.ts` wedge** (timeout path: settle the Promise _before/without_ orphaning state — e.g. reject-then-delete ordering and make `kill` tolerate missing entries), with a unit test reproducing the orphan scenario; re-grade `cancelJob` once proven.
4. **P0 audio retry** using the runbook from `PHASE_P0_AUDIO_RECOVERY.md` §15: fresh verified session immediately before submit, stable/alternate route for long connections (tunnel keepalive or new node), and re-verify on any auth error. Treat first success as the acceptance gate.
5. **Production deployment plan** for `172.30.0.133` (systemd `nlo`) after CI green — including the DB backup/rollback rehearsal `deploy/deploy.sh` already provides.
6. **Hygiene:** delete the untracked strays, rotate the exposed LiteLLM key, and keep `tmp/` out of the repo (already git-ignored; recommend a cleanup step).
7. **Product targets (not started):** webhooks, correlation IDs, idempotency keys, and restoring/repurposing the interactive login flow.
