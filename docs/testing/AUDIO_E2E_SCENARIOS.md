# Audio (Podcast) E2E Scenarios (NLO-P2)

**Status:** `text-to-podcast` scenario **MOCK_PROVIDER_INTEGRATION_VERIFIED** (local test environment, exit 0) · live acceptance **BLOCKED** (see `AUDIO_LIVE_ACCEPTANCE.md`).

## 1. The scenario: `text-to-podcast`

`apps/server/scripts/nlo-e2e.ts --scenario text-to-podcast` runs the full
happy path as an external HTTP client:

1. `POST /api/v1/notebooks/from-text` — text body (fa/en),
   `podcast: { enabled: true, format: "deep_dive" }`;
2. poll `GET /api/v1/jobs/:id` (+ `/events`, `/attempts`) to a terminal
   status, tracking the scenario stages;
3. `GET /api/v1/jobs/:id/artifacts` — expect a podcast artifact
   (`podcast-*.wav` + optionally `podcast-*.mp3`);
4. `GET /api/v1/artifacts/:id/download` — bytes round-trip, `ETag` =
   `sha256` from the artifact row;
5. write a verdict report (JSON + human summary).

### Stage model

`SCENARIO_STAGES["text-to-podcast"]` in `packages/shared/src/e2e-contract.ts`:

```
create_job → validate_input → queue_wait → notebook_created →
source_created → podcast_generation → artifact_download →
artifact_validate → acceptance
```

The runner refuses to run if `/api/v1/openapi.json` lacks any required path
(`E2E_CONTRACT_MISMATCH`) — the OpenAPI document is the executable contract.

## 2. Verdicts (honesty rules)

`evaluateAcceptance` (pure, 24 unit tests) maps observed state to:

| Verdict                              | When                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `PASS`                               | job `SUCCEEDED`, all stages complete, artifact valid, **provenance `real`**               |
| `FAIL`                               | a stage failed, an error was reported, terminal `FAILED`/`CANCELLED`, or artifact invalid |
| `BLOCKED`                            | job terminal `NEEDS_ATTENTION` (ambiguous completion, human decision needed)              |
| `MOCK_PROVIDER_INTEGRATION_VERIFIED` | everything succeeded but provenance is `mock` — **never `PASS`**                          |
| `NOT_IMPLEMENTED`                    | a required capability is missing (capability matrix says unsupported)                     |
| `NOT_TESTED`                         | job not yet terminal, or a stage not yet reached                                          |

The mock cap is the key guarantee: a green mock pipeline can be _integrated_,
it can never be _production-verified_.

## 3. Local test environment (Gate D)

`apps/server/test/e2e-text-to-podcast.test.ts` (2 tests) drives the scenario
against a disposable in-process app — real HTTP, real queue, real runner,
**mock provider** at the boundary:

- **positive**: full pipeline → exit `0`, verdict
  `MOCK_PROVIDER_INTEGRATION_VERIFIED`;
- **negative control**: no healthy proxy node → fail-closed → exit `1`
  (verdict `FAIL`, never a mock-verified verdict).

This is the same command the operator runs manually:

```powershell
node node_modules/tsx/dist/cli.mjs apps/server/scripts/nlo-e2e.ts `
  --scenario text-to-podcast --base-url http://127.0.0.1:<port> `
  --token <token> --report-dir data/e2e-local
```

Exit codes: `0` PASS-or-MOCK-VERIFIED · `1` FAIL · `2` BLOCKED ·
`3` NOT_IMPLEMENTED/NOT_TESTED/contract mismatch.

## 4. What each level proves

| Level              | Scope                                                                          | Evidence                                        |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Unit               | worker protocol, provider binding, retry, state machine, validation, transcode | `npm test` (server + shared)                    |
| Integration        | pipeline with MockProvider: 11 lifecycle + 19 fault/recovery scenarios         | `test/podcast-*.test.ts`                        |
| Local E2E (Gate D) | full HTTP → queue → runner → mock provider → artifact → download               | `test/e2e-text-to-podcast.test.ts` + manual run |
| Live (Gate E)      | real Google session, real egress, real cost                                    | `AUDIO_LIVE_ACCEPTANCE.md` — **not yet run**    |

See also `MOCK_VS_LIVE_TESTING.md` for the boundary rules.
