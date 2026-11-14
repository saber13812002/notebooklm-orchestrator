import { spawn } from "node:child_process";
import { statSync } from "node:fs";

/**
 * NLO-P2 (Todo 9): standalone MP3 transcoding adapter.
 *
 * Converts a stored podcast audio artifact to MP3 (56 kbps CBR). FFmpeg is
 * NOT installed by this repository: the executable is provided through
 * configuration (NLO_FFMPEG_BIN). Callers treat a missing or failing
 * transcoder as NON-FATAL — the original artifact stays the canonical
 * output and the job reports the transcode status honestly. Live transcoding
 * is therefore NOT TESTED (no ffmpeg on the dev machine); what IS tested is
 * the command construction, the result contract, and failure handling,
 * using a controlled stub executable.
 *
 * Safe command construction: the argument vector is passed as a single
 * argv array — never as a concatenated string — so every path is one
 * entry and nothing is shell-concatenated. On Windows, batch launchers
 * (.bat/.cmd) can only be executed through cmd.exe (a direct CreateProcess
 * on them fails with EINVAL), so they are spawned with `shell: true`; a
 * real ffmpeg.exe / ELF binary is always spawned directly.
 */

export interface TranscodeResult {
  ok: boolean;
  /** The transcoded file (verified non-empty) when ok. */
  path?: string;
  /** Verified size in bytes of the output when ok. */
  size?: number;
  /** Structured reason when ok=false. */
  reason?: string;
  /** Process exit code when the process ran (null otherwise). */
  exitCode?: number | null;
}

export interface TranscodeOptions {
  /** Absolute path to the ffmpeg executable. */
  ffmpegBin: string;
  /** Absolute path of the source audio file. */
  inputPath: string;
  /** Absolute path of the output file. */
  outputPath: string;
  /** Target bitrate in kbps (default 56, the mission spec). */
  targetKbps?: number;
  /** Wall-clock timeout in ms (default 5 minutes). */
  timeoutMs?: number;
}

/**
 * Build the exact argv vector for ffmpeg (pure; exported for unit tests).
 * Output profile: MP3 (libmp3lame) CBR, 44.1 kHz stereo — the standard
 * podcast delivery profile. `-vn` strips any stray video stream.
 */
export function buildFfmpegArgs(opts: {
  inputPath: string;
  outputPath: string;
  targetKbps?: number;
}): string[] {
  const kbps = Math.max(8, Math.min(320, Math.round(opts.targetKbps ?? 56)));
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    opts.inputPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-b:a",
    `${kbps}k`,
    "-ar",
    "44100",
    "-ac",
    "2",
    opts.outputPath,
  ];
}

/**
 * Run one transcode. Never throws: every outcome (spawn error, non-zero
 * exit, timeout, empty output) resolves to a structured TranscodeResult.
 */
export function transcodeToMp3(opts: TranscodeOptions): Promise<TranscodeResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      // Windows: .bat/.cmd launchers must run through cmd.exe (direct
      // spawn of a batch file throws EINVAL). Real executables (ffmpeg.exe,
      // ELF) are spawned directly on every platform.
      const needsShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(opts.ffmpegBin);
      proc = spawn(opts.ffmpegBin, buildFfmpegArgs(opts), {
        stdio: ["ignore", "ignore", "pipe"],
        shell: needsShell,
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: `ffmpeg_spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null,
      });
      return;
    }

    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (r: TranscodeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    timer = setTimeout(
      () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish({ ok: false, reason: "ffmpeg_timeout", exitCode: null });
      },
      opts.timeoutMs ?? 5 * 60_000,
    );

    proc.on("error", (err) => {
      finish({ ok: false, reason: `ffmpeg_spawn_error: ${err.message}`, exitCode: null });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });

    proc.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        finish({
          ok: false,
          reason: `ffmpeg_failed: exit=${code ?? "null"} signal=${signal ?? "null"} :: ${
            stderr.trim().slice(-400) || "(no stderr)"
          }`,
          exitCode: code,
        });
        return;
      }
      let size = 0;
      try {
        size = statSync(opts.outputPath).size;
      } catch {
        finish({ ok: false, reason: "empty_output: no output file", exitCode: code });
        return;
      }
      if (size === 0) {
        finish({ ok: false, reason: "empty_output: 0-byte output", exitCode: code });
        return;
      }
      finish({ ok: true, path: opts.outputPath, size, exitCode: code });
    });
  });
}
