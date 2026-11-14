import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithin } from "@nlo/shared";
import { sniffAudioMime } from "../src/domain/artifact-validate.js";
import { buildFfmpegArgs, transcodeToMp3 } from "../src/media/transcode.js";
import { JobRunner } from "../src/queue/job-runner.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "./helpers.js";

/**
 * NLO-P2 (Todo 9): MP3 56 kbps transcoding adapter.
 *
 * FFmpeg is NOT installed on the dev machine (and no unapproved system
 * installs), so the adapter is verified against a CONTROLLED STUB executable
 * that emulates ffmpeg's contract: argv in, file out, exit code. What is
 * verified: the safe command construction (direct spawn, no shell), the
 * result contract, non-zero exit / timeout / spawn-error handling, and the
 * pipeline wiring (the original artifact stays canonical; the mp3 is a
 * linked second artifact; a failing transcoder never fails the job).
 *
 * LIVE transcoding is NOT TESTED (no real ffmpeg) — stated honestly in the
 * phase report.
 */

let tdir: string;
let fake: string;
const partsList: TestParts[] = [];

beforeEach(() => {
  tdir = mkdtempSync(path.join(tmpdir(), "nlo-tr-"));
  fake = makeFakeFfmpeg(tdir);
});

afterEach(() => {
  while (partsList.length > 0) partsList.pop()!.dispose();
  rmSync(tdir, { recursive: true, force: true });
});

function parts(): TestParts {
  const p = makeParts();
  partsList.push(p);
  return p;
}

function setupHappy(): TestParts {
  const p = parts();
  addAccount(p.accounts, "transcode@example.com");
  const node = addNode(p.proxies, p.vault, "transcode-node");
  markHealthy(p.proxies, node.id);
  return p;
}

function runnerWith(p: TestParts, ffmpegBin: string | undefined): JobRunner {
  const { accounts, jobs, proxies, provider, proxyManager, runtime, vault, egress, jobsDir } = p;
  return new JobRunner({
    jobs,
    accounts,
    proxies,
    provider,
    proxyManager,
    runtime,
    vault,
    egress,
    jobsDir,
    log: () => {},
    sleep: () => Promise.resolve(),
    rng: () => 0,
    artifacts: p.artifacts,
    stages: p.stages,
    ffmpegBin,
  });
}

/** A platform-specific launcher + node body that emulates ffmpeg's contract. */
function makeFakeFfmpeg(dir: string): string {
  const body = path.join(dir, "fake-ffmpeg-body.mjs");
  writeFileSync(
    body,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      "const out = args[args.length - 1];",
      "if (process.env.FAKE_FFMPEG_HOLD) {",
      "  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_FFMPEG_HOLD)));",
      "  process.exit(0);",
      "}",
      "if (process.env.FAKE_FFMPEG_ARGS_OUT) {",
      "  writeFileSync(process.env.FAKE_FFMPEG_ARGS_OUT, JSON.stringify(args));",
      "}",
      'if (process.env.FAKE_FFMPEG_FAIL === "1") {',
      '  process.stderr.write("fake ffmpeg: simulated encode failure\\n");',
      "  process.exit(1);",
      "}",
      "const mp3 = Buffer.from([0xff, 0xe3, 0xc4, 0x00, 0x80, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);",
      "writeFileSync(out, mp3);",
      "",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    const p = path.join(dir, "fake-ffmpeg.bat");
    writeFileSync(p, `@echo off\r\nnode "${body}" %*\r\n`, "utf8");
    return p;
  }
  const p = path.join(dir, "fake-ffmpeg.sh");
  writeFileSync(p, `#!/bin/sh\nexec node "${body}" "$@"\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

// ---------------------------------------------------------------------------
// buildFfmpegArgs (pure)
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs (safe argv construction, no shell)", () => {
  it("builds the fixed argument vector in order", () => {
    expect(buildFfmpegArgs({ inputPath: "in.wav", outputPath: "out.mp3" })).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "in.wav",
      "-vn",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "56k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "out.mp3",
    ]);
  });

  it("honors a custom kbps and clamps to lame's CBR range (8..320)", () => {
    const b = (kbps: number): string[] =>
      buildFfmpegArgs({ inputPath: "i", outputPath: "o", targetKbps: kbps });
    expect(b(128)).toContain("128k");
    expect(b(4)).toContain("8k");
    expect(b(999)).toContain("320k");
    expect(b(57.4)).toContain("57k");
  });
});

// ---------------------------------------------------------------------------
// transcodeToMp3 (controlled stub executable)
// ---------------------------------------------------------------------------

describe("transcodeToMp3 (controlled stub executable)", () => {
  it("ok: writes the output, reports the verified size, and passes the exact argv", async () => {
    const inPath = path.join(tdir, "in.wav");
    writeFileSync(inPath, Buffer.alloc(32));
    const outPath = path.join(tdir, "out.mp3");
    const argsOut = path.join(tdir, "args.json");
    process.env.FAKE_FFMPEG_ARGS_OUT = argsOut;
    try {
      const res = await transcodeToMp3({
        ffmpegBin: fake,
        inputPath: inPath,
        outputPath: outPath,
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe(outPath);
      expect(res.size).toBe(16);
      expect(statSync(outPath).size).toBe(16);
      // the stub output carries a real MPEG frame sync -> the sniffer agrees
      expect(sniffAudioMime(outPath)).toBe("audio/mpeg");
      const argv = JSON.parse(readFileSync(argsOut, "utf8")) as string[];
      expect(argv).toEqual(buildFfmpegArgs({ inputPath: inPath, outputPath: outPath }));
    } finally {
      delete process.env.FAKE_FFMPEG_ARGS_OUT;
    }
  });

  it("a non-zero exit is a structured failure carrying the exit code + stderr", async () => {
    const inPath = path.join(tdir, "in.wav");
    writeFileSync(inPath, Buffer.alloc(32));
    const outPath = path.join(tdir, "out.mp3");
    process.env.FAKE_FFMPEG_FAIL = "1";
    try {
      const res = await transcodeToMp3({
        ffmpegBin: fake,
        inputPath: inPath,
        outputPath: outPath,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/ffmpeg_failed/);
      expect(res.reason).toMatch(/simulated encode failure/);
      expect(res.exitCode).toBe(1);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      delete process.env.FAKE_FFMPEG_FAIL;
    }
  });

  it("a hang is killed after the timeout (no hang, structured result)", async () => {
    const inPath = path.join(tdir, "in.wav");
    writeFileSync(inPath, Buffer.alloc(32));
    const outPath = path.join(tdir, "out.mp3");
    process.env.FAKE_FFMPEG_HOLD = "400";
    try {
      const res = await transcodeToMp3({
        ffmpegBin: fake,
        inputPath: inPath,
        outputPath: outPath,
        timeoutMs: 100,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/ffmpeg_timeout/);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      delete process.env.FAKE_FFMPEG_HOLD;
    }
  });

  it("a missing executable is a spawn error, not a crash", async () => {
    const inPath = path.join(tdir, "in.wav");
    writeFileSync(inPath, Buffer.alloc(32));
    const res = await transcodeToMp3({
      ffmpegBin: path.join(tdir, "definitely-not-ffmpeg.exe"),
      inputPath: inPath,
      outputPath: path.join(tdir, "out.mp3"),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/ffmpeg_spawn_error/);
  });
});

// ---------------------------------------------------------------------------
// pipeline integration (mock provider + stub ffmpeg)
// ---------------------------------------------------------------------------

describe("pipeline integration (mock provider + stub ffmpeg)", () => {
  it("ffmpeg configured: the job stores the original WAV AND a linked mp3 variant", async () => {
    const p = setupHappy();
    const runner = runnerWith(p, fake);
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");

    const rows = p.artifacts.listByJob(job.id);
    const wav = rows.filter((a) => a.filename.endsWith(".wav"));
    const mp3 = rows.filter((a) => a.filename.endsWith(".mp3"));
    expect(wav).toHaveLength(1);
    expect(mp3).toHaveLength(1);
    const w = wav[0]!;
    const m = mp3[0]!;
    expect(m.mediaType).toBe("audio/mpeg");
    expect(m.source).toBe("provider");
    expect(m.codec).toBe("mp3");
    expect(m.bitrate).toBe(56);
    expect(m.sourceArtifactId).toBe(w.id);
    expect(m.provenance).toBe("mock");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.size).toBe(16);
    // duration is inherited from the VERIFIED source artifact
    expect(m.durationSeconds).toBeCloseTo(0.032, 6);
    // the stored file is the transcoder's output, hashed correctly
    const file = resolveWithin(p.jobsDir, job.id, m.storageKey);
    expect(statSync(file).size).toBe(16);

    const stages = p.stages.listByJob(job.id);
    expect(stages.map((s) => s.stage)).toEqual([
      "audio_generation",
      "artifact_download",
      "artifact_store",
      "mp3_transcode",
    ]);
    const tr = stages.find((s) => s.stage === "mp3_transcode")!;
    expect(tr.state).toBe("completed");

    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.transcode).toMatchObject({ status: "ok", bitrate: 56, size: 16 });
    expect((pm.transcode as Record<string, unknown>).artifactId).toBe(m.id);
  });

  it("ffmpeg NOT configured: the job still succeeds; transcode reported not_configured", async () => {
    const p = setupHappy();
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await p.runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");
    const rows = p.artifacts.listByJob(job.id);
    expect(rows.filter((a) => a.filename.endsWith(".mp3"))).toHaveLength(0);
    expect(p.stages.listByJob(job.id).map((s) => s.stage)).toEqual([
      "audio_generation",
      "artifact_download",
      "artifact_store",
    ]);
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.transcode).toMatchObject({ status: "not_configured" });
  });

  it("ffmpeg fails: the job STILL succeeds with the original artifact; the failure is honest", async () => {
    const p = setupHappy();
    const runner = runnerWith(p, fake);
    process.env.FAKE_FFMPEG_FAIL = "1";
    try {
      const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
      const done = await runner.run(job.id);
      expect(done.status).toBe("SUCCEEDED");

      const rows = p.artifacts.listByJob(job.id);
      expect(rows.filter((a) => a.filename.endsWith(".wav"))).toHaveLength(1);
      expect(rows.filter((a) => a.filename.endsWith(".mp3"))).toHaveLength(0);

      const tr = p.stages.listByJob(job.id).find((s) => s.stage === "mp3_transcode")!;
      expect(tr.state).toBe("failed");
      expect(tr.lastError).toMatch(/ffmpeg_failed/);

      // no leftover mp3 file in the output dir
      const out = readdirSync(resolveWithin(p.jobsDir, job.id, "output"));
      expect(out.filter((n) => n.endsWith(".mp3"))).toHaveLength(0);

      const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
        string,
        unknown
      >;
      expect(pm.transcode).toMatchObject({ status: "failed" });
      expect((pm.transcode as Record<string, unknown>).reason).toMatch(/simulated encode failure/);
    } finally {
      delete process.env.FAKE_FFMPEG_FAIL;
    }
  });
});
