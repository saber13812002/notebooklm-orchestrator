# PHASE NLO-P2 — Blockers & Open Items

Each blocker states what is blocked, why, and what exactly is needed to
unblock it. Nothing below was worked around in a way that hides it.

## B1 — Live acceptance (Gate E): BLOCKED

**What is blocked**: claiming `LIVE-VERIFIED` for real NotebookLM audio
(text → podcast → real file → real ffprobe evidence).

**Why**: the development machine has (1) no Google session for a NotebookLM
account, (2) no verified proxy/egress route (provider egress is fail-closed),
(3) no FFmpeg installed. Per the mission, live tests are a manual gate and
were never to be substituted by mock tests.

**Needed to unblock** (each needs a decision/approval from the user — mission
§22): a verified Google account session, an approved verified proxy route,
and (for MP3 claims) FFmpeg on the run host. Then execute
`docs/testing/AUDIO_LIVE_ACCEPTANCE.md` and record the result.

## B2 — FFmpeg live transcode: NOT TESTED (not a code blocker)

The transcode path is unit-verified (argv, timeouts, failure handling), but
no real ffmpeg binary was ever spawned in CI or on this machine. The pipeline
degrades honestly (`transcode.status:"not_configured"`, WAV stays canonical),
so this does not block the audio pipeline itself — only the MP3 claim.

**Needed**: `NLO_FFMPEG_BIN` on a host with ffmpeg; one live job to record
`podcast_transcode_stored` + ffprobe of the MP3.

## B3 — Three runner limits are not environment variables

`podcastDeadlineMs` (default 25 min), `maxPodcastBytes` (default 200 MiB),
`transcodeTimeoutMs` (default 5 min) are constructor dependencies of the job
runner, wired with their defaults in `app-context.ts` and with tuned values
in tests. There are no `NLO_PODCAST_DEADLINE_MS` / `NLO_PODCAST_MAX_BYTES` /
`NLO_TRANSCODE_TIMEOUT_MS` env vars (and none should be claimed in docs).

**Impact**: an operator cannot tune them via the service environment today.
**Fix is small**: parse the three vars in `config.ts`, wire them in
`app-context.ts`, add a config unit test, document in `.env.example`.

## B4 — Webhook environment vars missing from `.env.example`

The dispatcher reads `NLO_WEBHOOK_ALLOWLIST`, `NLO_WEBHOOK_ALLOW_LOOPBACK`,
`NLO_WEBHOOK_MAX_ATTEMPTS`, `NLO_WEBHOOK_INTERVAL_MS`,
`NLO_WEBHOOK_REQUEST_TIMEOUT_MS` (defaults: empty allowlist, loopback off, 8
attempts, 5000 ms, 10000 ms), but `.env.example` does not list them, so an
operator has no visible place to configure webhook egress. Closing in the
documentation pass (Todo 16).

## B5 — OpenAPI surface (resolved in this mission)

The webhook routes and the artifact download route
(`/artifacts/{artifactId}/download`) are documented in
`apps/server/src/api/openapi/spec.ts` and covered by the bidirectional
spec↔live-route drift test (`openapi-v1.test.ts`, part of the 286/286 green
suite). No known OpenAPI gaps remain for NLO-P2; the webhook payload's
correlation id (see B6) is a later-phase item.

## B6 — Correlation IDs / idempotency hardening: planned, not implemented

Webhook deliveries include `x-nlo-delivery-id` (unique per delivery) but jobs
do not yet carry a correlation id usable by third parties end to end, and
creation idempotency remains the existing token-scoped `idempotencyKey`.
Target for a later phase; documented in the OpenAPI/API docs as target state.

## B7 — Production host

The legacy host s52 (`172.20.1.52`) is decommissioned; re-deployment on
`172.30.0.133` is pending (endpoint-migration addendum, Phase G). No
production change was made in this mission; deploy only after the user
approves the push.

## B8 — Pre-existing format debt

7 files fail `format:check` for reasons predating this mission (see
`PHASE_NLO_P2_TEST_RESULTS.md` Gate A). They are outside this mission's
change set; optionally fixed with `prettier --write` during commit prep if
approved.

## Status labels in use (per mission §21)

| Capability                  | Label                                           |
| --------------------------- | ----------------------------------------------- |
| Worker audio ops            | UNIT-VERIFIED                                   |
| TS provider audio ops       | INTEGRATION-VERIFIED                            |
| Job engine audio lifecycle  | INTEGRATION-VERIFIED                            |
| Artifact validation/storage | INTEGRATION-VERIFIED                            |
| FFmpeg transcode            | CODE-VERIFIED + UNIT-VERIFIED (live NOT TESTED) |
| Download API                | INTEGRATION-VERIFIED                            |
| Webhooks                    | INTEGRATION-VERIFIED                            |
| E2E `text-to-podcast`       | MOCK_PROVIDER_INTEGRATION_VERIFIED              |
| Fault matrix FI-01…FI-19    | INTEGRATION-VERIFIED                            |
| Real NotebookLM audio       | BLOCKED (B1)                                    |
| Live MP3 transcode          | BLOCKED (B2)                                    |
