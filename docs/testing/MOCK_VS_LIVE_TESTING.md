# Mock vs. Live Testing (NLO-P2)

**Status:** policy doc — enforced by the E2E contract
(`packages/shared/src/e2e-contract.ts`, 24 unit tests) and the test layout.

## 1. The one controlled-mock boundary

Exactly **one** mock is allowed in the whole system, and it lives at the
provider boundary:

```
┌────────────────────────────── real application code ──────────────────────────────┐
│  HTTP API → queue → job-runner (state machine, retries, stages, recovery)         │
│  → repos (sqlite) → proxy manager → egress (stubbed in tests)                     │
│  → artifact validation → storage → download API → webhooks outbox                 │
└──────────────────────────────────────────┬─────────────────────────────────────────┘
                                           │  Provider interface
                    ┌──────────────────────┴──────────────────────┐
                    ▼                                             ▼
          MockProvider (tests / local env)            PythonWorkerProvider (live)
          deterministic, offline                      real notebooklm-py 0.8.5
```

Rules:

- The mock is **never** imported by production code paths; it is selected by
  config (`provider: "mock"`), the same selection point a real provider uses.
- The mock is **deterministic and observable**: task ids derive from the job
  id, the task state machine is driven by `setAudioTaskState`/
  `audioAutoComplete`, failures are driven by `setScenario`, and the "file"
  it downloads is a real minimal WAV written to a server-controlled path.
- Everything **around** the boundary is real code: real queue, real state
  machine, real repos, real runner, real transcode (fake ffmpeg binary),
  real download route, real webhook outbox.
- A test that stubs anything _inside_ the boundary (e.g. the runner or the
  repos) is a unit test and must say so; it cannot claim integration coverage.

## 2. What each level proves (and cannot prove)

| Level                  | Proves                                                                                                                                          | Does NOT prove                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Unit**               | pure logic: state machine, retry/backoff, validation, redaction, SSRF, protocol parsing                                                         | anything about real I/O or real services                |
| **Integration** (mock) | the full pipeline wiring: job → stages → artifacts → download → webhooks, with correct recorded state on faults (see `RECOVERY_TEST_MATRIX.md`) | real NotebookLM behavior, real egress, real latency     |
| **Local E2E** (mock)   | the HTTP contract end-to-end; verdict cap `MOCK_PROVIDER_INTEGRATION_VERIFIED`                                                                  | same as above — a mock `PASS` is impossible by contract |
| **Live** (manual gate) | real NotebookLM generation, real bytes, real egress, real cost                                                                                  | only what the run actually exercised (record it)        |

## 3. The verdict ladder (enforced, not aspirational)

`evaluateAcceptance` maps observed state to a verdict; the ladder is strict:

```
PASS  >  MOCK_PROVIDER_INTEGRATION_VERIFIED  >  BLOCKED / NOT_IMPLEMENTED / NOT_TESTED / FAIL
```

- `PASS` **requires** `provenance === "real"` on the job result. The provenance
  comes from the provider's own report (`providerMeta.simulated` → `mock`,
  verified real provider → `real`), never from the test's optimism.
- A mock run that satisfies every other criterion is capped at
  `MOCK_PROVIDER_INTEGRATION_VERIFIED`.
- `NEEDS_ATTENTION` maps to `BLOCKED` (ambiguous completion is a human
  decision, not a failure).
- A failed stage, a reported error, or an invalid artifact maps to `FAIL`
  regardless of the terminal status.

**Reports must state honestly which level was verified** — `Unit/Integration/
E2E passed` vs `Live verified` vs `Not tested`. Do not invent test counts;
they are taken from the runner output.

## 4. CI vs. manual

- **CI** runs: lint, typecheck, unit + integration + local E2E (mock), build.
  Fast, offline, deterministic.
- **Never in CI:** the live scripts (`scripts/e2e-live.ts`,
  `scripts/verify-live.ts`, and the live gate in `AUDIO_LIVE_ACCEPTANCE.md`)
  — they need real Google accounts, real egress and cost, and a human to
  sign off (including listening to the audio).

## 5. Anti-patterns (rejected by design)

- ❌ A mock that also fakes the runner/queue/repo ("mock everything") —
  proves nothing about the wiring.
- ❌ A live test in CI (flaky, costly, needs credentials in CI).
- ❌ Reporting `PASS` for a mock run (the contract makes it impossible).
- ❌ A mock that _can_ reach the network (the mock provider is offline by
  construction; egress is stubbed at the boundary in tests).
- ❌ "It worked once live" without a recorded report (see
  `AUDIO_LIVE_ACCEPTANCE.md` §5).
