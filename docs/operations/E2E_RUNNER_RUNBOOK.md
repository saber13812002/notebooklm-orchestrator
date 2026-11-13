# E2E Runner Runbook (nlo-e2e)

## 1. Preconditions

| Item                    | How to satisfy                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Running NLO instance    | `npm run dev:server` (local) or the deployed host; verify `GET /api/v1/openapi.json` → 200   |
| API token               | create via the existing token flow; export **only** as env `NLO_API_TOKEN` (never a CLI arg) |
| Target base             | `NLO_API_BASE` (e.g. `http://127.0.0.1:4870`)                                                |
| For a real provider run | valid Google account/session **and** a working proxy; otherwise expect `BLOCKED`             |

## 2. Commands

```bash
# text
NLO_API_BASE=http://127.0.0.1:4870 NLO_API_TOKEN=… npm run e2e -w @nlo/server -- \
  --scenario text --text-file ./sample-fa.txt --min-bytes 1000 --expect-mime audio/

# audio
… --scenario audio --audio-file ./small.m4a --field file --min-bytes 1000 --expect-mime audio/

# monitor an existing job (read-only)
… --scenario monitor --job-id j_0123456789abcdef0123456789abcdef
```

Tuning: `--poll-ms` (default 3000) · `--timeout-ms` (default 20 min) · `--stall-ms` (default 6 min) ·
`--out <path>` (default `data/e2e/<run-id>.json`, mode 0600).

## 3. Exit codes

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | `acceptance: PASS` (SUCCEEDED + real provenance + valid artifact)                |
| 1    | `FAIL` (see `errors[].code`)                                                     |
| 2    | `BLOCKED` / `NOT_TESTED` (e.g. `NEEDS_ATTENTION`, timeout, missing precondition) |
| 3    | usage error (missing `--base`, `--text-file`, `--audio-file`, `--job-id`)        |

## 4. Reading the report

`data/e2e/<run-id>.json` contains `test_run_id`, `job_id`, `input.sha256`, `stages[]`
(state/duration/attempt/checkpoint/`external_operation_id`), `job_status_history[]`,
`attempts_observed`, `artifacts[]` (size/mime/digest/valid), `errors[]` (`E2E_*` code, stage, retryable),
`provenance` and `acceptance`. Secrets are never recorded.

## 5. Triage by code

| Code                    | First checks                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `E2E_AUTH`              | token validity/scope; 401/403 in the run log                     |
| `E2E_TIMEOUT`           | worker alive? queue depth? `--timeout-ms` too low?               |
| `E2E_JOB_STUCK`         | `job_status_history` last status; `--stall-ms`; provider silence |
| `E2E_PROXY`             | node health (`/api/v1/...` proxies), egress, tunnel              |
| `E2E_WORKER`            | worker supervisor state, python worker crash log                 |
| `E2E_PROVIDER`          | provider error class in job `errorMessage`                       |
| `E2E_INPUT_INVALID`     | size/type limits (`packages/shared/src/input-capabilities.ts`)   |
| `E2E_ARTIFACT_*`        | download status, MIME, digest expectation                        |
| `E2E_CONTRACT_MISMATCH` | `/api/v1/openapi.json` paths changed                             |

## 6. Safety

- The runner never writes to the DB directly and never calls domain services.
- It does not retry automatically; recovery is a manual, evidence-based decision — see
  [`JOB_RECOVERY_RUNBOOK.md`](JOB_RECOVERY_RUNBOOK.md).
- Run one live text and one small live audio per acceptance window (cost/rate control).
