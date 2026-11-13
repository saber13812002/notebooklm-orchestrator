# PHASE NLO-P2 — Audio Pipeline: Feasibility Checkpoint & Blocker Report

**Date (UTC):** 2026-11-13 · **Branch:** `main` · **HEAD:** `6e09259` (P1 commits `81e86a8`, `0c4047c`, `6e09259` intact)
**Verdict:** **BLOCKED — core capability NOT IMPLEMENTED in this repository** (evidence below)

> This is an honest checkpoint, not a delivery. Per Part 18/20, the mission is **not** COMPLETE:
> a real text→podcast→file flow was **not** produced.

---

## 1. Executive Summary

Discovery proved three decisive facts:

1. **`notebooklm-py 0.8.5` DOES support Audio Overview** — `client.artifacts.generate_audio(notebook_id)`,
   `AudioFormat.DEEP_DIVE`, artifact types carrying `media_urls` + `duration_seconds`, plus an
   `artifact_transfers` / `downloads` path. So the capability is reachable **without** inventing new APIs.
2. **NLO's own worker does not use it.** `apps/server/src/providers/python-worker/nbl_worker.py` exposes
   exactly: `ping`, `validate`, `verify`, `login`, `job` — and `job` takes an **audio file as _input_**,
   uploads it as a source and returns a **text answer** (`answer`, `references`). There is **no**
   audio-generation op, no artifact download, no MP3 step.
3. **The capability matrix already says so honestly**: `python-worker-provider.ts` marks `mp3/m4a/ogg`
   as `experimental` with note _"not live-verified on the real service"_.

⇒ The product today is **"chat/summary over a source"**, not "podcast generation". P2's core is a real
implementation task (new worker op + adapter + lifecycle + artifact + FFmpeg + webhook + E2E), not a fix.

## 2. Environment facts (verified now)

| Item                              | Value                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data/venv`                       | **present**; `notebooklm-py 0.8.5` importable                                                              |
| Audio API in library              | `notebooklm/_artifacts.py: async def generate_audio(...)`, `AudioFormat.DEEP_DIVE`                         |
| Audio artifact metadata available | `media_urls`, `duration_seconds`, `generation_options.source_ids` (from `_android/codecs/artifacts.py`)    |
| Download support                  | `notebooklm/downloads`, `_android/artifact_transfers.py`                                                   |
| **FFmpeg**                        | **NOT INSTALLED** on this host (`where ffmpeg` → not found) ⇒ 56 kbps MP3 cannot be produced/verified here |
| NLO service                       | **not running** (`4870/4871` → `000`); no container/compose present locally                                |
| Live prerequisites                | Google account/session + proxy **not verified** in this environment                                        |

## 3. What exists vs. what is missing (per mission DoD)

| DoD item                                                        | Status                          | Evidence                                                                |
| --------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `GENERATE_AUDIO_OVERVIEW` domain op                             | **NOT IMPLEMENTED**             | no such op in `nbl_worker.py`; provider `operations` list has none      |
| Versioned prompt                                                | **NOT IMPLEMENTED** (for audio) | prompt is per-request text in `job` op                                  |
| External operation tracking (audio)                             | **NOT IMPLEMENTED**             | `operationIds` exist on Job but audio never populates them              |
| Job lifecycle stages for audio (17 stages)                      | **NOT IMPLEMENTED**             | current state machine has no audio stages                               |
| Deadline/backoff polling                                        | **PARTIALLY**                   | `waitSec`/`timeoutSec` exist in the worker `job` op; no audio poll loop |
| Idempotent recovery (unknown external result → NEEDS_ATTENTION) | **NOT IMPLEMENTED** for audio   | no audio submission exists yet                                          |
| Artifact storage + metadata (sha256/duration/codec/bitrate)     | **PARTIALLY**                   | `Artifact` model has id/jobId/filename/mediaType/size/source only       |
| Artifact validation (signature/decode)                          | **NOT IMPLEMENTED**             | P1 added _expectation_ rules only (size/MIME/digest)                    |
| MP3 56 kbps transcode                                           | **BLOCKED**                     | FFmpeg absent; installing on production is forbidden without approval   |
| Download API (secure, ownership)                                | **PARTIALLY**                   | `GET /jobs/{id}/artifacts/{artifactId}` exists per OpenAPI              |
| Webhook delivery                                                | **NOT IMPLEMENTED**             | unchanged from P1 audit                                                 |
| `text-to-podcast` E2E scenario                                  | **NOT IMPLEMENTED**             | P1 runner has no such scenario                                          |
| Live acceptance                                                 | **BLOCKED**                     | no running service, no verified account/session/proxy                   |

## 4. Required implementation plan (scoped, no parallel engine)

1. **Worker** (`nbl_worker.py`): add `op_job_audio` → verify notebook+source → `artifacts.generate_audio(notebook_id, AudioFormat.DEEP_DIVE, prompt)` → return `external_operation_id`; add `op_audio_status` + `op_audio_download` using library polling/transfers; map library errors to the existing stable codes.
2. **Provider adapter** (`python-worker-provider.ts`): declare `generate_audio_overview` + `wait_audio` + `download_artifact` as real operations (flip matrix from `experimental` to `implemented_untested_live` **only after** a live run).
3. **Job lifecycle**: add audio stages to `job-state.ts` (VALIDATING_INPUT … AUDIO_GENERATION_PENDING … DELIVERING_RESULT) with persisted checkpoint/`externalOperationId`; timeout ⇒ `NEEDS_ATTENTION` (never blind re-submit).
4. **Artifact**: extend `Artifact` with `sha256`, `durationSeconds`, `codec`, `bitrate`, `sampleRate`, `provenance`; atomic move temp→final; path from server-generated keys only.
5. **MP3 56 kbps**: FFmpeg with `-b:a 56k`, then decode-check + duration tolerance; keep original; **requires FFmpeg availability** (production install = separate approval).
6. **Webhook**: outbox-style delivery from existing events, HMAC + timestamp + SSRF guard (DST IP allowlist/deny private ranges), retries with backoff, `failed`/dead-letter state.
7. **E2E**: extend P1 runner with `--scenario text-to-podcast` (JSON + Markdown report, `--expect-mime audio/mpeg`, `--expect-bitrate 56`, webhook check).
8. **Tests**: unit (state mapping, backoff, idempotency, artifact rules, HMAC, retry) + integration (worker↔adapter↔storage↔download) + recovery matrix (10 cases in Part 11) via fault injection — **no production destructive tests**.

## 5. Blockers (each needs a decision from you)

| #   | Blocker                                     | Needed                                                                                                                                                  |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | No running NLO instance for live acceptance | approval to start a local instance (mock provider) **and** provide host for live                                                                        |
| B2  | Live provider prerequisites                 | a valid Google account/session + working proxy (unchanged; I must not touch sessions/proxies)                                                           |
| B3  | FFmpeg absent                               | approve installing FFmpeg in the local venv/container **or** accept "MP3 step NOT TESTED"                                                               |
| B4  | Scope                                       | P2 is ~18–20 SP; a full implementation + live proof cannot be completed inside the remaining session budget — it needs a dedicated long-running session |

## 6. What was NOT done (explicit)

No worker op, adapter, lifecycle, artifact, MP3, webhook or E2E scenario code was written in this phase,
because the mission requires those to be **live-verified** and the environment cannot satisfy B2/B3.
Writing them now would produce unverifiable code and risk presenting a mock as real. No existing test
was removed or disabled; P1 assets are untouched.

## 7. Backup / Rollback

No source change in this phase ⇒ nothing to roll back. New bundle to be taken before P2 implementation
(`data/backups/nlo-p2.bundle`). P1 bundle: `data/backups/nlo-p1.bundle` (SHA-256 `2506b0ed…`).

## 8. Git

No new commits in this phase (documentation only). Working tree would remain clean after committing this
report. Push still not performed (no publication authorization; GitHub-only remote).

## 9. Recommendation

Proceed with P2 in a dedicated session **after** answering B1–B3. If you prefer immediate progress without
live credentials, the highest-value subset is: _(i)_ worker audio op + adapter + lifecycle + unit/integration
tests against the library's mocked surface, and _(ii)_ webhook outbox — both are CODE-VERIFIABLE without a
live account. Live acceptance would then be the closing step.
