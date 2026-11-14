# Audio Pipeline — Live Acceptance (Gate E)

**Status:** **BLOCKED** (not yet executed). No production changes, no Google
session, no egress and no cost without explicit approval (mission §22).

This is the **manual gate only — it never runs in CI** (real Google accounts,
real egress, real cost). Everything below is reproducible step-by-step; the
verdict must be written to `docs/reports/` with the raw evidence.

## 1. Preconditions (all must hold before the run)

1. Service `nlo` active and ready: `systemctl status nlo`,
   `GET /api/health`, `GET /api/health/ready`.
2. A **verified** Google session for at least one account
   (`GET /api/accounts` → status `ACTIVE`, lastVerifiedAt recent).
3. A **verified** proxy route: `GET /api/proxies` → node healthy
   (egress checker ok). Fail-closed egress means a podcast job with no
   healthy proxy FAILs — that is correct behavior, not a defect.
4. FFmpeg available (`ffmpeg -version`) — otherwise the job succeeds with
   WAV only and the acceptance must record `transcode: not_configured`.
5. DB + `.env` backup taken (deploy script does this on every deploy;
   manual steps require an equivalent backup first).

## 2. The run

```bash
# 1) Create a text-to-podcast job (real notebook, real audio generation)
curl -s -X POST "$BASE/api/v1/notebooks/from-text" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Live acceptance","text":"A short, factual brief about the history of the printing press.","language":"en","podcast":{"enabled":true,"format":"deep_dive","language":"en"}}'

# 2) Track to terminal (expect minutes: real generation + download)
curl -s "$BASE/api/v1/jobs/$JOB_ID"            # poll status
curl -s "$BASE/api/v1/jobs/$JOB_ID/events"     # podcast_submitted / podcast_completed / ...
curl -s "$BASE/api/v1/jobs/$JOB_ID/attempts"   # exactly one "ok" attempt
curl -s "$BASE/api/v1/jobs/$JOB_ID/stages"     # audio_generation → artifact_store all completed

# 3) Fetch artifacts
curl -s "$BASE/api/v1/jobs/$JOB_ID/artifacts"  # podcast-*.wav (and .mp3 if ffmpeg present)

# 4) Download and verify the bytes
curl -s -D - -o /tmp/live-podcast.wav "$BASE/api/v1/artifacts/$ART_ID/download"
file /tmp/live-podcast.wav                 # RIFF ... WAVE (or MP3 if transcoded)
sha256sum /tmp/live-podcast.wav            # must equal the artifact row sha256
ffprobe -v error -show_format /tmp/live-podcast.wav   # real duration > 0
```

## 3. Acceptance criteria (ALL must hold for `LIVE-VERIFIED`)

- [ ] Job `SUCCEEDED`, `resultProvenance: "real"` (never `mock`).
- [ ] `GET /jobs/:id/artifacts` lists a `podcast-*.wav` with
      `provenance: "real"`, a real `sha256`, and WAV metadata
      (`duration_seconds > 0`, `sample_rate`, `channels`) — or, when ffmpeg
      is configured, a `podcast-*.mp3` (56 kbps) linked via
      `source_artifact_id`.
- [ ] `download` returns bytes whose SHA-256 equals the row's `sha256`;
      `ffprobe` reports a non-trivial duration (seconds, not zero).
- [ ] Attempt ledger: exactly one `ok` attempt (or documented, bounded
      retries before the `ok`); stage rows: every stage `completed` with the
      external task id preserved on `audio_generation`.
- [ ] The audio is **audible and coherent**: listen to at least the first
      60 s; two speakers; content matches the prompt (a human signs off).
- [ ] Events include `podcast_submitted` and `podcast_completed` with the
      external task id; no `podcast_yielded` (a yield means the poll
      deadline — runner default 25 min — was too short for real
      generation time; raise the runner's `podcastDeadlineMs` and re-run).
- [ ] Webhook (if an endpoint is configured): a `job.succeeded` delivery
      reached the receiver with a valid `x-nlo-signature`.
- [ ] No secrets in logs (spot-check the journal lines for the job).

## 4. Failure triage (record, don't guess)

| Symptom                                               | First checks                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAILED proxy` "no approved proxy route available"    | proxy node health, egress checker; fail-closed is expected without a node                                                                    |
| `NEEDS_ATTENTION` ambiguous "polling budget"          | runner `podcastDeadlineMs` (default 25 min) vs. real generation time; external task may still complete — reconcile via the preserved task id |
| `FAILED auth`                                         | session expired? `lastVerifiedAt`; re-verify the Google session (needs approval)                                                             |
| `FAILED invalid_input` "unrecognized audio signature" | provider may have returned a non-audio artifact; inspect the temp path + provider logs                                                       |
| Transcode `not_configured`                            | `NLO_FFMPEG_BIN` missing → job is still correct with WAV only                                                                                |

## 5. Recording the verdict

Write `docs/reports/LIVE_AUDIO_ACCEPTANCE_<date>.md` containing: job id,
task id, attempt/stage/event evidence (raw JSON), artifact sha256 match,
ffprobe output, the human sign-off (name, date), and the verdict
`LIVE-VERIFIED` or `NOT TESTED (reason)`. Until this exists, the honest
status for the audio pipeline is `MOCK_PROVIDER_INTEGRATION_VERIFIED` +
`IMPLEMENTED` — **never** `FULLY_PRODUCTION_VERIFIED`.
