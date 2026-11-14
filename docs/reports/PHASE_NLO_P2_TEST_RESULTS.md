# PHASE NLO-P2 — Test Results (Gates A–D)

All results below were executed in this mission on the development machine
(Windows, Node v24.14.0, no FFmpeg installed). Nothing here is a live test
against real NotebookLM.

## Gate A — Static

| Check                           | Command                | Result                                                                    |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Typecheck (shared, server, web) | `npm run typecheck`    | CLEAN                                                                     |
| Lint (root, all workspaces)     | `npm run lint`         | CLEAN                                                                     |
| Build                           | `npm run build`        | OK (vite, 1853 modules)                                                   |
| Format                          | `npm run format:check` | 7 FAILING files — **all pre-existing**, none in this mission's change set |

Pre-existing format failures (verified against `git status`):
`apps/server/src/api/routes/orchestrator.ts`,
`apps/server/test/orchestrator.test.ts`,
`docs/reports/RADIO_R0_INFRASTRUCTURE_DISCOVERY.md`,
`docs/reports/RADIO_R0_ROADMAP_STATUS_PROPOSAL.md`,
`docs/reports/RADIO_R1A_PREDEPLOY_READINESS.md`,
`docs/reports/RADIO_R1A_SECURITY.md`,
`docs/reports/RADIO_R1A3_NEO4J_SECURITY.md`.
All files touched or added by this mission (code + docs) are prettier-clean.

## Gate B — Unit

| Workspace         | Command                   | Result                      |
| ----------------- | ------------------------- | --------------------------- |
| `packages/shared` | `npm test -w @nlo/shared` | **110/110 pass** (11 files) |
| `apps/web`        | `npm test -w @nlo/web`    | **30/30 pass** (4 files)    |

New/extended unit suites: `e2e-contract.test.ts` (verdict ladder incl. the
mock cap), `ssrf.test.ts` (webhook URL gating), `transcode.test.ts` (argv
construction incl. kbps clamp 8..320, timeout, empty output, spawn error),
`test_nbl_worker_audio.py` (29/29, worker audio ops), `provider-audio.test.ts`
(30/30, TS adapter audio ops + error mapping + ambiguity).

## Gate C — Integration (REST API surface, job engine, repos, dispatcher)

`apps/server`: **286/286 pass** (24 files). New suites in this mission:

| Suite                            | Focus                                                        | Result         |
| -------------------------------- | ------------------------------------------------------------ | -------------- |
| `podcast-lifecycle.test.ts`      | full happy path, cancel mid-poll, resume-after-restart       | pass           |
| `podcast-fault-recovery.test.ts` | **FI-01…FI-19 fault-injection matrix**                       | **19/19 pass** |
| `artifact-storage.test.ts`       | validation gates, size gates, sha256, metadata, stages       | pass           |
| `artifact-download.test.ts`      | ownership, ETag, Content-Disposition, 404/403                | pass           |
| `webhooks.test.ts`               | outbox, settlement, backoff, dead-letter, signing, SSRF, API | pass           |
| `e2e-text-to-podcast.test.ts`    | in-process scenario incl. exit-code contract                 | pass           |

The 19-scenario matrix (`docs/testing/RECOVERY_TEST_MATRIX.md`) records, for
each injected fault: the terminal status, the recorded error class/message,
the stage rows, the event ledger, and the recovery behavior. Notable recorded
behaviors:

- retryable faults (auth/rate_limit/connectivity/proxy) burn 3 attempts with
  0 ms backoff (test `rng`) then `FAILED` with the correct `errorClass`;
- non-retryable faults (invalid_input) fail on the first attempt;
- ambiguous faults (poll deadline) → `NEEDS_ATTENTION`, external task id
  preserved, no auto-requeue;
- restart mid-poll → job recovered to `QUEUED`, generation **resumed** (task
  id re-polled, not resubmitted);
- cancel mid-poll → `CANCELLED`, error "cancelled while polling podcast
  generation" **or** "cancelled before start" (both legitimate detection
  points; FI-16 asserts both);
- transcode failure (fake ffmpeg) → job still `SUCCEEDED` with the WAV,
  honest `transcode.status:"failed"` + `podcast_transcode_failed` event (FI-19).

## Gate D — Local E2E (mock provider boundary)

`e2e-text-to-podcast.test.ts` (2/2):

1. **Positive**: full in-process run of `nlo-e2e --scenario text-to-podcast`
   against a local server with `MockProvider` → exit code **0**, report
   verdict **`MOCK_PROVIDER_INTEGRATION_VERIFIED`** (the contract's hard cap
   for mock provenance — a mock run can never yield `PASS`).
2. **Negative control**: same scenario against a fail-closed environment
   (no verified proxy route) → exit code **1**, job `FAILED proxy` — proves
   the scenario actually exercises egress gating.

Direct CLI (`tsx apps/server/scripts/nlo-e2e.ts --scenario text-to-podcast`)
exits 1 on the bare dev machine: expected, because the scenario requires the
local test environment the suite sets up (server + healthy proxy node).

## Gate E — Live readiness

**BLOCKED.** No Google session, no verified egress/proxy route, no FFmpeg on
the development machine. Procedure is documented in
`docs/testing/AUDIO_LIVE_ACCEPTANCE.md`; results must be recorded to
`docs/reports/LIVE_AUDIO_ACCEPTANCE_<date>.md` when run. Until then, every
audio claim in this repository is capped at
`MOCK_PROVIDER_INTEGRATION_VERIFIED` / `INTEGRATION-VERIFIED`.

## Honesty ledger (which level proved what)

| Level            | What it proves                                                              | What it does NOT prove             |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| Unit             | validation, argv, state machine, retry, redaction, contract logic           | real NotebookLM behavior           |
| Integration      | engine + storage + API + dispatcher correctness with a real worker protocol | real Google session / egress       |
| Local E2E (mock) | the whole pipeline's orchestration end to end, incl. exit-code contract     | real podcast bytes from NotebookLM |
| Live (Gate E)    | real audio, real egress, real ffprobe evidence                              | (not run yet — BLOCKED)            |

Known flake note: `worker-queue-recovery.test.ts` can fail on a loaded CI
machine (timer-sensitive); passes on re-run. Not caused by this mission's
changes (pre-existing suite), but recorded for transparency.
