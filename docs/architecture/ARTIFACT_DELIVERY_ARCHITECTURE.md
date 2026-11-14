# Artifact Delivery Architecture (NLO-P2)

**Status:** implemented + unit/integration-tested (`apps/server/test/artifact-storage.test.ts` 18, `apps/server/test/artifact-download.test.ts`, transcode 9) · **LIVE NOT TESTED** (artifact bytes are mock-generated locally; see `docs/reports/PHASE_NLO_P2_TEST_RESULTS.md`).

## 1. Principle

Artifacts are **opaque, server-named files owned by a job**. The delivery
path is: provider writes bytes → pipeline **validates** (signature, size,
parseability) → a row is created with full metadata + `sha256` → the API
serves the bytes from that row only. A file that is never validated is never
stored, and a stored file is never re-served under a name the client chose.

## 2. Storage model

Files live under `<jobsDir>/<jobId>/output/` (already the base-job layout).
Podcast files get a server-generated safe name:

```
podcast-tmp-<hex12>        ← temp name while downloading (never exposed)
podcast-<hex12>.<ext>      ← final name after validation (ext from signature)
```

`resolveWithin` (shared) confines every path to the job output dir; user
input never contributes a path component. `audioMimeToExt` maps the detected
signature (wav → `.wav`, mpeg → `.mp3`, mp4 → `.m4a`, else `.bin`).

## 3. Artifact row (migration `0006`)

New nullable columns on `artifacts` — **NULL means "the producer did not
report it"**; the application never fabricates metadata:

| Column               | Set by                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `duration_seconds`   | WAV `data`/`fmt` chunk parse, or provider-reported duration             |
| `codec`              | WAV `fmt` codec id (e.g. `pcm`), `mp3` for transcodes                   |
| `sample_rate`        | WAV `fmt` chunk                                                         |
| `channels`           | WAV `fmt` chunk                                                         |
| `bitrate`            | target bitrate of an application-produced transcode (e.g. 56000)        |
| `source_artifact_id` | the artifact this one was derived from (MP3 → original WAV)             |
| `sha256`             | computed over the stored bytes at store time                            |
| `provenance`         | `mock` / `real` / `unknown` — **copied from the provider's own report** |

## 4. Validation gates (before storage)

`apps/server/src/domain/artifact-validate.ts` (pure, unit-tested):

1. **Signature sniff** — 16-byte header: `RIFF....WAVE` → `audio/wav`;
   `0xFF + (b1 & 0xE0) == 0xE0` or `ID3` → `audio/mpeg`; `ftyp` at offset 4
   → `audio/mp4`; anything else → rejected (`invalid_input`, nothing stored).
2. **Size gates** — 0 bytes rejected; size > the size limit (runner default
   200 MiB; configurable per runner instance, not yet an env var) rejected;
   in both cases the temp file is removed.
3. **WAV parse** — `readWavInfo` walks the chunk list; a missing or zero
   `fmt`/`data` chunk is rejected (`audio/wav` rows always carry real
   duration/codec/sample-rate/channels, never guesses).

The MP3 transcode output is validated by the same sniff before it is stored
(a corrupt encode is dropped, the original WAV remains the served artifact).

## 5. Download API

`GET /api/artifacts/:artifactId/download` and the v1 mirror
(`/api/v1/jobs/...`), both registered in `apps/server/src/api/routes/jobs.ts`:

- ownership: the artifact must exist **and** be served through the job's
  token scope (v1 routes map `jobs:download`);
- the response streams the stored file with `Content-Type` from the row and
  `Content-Disposition` from the **stored** filename (never the client's);
- `ETag` = the row's `sha256` (strong tag) so re-downloads are cacheable;
- base-job input-audio download stays at `GET /api/jobs/:id/audio/download`
  (attachment disposition), unchanged.

## 6. Provenance honesty

`resultProvenance` on the job and `provenance` on every artifact come from
the provider (`providerMeta.simulated` → `mock`; a verified real provider →
`real`; otherwise `unknown`). The E2E contract
(`packages/shared/src/e2e-contract.ts`) therefore caps a mock run at
`MOCK_PROVIDER_INTEGRATION_VERIFIED` — it can never be reported as `PASS`,
and a `PASS` verdict requires `provenance === "real"`.

## 7. Transcode (best-effort, honest)

`apps/server/src/media/transcode.ts` spawns the configured FFmpeg binary
(`NLO_FFMPEG_BIN`; transcoding is **disabled** — reason
`not_configured` — when unset; there is no default binary):

- `ffmpeg -y -hide_banner -loglevel error -i <wav> -vn -acodec libmp3lame
-b:a 56k -ar 44100 -ac 2 <tmp>.mp3` (`-b:a` from `NLO_MP3_TARGET_KBPS`,
  default 56, clamped 8..320);
- hard timeout (runner `transcodeTimeoutMs`, default 5 min), spawn-error
  capture, non-zero exit + last 400 chars of stderr, and a 0-byte-output
  check produce a structured reason (`ffmpeg_failed: exit=… :: …`,
  `ffmpeg_timeout`, `ffmpeg_spawn_failed: …`, `empty_output: …`);
- on success the MP3 row points at the WAV via `source_artifact_id`;
- on failure the **job still succeeds** with the original WAV and the
  failure is recorded in the `podcast.transcode` report block
  (`status: "failed" | "ok" | "not_configured"`, `reason`, `exitCode`) and
  the `podcast_transcode_failed` event. Never a silent skip, never a
  fabricated MP3.

## 8. Verification level

- **UNIT-VERIFIED**: sniff/parse (pure), transcode adapter (fake ffmpeg).
- **INTEGRATION-VERIFIED**: storage hardening + download API (in-process,
  mock provider).
- **LIVE-VERIFIED**: not yet — real bytes require the live gate
  (`docs/testing/AUDIO_LIVE_ACCEPTANCE.md`).
