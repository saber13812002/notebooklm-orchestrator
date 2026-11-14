# FFmpeg (MP3 Transcode) Runbook

Scope: operating the optional MP3 (56 kbps) transcoding stage of the podcast
pipeline. NLO **never installs ffmpeg itself** — the operator provides the
binary; if absent, the pipeline still succeeds with the original WAV.

Status: transcode command construction, result contract, and failure handling
are **UNIT-VERIFIED** (`apps/server/test/transcode.test.ts`). Live transcoding
is **NOT TESTED** on the development machine (no ffmpeg installed).

## 1. Configuration

| Variable              | Meaning                                                                                                   | Default |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `NLO_FFMPEG_BIN`      | Absolute path to the ffmpeg executable. **Unset → transcoding disabled** (there is no implicit `ffmpeg`). | unset   |
| `NLO_MP3_TARGET_KBPS` | CBR bitrate for the MP3, clamped to 8..320.                                                               | `56`    |

The transcode timeout is **not** an environment variable: it is a runner
dependency (`transcodeTimeoutMs`, default 5 minutes), currently wired with its
default in `apps/server/src/app-context.ts`.

## 2. Exact command

Built by `buildFfmpegArgs` in `apps/server/src/media/transcode.ts` (pure,
unit-tested):

```text
ffmpeg -y -hide_banner -loglevel error -i <input.wav> -vn -acodec libmp3lame \
  -b:a 56k -ar 44100 -ac 2 <output.mp3>
```

- `-b:a` follows `NLO_MP3_TARGET_KBPS` (clamped 8..320, default 56).
- `-vn` strips any stray video stream; profile is 44.1 kHz stereo CBR.
- Windows: a `.bat`/`.cmd` launcher is spawned via `cmd.exe` (`shell: true`);
  a real executable (`ffmpeg.exe`, ELF) is always spawned directly.

## 3. Result semantics (all honest, all recorded)

| Outcome                                  | Stage row | Job event                   | Result `transcode` block                                                                 | Job status |
| ---------------------------------------- | --------- | --------------------------- | ---------------------------------------------------------------------------------------- | ---------- |
| ffmpeg not configured                    | (skipped) | `podcast_transcode_skipped` | `{status:"not_configured", reason:"ffmpeg not configured"}`                              | SUCCEEDED  |
| configured path does not exist on disk   | (skipped) | `podcast_transcode_skipped` | `{status:"not_configured", reason:"ffmpeg executable not found at the configured path"}` | SUCCEEDED  |
| transcode ok                             | completed | `podcast_transcode_stored`  | `{status:"ok", ...}` + stored MP3 artifact                                               | SUCCEEDED  |
| transcode failed (any reason, see below) | failed    | `podcast_transcode_failed`  | `{status:"failed", reason:"…"}`                                                          | SUCCEEDED  |

**The original (WAV) artifact is always canonical.** A missing or failed
ffmpeg never fails the job.

Failure `reason` strings (for grepping events/logs):

- `ffmpeg_failed: exit=<code> signal=<sig> :: <last 400 chars of stderr>`
- `ffmpeg_timeout`
- `ffmpeg_spawn_failed: <err>` / `ffmpeg_spawn_error: <err>`
- `empty_output: no output file` / `empty_output: 0-byte output`

## 4. Operator checklist (before a live audio run)

1. `NLO_FFMPEG_BIN` set in the service environment to an absolute path.
2. The binary exists and is executable at that path
   (`test -x "$NLO_FFMPEG_BIN"` on Linux; `& $env:NLO_FFMPEG_BIN -version` on
   Windows PowerShell).
3. Smoke test manually:
   `ffmpeg -y -i <any-wav> -acodec libmp3lame -b:a 56k -ar 44100 -ac 2 out.mp3`
   and `ffprobe out.mp3`.
4. Run one text-to-podcast job and confirm the `podcast_transcode_stored`
   event plus a second artifact (MP3) in the job's output listing.

## 5. Disk and limits

- MP3 output is written to the job's output dir as
  `podcast-<hex12>.mp3`; the original keeps its own filename. Both count
  against the per-job output size gate (default 200 MiB for the downloaded
  source artifact; the MP3 is a small derivative).
- A transcode timeout kills the process; partial output is removed.

## 6. Verification level

Unit: argv construction (clamping, exact flags), spawn-error handling,
timeout, empty-output detection — all green in
`apps/server/test/transcode.test.ts`. Live: **NOT TESTED** (no ffmpeg on the
dev machine); record evidence on a host where ffmpeg is installed before
claiming it.
