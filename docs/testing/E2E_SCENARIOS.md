# E2E Scenarios (NLO-P1)

Stage lists are code-derived from `SCENARIO_STAGES` in `packages/shared/src/e2e-contract.ts`; the runner
creates exactly these stages, so a report can never invent a stage.

## Scenario A — Text to Notebook (`--scenario text`)

| #   | Step                                | Runner stage                         | Evidence                                           |
| --- | ----------------------------------- | ------------------------------------ | -------------------------------------------------- |
| 1   | read text file, compute sha256      | —                                    | `input.sha256`, `input.bytes`                      |
| 2   | `POST /api/v1/notebooks/from-text`  | `create_job`                         | HTTP status + `job_id`                             |
| 3   | poll `GET /api/v1/jobs/{id}`        | (status history)                     | `job_status_history[]`                             |
| 4   | notebook/source provenance          | `notebook_created`, `source_created` | `notebookId`, `sourceId`                           |
| 5   | read `events`, `attempts`, `result` | `events_timeline`, `attempts_read`   | counts, `attempts_observed`                        |
| 6   | verdict                             | `acceptance`                         | PASS only if `SUCCEEDED` + `resultProvenance=real` |

Command:
`NLO_API_BASE=http://127.0.0.1:4870 NLO_API_TOKEN=*** npx tsx apps/server/scripts/nlo-e2e.ts --scenario text --text-file ./sample-fa.txt`

## Scenario B — Audio Upload (`--scenario audio`)

Stages: `upload_file → validate_input → queue_wait → account_assigned → session_ok → proxy_ok →
worker_started → notebook_created → source_created → prompt_sent → generation → artifact_download →
artifact_validate → acceptance`.

- multipart field defaults to `file` (`--field` overrides) — the runner does not guess silently: if the
  API rejects the part name it fails with `E2E_INPUT_INVALID`.
- artifact must be downloadable (2xx), non-empty, `audio/*` (`--expect-mime audio/`), optional
  `--min-bytes`; digest is computed on the downloaded bytes.

## Scenario C — Failure & Recovery (`--scenario monitor --job-id …`)

Observes an existing job and classifies it without mutating state. Recovery is **not** automatic:
`NEEDS_ATTENTION`/ambiguous → `BLOCKED`; only a proven non-ambiguous failure may be requeued through
`POST /jobs/{id}/requeue` (see runbook).

## Scenario D — Artifact Acceptance (`--scenario monitor --job-id … --min-bytes N --expect-mime audio/`)

Checks: file exists · size · MIME · SHA-256 · download HTTP status · integrity · metadata · provenance.
A fabricated file cannot pass: size/MIME/digest expectations are enforced.

## Scenario E — Webhook Readiness (readiness audit, not a new publisher)

Required payload fields: `job_id,status,notebook_id,notebook_title,source_id,artifact_id,download_url,mime_type,size,sha256,completed_at`.
Audit status in the delivery report (`docs/reports/PHASE_NLO_P1_E2E_DELIVERY.md` §10). **No parallel
publishing system was built.**
