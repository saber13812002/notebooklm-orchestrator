# Audio (Podcast) Pipeline Architecture (NLO-P2)

**Status:** implemented + unit/integration-tested (30 provider-audio, 11 podcast-lifecycle, 19 fault-recovery, 9 transcode, 18 artifact-storage, 16 e2e-text-to-podcast tests) · **LIVE NOT TESTED** (no real Google account / egress in the local environment; see `docs/reports/PHASE_NLO_P2_TEST_RESULTS.md`).

## 1. Principle

The podcast pipeline is a **second half of the existing job lifecycle**, not a new engine.
A text (or audio-file) job first runs the base provider job exactly as before
(create notebook → add source → optional ask). When the job was created with
`podcast.enabled`, the runner then continues with a provider-bound audio
pipeline inside the SAME attempt, through the SAME state machine, queue,
retry, proxy and recovery machinery.

```
POST /api/v1/notebooks/from-text  (or /api/v1/jobs) with podcast: {...}
        │
        ▼
   job-runner.run(jobId)                       ← existing engine, unchanged
   ├─ select account / proxy (fail-closed)
   ├─ provider.runJob(...)                     ← base job (mock or python-worker)
   ├─ store base artifacts
   └─ runPodcastPipeline(...)                  ← NLO-P2 extension, same attempt
        ├─ audio_generation  (submit or resume external task, then poll)
        ├─ artifact_download (into a temp name in the job output dir)
        ├─ artifact_validate (signature / WAV parse — before anything is stored)
        ├─ artifact_store    (artifacts row with metadata + sha256 + provenance)
        └─ mp3_transcode     (best-effort; job succeeds on the WAV if it fails)
```

There is deliberately NO separate "audio job" type: a podcast is a capability
flag on a job, so all existing observability (events, attempts, stages,
artifacts, cancel, requeue, webhook) applies without special cases.

## 2. Layering (as built)

| Layer            | File                                                                                               | Responsibility                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Domain (pure)    | `packages/shared/src/job-state.ts`, `retry.ts`                                                     | state machine, retry classification + backoff (shared with the base job)                                            |
| Worker (Python)  | `apps/server/src/providers/python-worker/nbl_worker.py`                                            | real `notebooklm-py 0.8.5` calls: `generate_audio`, `poll_status`, `download_audio` (JSON-line protocol, unchanged) |
| Provider adapter | `apps/server/src/providers/python-worker/python-worker-provider.ts`                                | binds the 3 audio ops (`generateAudio`/`getAudioStatus`/`downloadAudio`) over the worker; capability matrix entry   |
| Mock provider    | `apps/server/src/providers/mock-provider.ts`                                                       | deterministic offline audio simulation (task-id state machine, WAV bytes) — **only** controlled-mock boundary       |
| Runner           | `apps/server/src/queue/job-runner.ts` (`runPodcastPipeline`)                                       | stage orchestration, deadline polling, resume-on-restart, validation gates, transcode dispatch                      |
| Persistence      | `apps/server/src/domain/stages.repo.ts`, `artifacts.repo.ts`, migration `0006_audio_artifacts.sql` | per-stage rows, artifact metadata columns, external operation ids                                                   |
| Media            | `apps/server/src/media/transcode.ts`, `artifact-validate.ts`                                       | FFmpeg MP3 56 kbps adapter (spawn, timeout, stderr capture); signature sniffing + WAV chunk parsing                 |

Direction is preserved: the runner depends on the provider interface
(`Provider` in `apps/server/src/providers/types.ts`); the provider interface
declares the three audio ops as **optional** — a provider without them simply
cannot run a podcast job (see §6), never "works but silently skips".

## 3. The audio lifecycle (stages)

`job_stages` rows make every stage observable and restart-recoverable:

| Stage               | Persists                                                                       | Failure handling                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audio_generation`  | `external_operation_id` = the external task id                                 | non-ambiguous provider error → retryable (bounded); ambiguous → `NEEDS_ATTENTION` (never auto-retry); abort → `CANCELLED`                                          |
| `artifact_download` | temp file path (`podcast-tmp-<hex12>`)                                         | `ready:false` after confirmed completion → ambiguous `NEEDS_ATTENTION` (stage row failed, temp file removed)                                                       |
| (size gates)        | —                                                                              | 0-byte or oversize (runner `maxPodcastBytes`, default 200 MiB; not yet an env var) → `invalid_input` FAILED, temp file removed                                     |
| `artifact_store`    | artifact row: sha256, size, duration, codec, sample rate, channels, provenance | unrecognized audio signature / unparseable WAV → `invalid_input` FAILED, temp file removed                                                                         |
| `mp3_transcode`     | mp3 artifact row (`source_artifact_id` → wav)                                  | **best-effort**: any failure (no ffmpeg, spawn/exit/timeout/empty output) → stage failed + honest `transcode` report; the job still SUCCEEDS with the original WAV |

### 3.1 Resume, never re-submit

The external task id is persisted (`jobs.operation_ids.audio_task_id` +
`job_stages.external_operation_id`) **before** the poll loop starts. On boot,
`jobs.recoverInFlight()` returns the job to `QUEUED`; on the next run, if a
podcast job already has an `audioTaskId`, `generateAudio` is called with
`resumeTaskId` and the provider checks the external status first:

- task still `in_progress` → keep the task id, no new submission, event
  `podcast_resume_kept { taskId, resumed: true, priorStatus }`;
- task proven `failed` → audited resubmission (event records
  `priorStatus: "failed"`), because a proven-failed external task cannot
  recover server-side;
- task `completed`/`not_found`/unknown → same rule: only a proven-failed
  prior state justifies a fresh submission.

This is what makes a process restart (or a runner yield) safe: **at most one
new external task is ever created per job unless the previous one is proven
failed**.

### 3.2 Polling with a budget

The poll loop uses `getAudioStatus` with backoff
(`backoffMs(polls, { baseMs: 5000, capMs: 60_000 })`) until:

- `isComplete` → proceed to download;
- `isFailed` → non-ambiguous provider error (retryable by the normal policy);
- abort signal → `CANCELLED` (task id preserved for reconciliation);
- the job row is no longer `RUNNING` (e.g. restart) → **yield** (return to
  the queue; the attempt is recorded as no-attempt, matching the base-job
  restart semantics);
- deadline (runner `podcastDeadlineMs`, default 25 min; not yet an env
  var) → **ambiguous** `NEEDS_ATTENTION`: the external task may still
  complete server-side, so
  auto-retry could double-submit.

## 4. Provider capability matrix

`apps/server/src/providers/types.ts` declares audio capability explicitly:

- `PythonWorkerProvider`: all three ops (real `notebooklm-py`).
- `MockProvider`: all three ops (deterministic simulation).
- A provider with missing ops → a podcast job fails fast with
  `invalid_input: "podcast requested but the active provider does not
support audio generation"` **before any stage row is written**.

The base job must also report a `notebookId` in `providerMeta`; without it,
audio generation cannot target a notebook and the job fails
`invalid_input` before the pipeline starts. This is "never report an
unsupported operation as successful", applied at the capability boundary.

## 5. Inputs (both preserved)

- **Text** (fa/en): `POST /api/v1/notebooks/from-text` with
  `podcast: { enabled, instructions?, language?, format?, length? }`.
- **Audio file**: `POST /api/v1/jobs` (existing upload flow) with the same
  `podcast` block.

`language`/`format`/`length` are validated (zod) against
`notebooklm-py`'s `AudioLanguage`/`AudioFormat`/`AudioLength` enums
(Deep Dive = the default format) and passed through to the worker unchanged.

## 6. Verification level

- **UNIT-VERIFIED**: worker protocol ops (fake audio worker), provider adapter
  binding + error mapping, retry/backoff, state machine, validation (sniff +
  WAV parse), transcode adapter (fake ffmpeg).
- **INTEGRATION-VERIFIED**: full pipeline with MockProvider — 11 lifecycle
  scenarios + 19 fault-injection/recovery scenarios
  (`docs/testing/RECOVERY_TEST_MATRIX.md`).
- **MOCK_PROVIDER_INTEGRATION_VERIFIED**: local E2E
  (`apps/server/scripts/nlo-e2e.ts --scenario text-to-podcast`) — the mock
  verdict is capped below `PASS` by contract.
- **LIVE-VERIFIED**: not yet — requires a real Google session, egress and
  cost; see `docs/testing/AUDIO_LIVE_ACCEPTANCE.md` (the manual gate).
