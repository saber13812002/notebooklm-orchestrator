# Fault-Injection / Recovery Test Matrix (NLO-P2, mission §14)

**Status:** 19 scenarios, all **INTEGRATION-VERIFIED** (mock provider at the boundary; real runner, queue, repos, state machine, egress stub, fake ffmpeg) · executed in `apps/server/test/podcast-fault-recovery.test.ts` (19/19 green) · **LIVE NOT TESTED**.

Requirement: ≥15 fault-injection/recovery scenarios with **recorded states**.
Method: one fault is injected at one boundary (provider scenario, external
task state, downloaded bytes, proxy availability, process restart, user
cancel, provider capability, transcode executable). The **resulting state is
recorded and asserted**: terminal status, error class/message, attempt
ledger (outcomes + detail), per-stage rows (state, last error, external
operation id, attempt), egress calls, artifact presence, event timeline,
temp-file hygiene, and account status.

## 1. Matrix

| ID    | Injected fault (boundary)                     | Recorded terminal state                   | Recovery behavior recorded                                                                                                                                                                                                                                                                                                                                      |
| ----- | --------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FI-01 | base auth failure (provider scenario `auth`)  | `FAILED`, errorClass `auth`               | no egress at all; attempt ledger `["failed"]` detail `failureClass: auth`; account → `AUTH_REQUIRED`; 0 stage rows                                                                                                                                                                                                                                              |
| FI-02 | base rate limit (scenario `rate_limit`)       | `FAILED`, errorClass `rate_limit`         | bounded retry: ledger `["retrying","retrying","failed"]` with `nextDelayMs: 0` (deterministic `rng`); no egress; 0 stages                                                                                                                                                                                                                                       |
| FI-03 | base transient error (scenario `transient`)   | `FAILED`, errorClass `provider`           | same bounded retry shape as FI-02; no egress; 0 stages                                                                                                                                                                                                                                                                                                          |
| FI-04 | no proxy route (fail-closed selection)        | `FAILED`, errorClass `proxy`              | **no attempt row recorded** (failure precedes the attempt); event `proxy_unavailable`; no egress; 0 stages                                                                                                                                                                                                                                                      |
| FI-05 | auth failure at `generateAudio`               | `FAILED`, errorClass `auth`               | base artifacts kept (1); audio stage row `failed` (lastError = the auth message, attempt 1); no generate egress; 0 podcast artifacts; temp dir clean                                                                                                                                                                                                            |
| FI-06 | transient failure at `generateAudio`, then ok | `SUCCEEDED` (recovered)                   | ledger `["retrying","ok"]`; exactly 1 generate egress on the 2nd attempt; 2 `audio_generation` rows (failed attempt 1 → completed attempt 2, external task id on the second); podcast artifact stored                                                                                                                                                           |
| FI-07 | ambiguous failure at `generateAudio`          | `NEEDS_ATTENTION`, errorClass `ambiguous` | **no auto-retry** (ambiguous completion is human-decidable); ledger `["ambiguous"]`; stage row failed; no generate egress; base artifacts kept                                                                                                                                                                                                                  |
| FI-08 | external task proven `failed` server-side     | `SUCCEEDED` after audited resubmission    | resubmission records `priorStatus: "failed"`, `resumed: false`, new task id; 2 generate egresses; final artifact stored                                                                                                                                                                                                                                         |
| FI-09 | external task `not_found` during polling      | `NEEDS_ATTENTION`, errorClass `ambiguous` | polling budget (200 ms) exhausted → ambiguous (task may complete server-side); `audioTaskId` preserved in `operationIds` **and** the stage row's `external_operation_id`                                                                                                                                                                                        |
| FI-10 | external task stuck `in_progress`             | `NEEDS_ATTENTION`, errorClass `ambiguous` | same recorded state as FI-09 (budget, not liveness, decides)                                                                                                                                                                                                                                                                                                    |
| FI-11 | 0-byte download after confirmed completion    | `FAILED`, errorClass `invalid_input`      | download stage row `completed` (bytes arrived), **no** `artifact_store` row, temp file removed; base artifacts kept                                                                                                                                                                                                                                             |
| FI-12 | oversize download (size-limit gate)           | `FAILED`, errorClass `invalid_input`      | same shape as FI-11; error message carries the exact sizes (`4096 > 1024` with a 1 KiB limit)                                                                                                                                                                                                                                                                   |
| FI-13 | download `ready: false` after completion      | `NEEDS_ATTENTION`, errorClass `ambiguous` | download stage row `failed` (not ready); temp file removed; no store row; ambiguity = external artifact may still materialize                                                                                                                                                                                                                                   |
| FI-14 | unrecognized audio signature (plain text)     | `FAILED`, errorClass `invalid_input`      | `artifact_download` completed, `artifact_store` **stage row exists and is failed** (signature check runs inside storage); temp file removed                                                                                                                                                                                                                     |
| FI-15 | process restart mid-poll                      | first run yields; second run `SUCCEEDED`  | boot recovery → `QUEUED` + event `restart_recover`; open stage rows settled `failed "interrupted by restart"` **with the external id preserved**; resume path: event `podcast_resume_kept`, `resumed: true`, `priorStatus: "in_progress"`, **no** second generate egress, `operationIds.audioTaskId` unchanged; only the resumed attempt is recorded (`["ok"]`) |
| FI-16 | user cancel mid-poll                          | `CANCELLED`, errorClass `provider`        | message `cancelled by user`; ledger `["cancelled"]`; stage row `failed` (abort observed at the poll guard or the provider preflight — both recorded outcomes); **external task id preserved** for reconciliation; no podcast artifact                                                                                                                           |
| FI-17 | provider without audio ops                    | `FAILED`, errorClass `invalid_input`      | capability check precedes any stage row (0 rows) and any generate egress; base artifacts kept                                                                                                                                                                                                                                                                   |
| FI-18 | base job without a `notebookId`               | `FAILED`, errorClass `invalid_input`      | podcast pipeline never starts (no stage rows, no generate egress); audio needs an existing notebook                                                                                                                                                                                                                                                             |
| FI-19 | FFmpeg encode failure (`FAKE_FFMPEG_FAIL=1`)  | `SUCCEEDED` with the original WAV         | `mp3_transcode` stage `failed` (reason `ffmpeg_failed: exit=1 … :: fake ffmpeg: simulated encode failure`); **no** mp3 artifact row; honest `podcast.transcode` report `{status:"failed", …}`; event `podcast_transcode_failed`                                                                                                                                 |

## 2. How the faults are injected (deterministic)

- **Provider-scenario faults (FI-01…FI-03, FI-08):** `MockProvider.setScenario`
  — checked before any egress, so `paths toEqual([])` _proves_ the provider
  boundary was never reached. FI-08 uses the mock's external task state
  machine (`setAudioTaskState`).
- **Stage-boundary faults (FI-05…FI-07):** direct `generateAudio` override
  throwing a structured `ProviderFailure` (auth / transient / ambiguous).
  FI-06 wraps the real mock with a call counter: fail once, then delegate —
  asserting exactly one generate egress.
- **Polling faults (FI-09, FI-10, FI-15, FI-16):** `audioAutoComplete=false`
  - `setAudioTaskState`; the test observes the persisted `audioTaskId` before
    mutating state. FI-16 cancels while the job is `RUNNING` at progress 95.
- **Download-byte faults (FI-11…FI-14):** `downloadAudio` override that
  writes exact fixture bytes to the temp path (empty / 4096-byte RIFF /
  ready:false / plain text).
- **Restart (FI-15):** the real boot path — `jobs.recoverInFlight()` (wired at
  boot in `app-context.ts`) + `stages.recoverOpen()`, then a **new** runner
  instance re-takes the job.
- **Transcode (FI-19):** a fake ffmpeg executable (`makeFakeFfmpeg`, copied
  from the green transcode suite) that honors `FAKE_FFMPEG_FAIL`.

## 3. Determinism notes

- Runners use a **real** timer sleep (so the poll loop yields to the event
  loop and test observers can interleave) with `rng: () => 0`:
  `backoffMs(n, {rng: () => 0})` is always **0 ms**, so retryable faults burn
  their 3 attempts instantly and deadline scenarios use a short real budget
  (200 ms).
- The mock base-sample name is per-call random → a base re-run on retry
  creates a new base artifact row; podcast assertions therefore filter on
  `podcast-*` names and count generate egresses explicitly.
- FI-16 asserts both possible recorded abort messages
  (`cancelled while polling podcast generation` | `cancelled before start`)
  because the abort can be observed at either the runner's poll guard or the
  mock's audio preflight — same terminal outcome, both honest.

## 4. Verification level

`INTEGRATION-VERIFIED` (mock provider at the boundary only). These scenarios
exercise real application code end-to-end (queue, state machine, repos,
egress stub, recovery wiring) but do **not** prove real NotebookLM execution
— that is the live gate (`docs/testing/AUDIO_LIVE_ACCEPTANCE.md`).
