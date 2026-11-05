# H1 — Text-to-Notebook API (design note)

Status: **implemented** (mock-level verified; live verification pending Google re-login)
Phase: H1 — Phase 2 of the "Audio Recovery + H1 Complete" mission
Date: 2026-11-05

## 1. Goal

Allow callers to create a NotebookLM notebook **from pasted/POSTed text** (not
only uploaded audio), run a (versioned) summary prompt against the text source,
and retrieve a stable, honest result contract:

- `POST /api/v1/notebooks/from-text` (JSON) → `202 Accepted`
- `GET /api/v1/jobs/{id}` and `GET /api/v1/jobs/{id}/result`

The endpoint is registered on **both** API surfaces (legacy `/api/*` and
versioned `/api/v1/*`) by adding it to `registerJobRoutes` — the two surfaces
share one handler module and therefore cannot drift.

## 2. Endpoint contract

### 2.1 Create — `POST {base}/notebooks/from-text`

Request (JSON, zod-validated):

```jsonc
{
  "title": "optional, max 200 chars", // user title; derived from text if absent
  "text": "required, non-empty",
  "metadata": { "language": "fa", "customer": "…", "category": "…" }, // all optional
  "summary": { "enabled": true, "prompt": "optional custom prompt, max 20 000" }, // optional
}
```

Validation (400 `validation_error` envelope on failure):

| Rule                                     | Behavior                                    |
| ---------------------------------------- | ------------------------------------------- |
| `text` missing / empty / whitespace-only | 400, `message: "text is required"`          |
| `text` larger than `NLO_MAX_TEXT_CHARS`  | 400, `details: { maxTextChars, charCount }` |
| other schema violations                  | 400 via standard zod handling               |

`NLO_MAX_TEXT_CHARS` — env-configurable, **default 200 000** characters
(code points, not bytes — Persian text counts one per character).

**Chunking policy: reject, don't split.** One text = one source. Splitting
into multiple sources is unverified against the library, would break the
source-title idempotency anchor (§5), and degrades grounding. Oversized input
is rejected with a 400 that names the limit.

**Response: `202 Accepted`** (chosen deliberately over `201`): the request
does not produce a complete resource — it produces a _job_ that will be
processed asynchronously (notebook creation, indexing, prompt). `202` is the
honest status for "accepted for processing". Idempotent replay returns
`200` with `x-idempotent-replay: true` (same semantics as job creation).

```jsonc
// 202 (fresh) — replay is 200 with the same body
{
  "jobId": "j_<hex32>",
  "status": "CREATED",
  "correlationId": "cr_<32hex>" | null,   // null on the legacy /api surface
  "createdAt": "2026-11-05T…Z",
  "statusUrl": "/api/v1/jobs/j_<hex32>"
}
```

`Idempotency-Key` header is honored with the exact same rules as
`POST /jobs` (key format `^[A-Za-z0-9._-]{8,128}$`, token-scoped, replay
returns the original job).

### 2.2 Result — `GET {base}/jobs/{id}/result`

```jsonc
{
  "jobId": "j_…",
  "status": "SUCCEEDED",                     // any JobStatus while in flight
  "notebook": { "id": "…", "title": "…", "url": null, "shareUrl": null }, // null unless SUCCEEDED
  "source":   { "id": "…" },                // null unless SUCCEEDED
  "summary":  { "text": "…", "promptVersion": "v1" }, // null unless SUCCEEDED
  "provenance": "real" | "mock" | "unknown"
}
```

Honesty rules:

- `url` / `shareUrl` are **never fabricated**. They are only ever populated
  when the provider actually confirmed a shareable URL — today the provider
  reports none, so both are always `null`. The fields exist so the contract
  does not break when the provider gains that capability.
- `provenance` is carried from the provider metadata: `simulated: true →
"mock"`, `simulated: false → "real"`, absent → `"unknown"`.
- Unknown job id → 404 `not_found` (standard envelope).

## 3. Title strategy

1. `title` from the request (trimmed) if present;
2. otherwise `deriveTitleFromText(text)` — the first non-empty
   line/sentence of the text, whitespace-collapsed, truncated to 80
   characters (word-boundary aware where cheap).

The resolved title is written into `input.title` **at creation time** and is
used for two purposes downstream (mirroring the audio job's
notebook-by-title pattern in `nbl_worker.py:op_job`):

- **Notebook title** — the worker reuses a notebook whose title matches,
  creating one only if missing (idempotent across retries).
- **Text source title** — the worker reuses an existing source whose title
  matches before calling `add_text` (idempotency anchor; see §5).

Because both are derived from the same resolved title at creation, a retried
or idempotently-replayed job lands in the same notebook with the same source.

## 4. Prompt strategy (versioning)

- Versioned default prompts live in `packages/shared/src/text-source.ts`
  (`MASTER_PROMPT_VERSIONS`). Version **`v1`** is bilingual (Persian +
  English), structured (overview → key points → notable facts), faithful
  (no invention), and matches the dominant language of the source text
  (Persian source → Persian summary). Max ~500 words.
- `summary.prompt` non-empty → that custom prompt is used and
  `input.promptVersion = "custom"`.
- Otherwise `input.promptVersion = "v1"` and the stored prompt text is the
  v1 master prompt.
- `summary.enabled: false` → the job is stored with an **empty prompt**; the
  runner's `validate()` no longer requires a prompt for text jobs, and both
  providers skip the `chat.ask` step entirely (worker: `skip_ask`; provider:
  `answerMarkdown: null`). The job still creates the notebook + text source
  and still succeeds.
- The prompt text + version are persisted in the job's `input_json`
  (`input.prompt` + `input.promptVersion`), so the result contract can report
  which prompt version produced the summary.

## 5. Text-source mechanism + evidence

**Verified against the installed library** (venv `data/venv`, notebooklm-py
**0.8.5**, inspected source `notebooklm/_web/sources.py`):

```python
async def add_text(self, notebook_id: str, title: str, content: str, *,
                   wait: bool = False, wait_timeout: float = 120.0,
                   idempotent: bool = False) -> Source
```

`WebSourcesAPI.add_text` is fully implemented (POSTs the content via the
`/batchexecute` text-source RPC). `append_text` also exists. No documented
hard text-size limit was found in the library (source sweep) — hence the
app-level `NLO_MAX_TEXT_CHARS` + 400 policy, not a library-derived limit.

The library's capability matrix classifies text `ADD_SOURCE` as
`NON_IDEMPOTENT_NO_RETRY` and its own guidance is: _"embed a UUID in the
title and dedupe client-side."_ We follow the stronger, already-proven
pattern from `op_job`: **reuse-by-title before add** (list sources, match on
title, reuse; else `add_text`). The resolved title (§3) is the anchor.

Live behavior (real NotebookLM) is **not** verified yet — it requires a
fresh Google session (blocked on user re-login). The runbook for the live
acceptance test is in `docs/reports/PHASE_H1_TEXT_TO_NOTEBOOK.md`.

## 6. Job / queue / provider plumbing (mapping)

| Layer                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types.ts`               | `JobInput` extended (additive): `text? {sha256, sizeBytes, charCount, language?}`, `promptVersion?`, `metadata? {language?, customer?, category?}`. No DB migration — `input_json` is free-form JSON.                                                                                                                                                                                                       |
| `apps/server/src/config.ts`                  | `maxTextChars` (`NLO_MAX_TEXT_CHARS`, default 200 000).                                                                                                                                                                                                                                                                                                                                                     |
| `apps/server/src/domain/archive.ts`          | `storeText(content)` → `input/text-source.md` + manifest `input.text` metadata.                                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/api/job-create-text.ts`     | New `createJobFromText` (mirrors `createJobFromUpload`: replay check → validation → `jobs.create` → archive init + `storeText` → event → rollback on failure).                                                                                                                                                                                                                                              |
| `apps/server/src/api/routes/jobs.ts`         | `POST {base}/notebooks/from-text` (202/200-replay) + `GET {base}/jobs/:id/result`.                                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/api/v1.ts`                  | scope: `POST /notebooks/from-text → jobs:write`; `GET /jobs/:id/result → jobs:read` (fallback).                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/providers/types.ts`         | `ProviderJobRequest` extended (additive, nullable): `textPath?`, `textTitle?`, `notebookTitle?`.                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/queue/job-runner.ts`        | passes `textPath` (archive `input/text-source.md`), `textTitle`, `notebookTitle` (`input.title` ?? `nlo-<jobId16>`); `validate()` requires a prompt only for non-text jobs; archive init records text metadata.                                                                                                                                                                                             |
| `apps/server/src/providers/mock-provider.ts` | text flow: validates the text file exists; skips the egress "ask" when the prompt is empty; deterministic IDs **for text jobs only** (`mock_nb_/mock_src_/mock_conv_` + `notebookTitle`) so the audio-mock "ID columns stay null" lifecycle test remains honest.                                                                                                                                            |
| `apps/server/src/providers/python-worker/`   | `protocol.ts`: `OpCodes += "job_text"`. `nbl_worker.py`: `op_job_text` (read text file → notebook by title → source reuse by title else `sources.add_text` → `wait_until_ready` → `chat.ask` unless prompt empty → same result dict shape as `op_job`). `python-worker-provider.ts`: branch to `job_text` when `req.textPath` set; `notebookTitle` from `req.notebookTitle` (fallback unchanged for audio). |
| OpenAPI                                      | `spec.ts`: two new paths + `FromTextRequest`/`FromTextResponse`/`JobResult` schemas; the existing bidirectional drift test keeps spec and live app in lockstep.                                                                                                                                                                                                                                             |

The queue itself is unchanged: text jobs enter as `CREATED`, the single
worker picks them up like audio jobs.

## 7. Frontend parity (small)

`apps/web` gains `jobCreateFromText` in `lib/api.ts` (JSON POST to the
legacy surface — no business logic in the frontend) and a minimal
audio/text mode toggle on the create-job page. No restyle, no new routes,
no new backend surface.

## 8. Security invariants preserved

- No secrets in payloads/logs; archive files are inside the job's data dir.
- Text is stored server-side under a server-chosen name
  (`input/text-source.md`) — never a user path component.
- Same loopback/auth model: v1 scope `jobs:write`, rate limiting, audit,
  correlation ids all apply automatically.
