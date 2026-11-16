# E2E Test Strategy (NLO-P1)

Four levels, never mixed in reporting: **Unit → Integration → E2E (mock provider) → Live**.

## 1. Levels and what each proves

| Level       | Command                                                                                                          | Proves                                                           | Does NOT prove     |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| Unit        | `npx vitest run packages/shared/test/e2e-contract.test.ts`                                                       | classification, stage transitions, artifact rules, verdict logic | HTTP behaviour     |
| Integration | `npm test` (workspaces)                                                                                          | API ↔ repo ↔ queue ↔ worker wiring                               | real NotebookLM    |
| E2E (mock)  | `npm run e2e -w @nlo/server -- --scenario monitor --job-id <id>` against a local instance with the mock provider | the runner observes a real job lifecycle                         | provider execution |
| Live        | same runner, `--base https://<host>`                                                                             | real provider output                                             | —                  |

## 2. Unit coverage (implemented, 21 tests)

`createTestRun` validation/shape · stage start/complete durations from injected timestamps ·
`classifyFailure` matrix (401/403 → auth, 408/504 → timeout, 4xx → invalid input, auth/proxy/
connectivity/provider/rate_limit/ambiguous classes, stall threshold, `NEEDS_ATTENTION`) ·
`recordError` stage mutation · `validateArtifact` (zero size, bad MIME, non-2xx download, digest
mismatch, non-digest, min-bytes) · `evaluateAcceptance` (PASS only for real provenance, mock → FAIL,
pending → NOT_TESTED, `NEEDS_ATTENTION` → BLOCKED) · status-history dedupe · terminal-status helper ·
scenario stage uniqueness.

## 3. Live policy

- Live runs require a running NLO instance **plus** a valid Google account/session and a working
  proxy. If any is missing, the run is reported `BLOCKED`/`NOT_TESTED` — a mock result is never
  reported as live.
- At most **one** controlled text run and **one** small audio run per acceptance window.
- No automatic retries of ambiguous jobs; `requeue` is only driven by the documented API and only
  after the job is proven non-ambiguous (see `docs/operations/JOB_RECOVERY_RUNBOOK.md`).

## 4. Negative-path matrix

| Condition                | Observed as                     | Runner verdict                        |
| ------------------------ | ------------------------------- | ------------------------------------- |
| bad/expired token        | HTTP 401/403                    | `E2E_AUTH`, FAIL                      |
| proxy tunnel down        | `errorClass=proxy`              | `E2E_PROXY`, FAIL (retryable=true)    |
| worker crash             | `errorClass=connectivity`       | `E2E_WORKER`, FAIL (retryable=true)   |
| provider error           | `errorClass=provider`           | `E2E_PROVIDER`, FAIL (retryable=true) |
| stuck job                | no status change > `--stall-ms` | `E2E_JOB_STUCK`, BLOCKED              |
| needs human              | status `NEEDS_ATTENTION`        | BLOCKED (never auto-retried)          |
| empty/invalid upload     | HTTP 4xx                        | `E2E_INPUT_INVALID`, FAIL             |
| artifact 404 / zero size | download/validation             | `E2E_ARTIFACT_INVALID`, FAIL          |

Full scenario definitions: [`E2E_SCENARIOS.md`](E2E_SCENARIOS.md). Four-path matrix:
[`ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md).

## 5. Provider conformance (NLO-P4-1D) — C1–C6 in CI, C7 manual

Provider conformance (contract in
[`../architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md)
§4) is a separate, always-on level: a provider may be reported `active` only
while C1–C6 are green for it.

| Suite          | Proves                                                                                                      | Runs                               |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| C1 declaration | descriptor lint vs `providerDescriptorSchema` (unknown op → error; stale `verifiedAt` >90d → warning)       | CI (mock)                          |
| C2 honesty     | one test per declared operation + an undeclared-operation probe                                             | CI (mock)                          |
| C3 lifecycle   | externalId persisted before first poll; cancel settles exactly once                                         | CI (mock)                          |
| C4 failure     | auth/rate_limit/transient/ambiguous map to the documented classes; ambiguous is never auto-retried          | CI (mock)                          |
| C5 concurrency | `maxConcurrent` honored: no aliasing, no wedge under 3 simultaneous jobs                                    | CI (mock)                          |
| C6 egress      | all provider traffic goes through the approved tunnel; tunnel death mid-job → `proxy` failure (fail-closed) | CI (mock)                          |
| C7 live        | the same flows against real NotebookLM over real egress                                                     | **manual gate only — never in CI** |

Runner: `npx tsx apps/server/test/conformance/runner.ts` — prints the
provider × C1–C6 table and exits non-zero unless all six are PASS. The
`conformance` CI job runs it in both pipelines (GitHub Actions + internal
GitLab mirror). C1–C6 green is **mock-level** evidence only — it does not
prove live execution (see §1 and the honesty rule in `CHANGELOG.md`).

The same CI carries a `secret-scan` job: a git-grep gate over tracked files
(private keys, cloud/API key shapes, `NLO_*` env secrets, sha256-length hex
in TS/JS, `vless://<uuid>@` URIs) with a documented allowlist and a
planted-fixture self-test that proves the gate detects secrets.
