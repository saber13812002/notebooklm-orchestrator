# Artifact Storage Runbook

Scope: on-disk artifact layout, the artifact registry, download API, and
maintenance. Related: `docs/architecture/ARTIFACT_DELIVERY_ARCHITECTURE.md`.

## 1. On-disk layout

Artifacts live under the git-ignored `data/` tree (must survive any
container recreate / checkout; never delete `data/`):

```text
data/jobs/<jobId>/
├── input/     # uploaded input files (e.g. input audio), server-safe names
└── output/
    ├── podcast-tmp-<hex12>.<ext>   # temp name during download (removed after store/reject)
    ├── podcast-<hex12>.<ext>       # canonical stored artifact (wav/mp3)
    └── podcast-<hex12>.mp3         # transcode derivative, when ffmpeg ran
```

Rules:

- All names are **server-generated** (no user path components); paths are
  resolved with `resolveWithin` (path-traversal safe).
- Temp files are removed on every rejection path (not ready, 0 bytes, oversize,
  invalid signature).

## 2. Size and integrity gates (enforced in the pipeline)

| Gate                           | Outcome                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| artifact 0 bytes               | `invalid_input` FAILED, "podcast artifact is empty (0 bytes)" |
| size > limit (default 200 MiB) | `invalid_input` FAILED, size limit message; temp removed      |
| unrecognized audio signature   | `invalid_input` FAILED, nothing stored                        |
| unparseable WAV header         | `invalid_input` FAILED, nothing stored                        |

Accepted signatures: `RIFF…WAVE` → `audio/wav`; ID3/`0xFF`-sync →
`audio/mpeg`; `ftyp` at offset 4 → `audio/mp4`. WAV metadata (duration, codec,
sample rate, channels) is parsed from the file itself.

## 3. Artifact registry (migration 0006)

`artifacts` row per stored file: id, job id, filename, media type, size,
sha256, and — audio only — `duration_seconds`, `codec`, `sample_rate`,
`channels`, `bitrate`, `source_artifact_id`, `provenance`.

- NULL audio columns mean "the producer did not report it" (honest, not
  fabricated).
- `provenance`: `real` (provider-produced) vs. `mock` (controlled mock
  boundary); the E2E contract caps mock results at
  `MOCK_PROVIDER_INTEGRATION_VERIFIED`.
- `stages` table (same migration): one row per pipeline stage with state,
  attempt, deadline, external operation id — the audit trail.

## 4. Download API

```bash
curl -s -D - -o file.bin "$NLO_API_BASE/api/v1/artifacts/<artifactId>/download" \
  -H "Authorization: Bearer $NLO_API_TOKEN"
```

- Available on both `/api` and `/api/v1`; requires auth and **ownership**:
  the caller may only download artifacts of jobs the token can see.
- `Content-Disposition` uses the stored filename; `Content-Type` the stored
  media type; `ETag` = the artifact sha256.
- Base (input) audio remains downloadable at `GET /api/jobs/:id/audio/download`.

## 5. Verification of a downloaded file

```bash
file out.bin                 # correct type (WAV/MP3/M4A)
sha256sum out.bin            # must equal the artifact row's sha256 (and the ETag)
ffprobe -v error -show_entries format=duration,bit_rate out.bin
```

## 6. Maintenance

- **Backups**: `deploy/deploy.sh` backs up DB + `.env` on every deploy; DB
  restore is from `data/backups/`. Artifact files are not in the DB backup —
  a host rebuild without `data/` loses artifacts.
- **Disk**: monitor `data/jobs/` usage; per-job output is bounded by the 200
  MiB gate plus the small MP3 derivative. Pruning old job dirs is an operator
  action — only after the jobs are terminal and no longer needed.
- **Never** hand-edit files in `output/` for a live job; the sha256 would no
  longer match the registry.

## 7. Verification level

Gates, signature sniffing, WAV parsing, ownership, and ETag behavior are
**UNIT/INTEGRATION-VERIFIED** (`artifact-storage.test.ts`,
`artifact-download.test.ts`). Live download of a real podcast: **NOT TESTED**
until Gate E runs on a host with egress.
