# Audio Pipeline Runbook (text → real podcast)

Scope: operating the real NotebookLM audio pipeline end to end, through the
API only. No direct DB surgery. Related docs:
`docs/architecture/AUDIO_PIPELINE_ARCHITECTURE.md`,
`docs/testing/AUDIO_LIVE_ACCEPTANCE.md` (manual Gate E procedure).

## 1. Preconditions (all must hold before a live run)

1. Google account verified and session healthy
   (`GET /api/accounts` — `lastVerifiedAt` recent; re-auth needs approval).
2. A verified proxy route available (fail-closed egress: without a verified
   proxy, audio jobs fail with `errorClass=proxy` — this is expected).
3. Python worker up (supervisor; `data/venv` with `notebooklm-py` installed).
4. (Optional) FFmpeg configured for MP3 output — see `FFMPEG_RUNBOOK.md`.
5. DB + env backed up before any configuration change.

## 2. Create a text-to-podcast job

```bash
curl -s -X POST "$NLO_API_BASE/api/v1/jobs" \
  -H "Authorization: Bearer $NLO_API_TOKEN" -H "content-type: application/json" \
  -d '{"title":"demo","text":"…input text…","language":"en","kind":"podcast"}'
```

- `kind` `podcast` selects the audio lifecycle; `language` `en` or `fa`.
- The response carries the job id (`j_<hex32>`); the job is async.

## 3. Monitor (expected stage + event sequence)

```bash
curl -s "$NLO_API_BASE/api/v1/jobs/$ID"                 # status/progress/result
curl -s "$NLO_API_BASE/api/v1/jobs/$ID/events"          # event log
curl -s "$NLO_API_BASE/api/v1/jobs/$ID/stages"          # stage rows
curl -s "$NLO_API_BASE/api/v1/jobs/$ID/attempts"        # retry history
curl -s "$NLO_API_BASE/api/v1/jobs/$ID/artifacts"       # produced files
```

Healthy sequence (stage in parentheses):

| Event (archive)             | Stage               | Meaning                                           |
| --------------------------- | ------------------- | ------------------------------------------------- |
| `podcast_submitted`         | `audio_generation`  | external task id recorded **before** polling      |
| `podcast_completed`         | `audio_generation`  | provider reported completion                      |
| (download completes)        | `artifact_download` | temp file `podcast-tmp-<hex12>` inside job output |
| (validate + store)          | `artifact_store`    | signature checked, renamed, sha256 + metadata row |
| `podcast_transcode_stored`  | `mp3_transcode`     | MP3 artifact stored (only when ffmpeg configured) |
| `podcast_transcode_skipped` | (no stage)          | ffmpeg not configured — WAV stays canonical       |

## 4. Failure triage

| Observation                                     | Meaning                          | Allowed action                                                                 |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `errorClass=proxy`, `FAILED proxy`              | no verified egress route         | fix/verify proxy node; let the built-in retry run — no blind requeue           |
| `errorClass=auth`                               | Google session expired           | re-verify the account (approval needed); then requeue once                     |
| `NEEDS_ATTENTION` ambiguous (polling budget)    | external task may still complete | **BLOCKED** — reconcile via the preserved external task id; never auto-requeue |
| `FAILED` non-ambiguous, attempts exhausted      | terminal failure                 | `POST /api/v1/jobs/{id}/requeue` (one at a time)                               |
| `SUCCEEDED` but artifact 0-byte/missing         | storage problem                  | investigate output dir + artifact row before requeue                           |
| `podcast_transcode_failed` with job `SUCCEEDED` | ffmpeg failure (non-fatal)       | see `FFMPEG_RUNBOOK.md` §5; original WAV still downloadable                    |

## 5. Restart and resume (operator facts)

- On server restart, in-flight audio jobs are recovered to `QUEUED`
  (`jobs.recoverInFlight()`, event `restart_recover`) and re-run.
- The runner **resumes** the external generation instead of resubmitting:
  the preserved task id is re-polled (event `podcast_resume_kept`).
  Resubmission happens only if the prior external state is proven failed.
- A restart observed during polling records `podcast_yielded`
  ("this instance stands down") and yields to the recovering instance.

## 6. Cancellation

- `POST /api/v1/jobs/{id}/cancel` → `CANCEL_REQUESTED` → `CANCELLED`.
- If the abort lands mid-poll, the recorded error is either
  "cancelled while polling podcast generation" (runner poll-loop guard) or
  "cancelled before start" (provider preflight) — both are the same
  legitimate terminal outcome (see `docs/testing/RECOVERY_TEST_MATRIX.md`
  FI-16). The external task id is preserved on the job.

## 7. Evidence to record per live run

job id, task id, stage rows (with external operation id), artifact id +
sha256 + size, ffprobe output, transcode status, operator, UTC timestamp.
Never record tokens, cookies, or the full user text.
