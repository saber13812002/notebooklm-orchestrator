import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithin } from "@nlo/shared";
import { Db } from "../src/db/db.js";
import { sha256OfFile } from "../src/domain/archive.js";
import { JobStagesRepo } from "../src/domain/stages.repo.js";
import { readWavInfo, sniffAudioMime } from "../src/domain/artifact-validate.js";
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
 * NLO-P2 (Todo 8): artifact validation + storage hardening.
 *
 * Coverage:
 *  - `sniffAudioMime`: content-based signature detection (wav/mp3/m4a, garbage,
 *    truncated header) — never extension-based.
 *  - `readWavInfo`: container decode from the file itself (chunk walking,
 *    LIST-chunk skipping, truncation, non-WAV, codec tagging).
 *  - `JobStagesRepo`: stage lifecycle + restart recovery (recoverOpen keeps
 *    the external operation id; failed rows are untouched; idempotent).
 *  - Pipeline integration: the stored podcast artifact row carries VERIFIED
 *    metadata (sha256 matching the file, decoded duration/codec/sampleRate/
 *    channels, honest provenance); base artifacts are hashed too.
 *  - Hardening: a 0-byte download and an over-limit download are FAILED
 *    (invalid_input) and nothing is stored; no temp files are left behind.
 *  - Stage persistence: the happy path completes all three stages with the
 *    external operation id + deadline; an interrupted stage is the restart
 *    checkpoint (in_progress row, external id preserved across recoverOpen).
 */

// ---------------------------------------------------------------------------
// temp-file + test-parts bookkeeping
// ---------------------------------------------------------------------------

let tdir: string;
const partsList: TestParts[] = [];

beforeEach(() => {
  tdir = mkdtempSync(path.join(tmpdir(), "nlo-art-"));
});

afterEach(() => {
  while (partsList.length > 0) partsList.pop()!.dispose();
  rmSync(tdir, { recursive: true, force: true });
});

function tfile(name: string, data: Buffer): string {
  const p = path.join(tdir, name);
  writeFileSync(p, data);
  return p;
}

function parts(): TestParts {
  const p = makeParts();
  partsList.push(p);
  return p;
}

function setupHappy(): TestParts {
  const p = parts();
  addAccount(p.accounts, "storage@example.com");
  const node = addNode(p.proxies, p.vault, "storage-node");
  markHealthy(p.proxies, node.id);
  return p;
}

// ---------------------------------------------------------------------------
// WAV synthesizer (mirrors the mock provider's WAV layout)
// ---------------------------------------------------------------------------

function makeWav(
  numSamples = 512,
  sampleRate = 16000,
  channels = 1,
  bits = 16,
  formatTag = 1,
): Buffer {
  const bytesPerSample = bits / 8;
  const dataSize = numSamples * bytesPerSample * channels;
  const total = 12 + (8 + 16) + (8 + dataSize);
  const b = Buffer.alloc(total);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(total - 8, 4);
  b.write("WAVE", 8, "ascii");
  let pos = 12;
  b.write("fmt ", pos, "ascii");
  pos += 4;
  b.writeUInt32LE(16, pos);
  pos += 4;
  b.writeUInt16LE(formatTag, pos);
  pos += 2;
  b.writeUInt16LE(channels, pos);
  pos += 2;
  b.writeUInt32LE(sampleRate, pos);
  pos += 4;
  b.writeUInt32LE(sampleRate * bytesPerSample * channels, pos);
  pos += 4;
  b.writeUInt16LE(bytesPerSample * channels, pos);
  pos += 2;
  b.writeUInt16LE(bits, pos);
  pos += 2;
  b.write("data", pos, "ascii");
  pos += 4;
  b.writeUInt32LE(dataSize, pos);
  pos += 4;
  // payload left as zeros (silence)
  return b;
}

/** fmt + LIST + data: proves the parser walks chunks instead of assuming
 *  the data chunk sits at a fixed offset. */
function makeWavWithList(): Buffer {
  const numSamples = 512;
  const sampleRate = 16000;
  const channels = 1;
  const bits = 16;
  const bytesPerSample = bits / 8;
  const dataSize = numSamples * bytesPerSample * channels;
  const listSize = 8;
  const total = 12 + (8 + 16) + (8 + listSize) + (8 + dataSize);
  const b = Buffer.alloc(total);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(total - 8, 4);
  b.write("WAVE", 8, "ascii");
  let pos = 12;
  b.write("fmt ", pos, "ascii");
  pos += 4;
  b.writeUInt32LE(16, pos);
  pos += 4;
  b.writeUInt16LE(1, pos);
  pos += 2;
  b.writeUInt16LE(channels, pos);
  pos += 2;
  b.writeUInt32LE(sampleRate, pos);
  pos += 4;
  b.writeUInt32LE(sampleRate * bytesPerSample * channels, pos);
  pos += 4;
  b.writeUInt16LE(bytesPerSample * channels, pos);
  pos += 2;
  b.writeUInt16LE(bits, pos);
  pos += 2;
  b.write("LIST", pos, "ascii");
  pos += 4;
  b.writeUInt32LE(listSize, pos);
  pos += 4;
  b.write("INFO", pos, "ascii");
  pos += listSize;
  b.write("data", pos, "ascii");
  pos += 4;
  b.writeUInt32LE(dataSize, pos);
  pos += 4;
  return b;
}

// ---------------------------------------------------------------------------
// sniffAudioMime
// ---------------------------------------------------------------------------

describe("sniffAudioMime (content-based, never extension-based)", () => {
  it("detects a RIFF/WAVE file as audio/wav", () => {
    expect(sniffAudioMime(tfile("a.wav", makeWav()))).toBe("audio/wav");
  });

  it("detects an MPEG frame sync as audio/mpeg", () => {
    const mp3 = Buffer.alloc(16);
    mp3[0] = 0xff;
    mp3[1] = 0xe3; // 11-bit frame sync
    expect(sniffAudioMime(tfile("a.mp3", mp3))).toBe("audio/mpeg");
  });

  it("detects an ID3v2 tag as audio/mpeg", () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffAudioMime(tfile("a.mp3", id3))).toBe("audio/mpeg");
  });

  it("detects an MP4 ftyp box as audio/mp4", () => {
    const m4a = Buffer.alloc(16);
    m4a.write("ftyp", 4, "ascii");
    m4a.write("M4A ", 8, "ascii");
    expect(sniffAudioMime(tfile("a.m4a", m4a))).toBe("audio/mp4");
  });

  it("returns null for a non-audio file", () => {
    expect(sniffAudioMime(tfile("a.bin", Buffer.alloc(32, 0x01)))).toBeNull();
  });

  it("returns null for a truncated header (fewer than 12 bytes)", () => {
    expect(sniffAudioMime(tfile("a.bin", Buffer.from("RIFF")))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readWavInfo
// ---------------------------------------------------------------------------

describe("readWavInfo (decode the container from the file itself)", () => {
  it("parses a plain PCM WAV: duration, sample rate, channels, codec", () => {
    const info = readWavInfo(tfile("a.wav", makeWav()));
    expect(info).not.toBeNull();
    expect(info!.durationSeconds).toBeCloseTo(0.032, 6); // 1024 bytes / 32000 B/s
    expect(info!.sampleRate).toBe(16000);
    expect(info!.channels).toBe(1);
    expect(info!.codec).toBe("PCM");
  });

  it("computes duration for stereo files", () => {
    const info = readWavInfo(tfile("a.wav", makeWav(100, 8000, 2, 16)));
    expect(info).not.toBeNull();
    // 400 bytes / (8000 * 2 * 2 B/s) = 0.0125 s
    expect(info!.durationSeconds).toBeCloseTo(0.0125, 9);
    expect(info!.channels).toBe(2);
  });

  it("skips extra chunks (LIST) while walking to fmt/data", () => {
    const info = readWavInfo(tfile("a.wav", makeWavWithList()));
    expect(info).not.toBeNull();
    expect(info!.durationSeconds).toBeCloseTo(0.032, 6);
    expect(info!.codec).toBe("PCM");
  });

  it("tags IEEE-float audio as FLOAT", () => {
    const info = readWavInfo(tfile("a.wav", makeWav(512, 16000, 1, 16, 3)));
    expect(info).not.toBeNull();
    expect(info!.codec).toBe("FLOAT");
  });

  it("returns null for a truncated file (no room for a header)", () => {
    expect(readWavInfo(tfile("a.wav", makeWav().subarray(0, 20)))).toBeNull();
  });

  it("returns null for a non-WAV file", () => {
    const mp3 = Buffer.alloc(16);
    mp3[0] = 0xff;
    mp3[1] = 0xe3;
    expect(readWavInfo(tfile("a.mp3", mp3))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JobStagesRepo (unit)
// ---------------------------------------------------------------------------

describe("JobStagesRepo (stage persistence unit)", () => {
  it("begin/setExternal/fail lifecycle; recoverOpen settles only open rows", () => {
    const p = makeParts();
    try {
      const repo = p.stages;
      const job = createJob(p.jobs);
      const jobId = job.id;

      repo.begin(jobId, "audio_generation", { attempt: 1, deadlineMs: 60_000 });
      expect(repo.setExternal(jobId, "audio_generation", "task_123", "task_123")).toBe(1);
      expect(repo.fail(jobId, "audio_generation", "boom")).toBe(1);
      const failed = repo.latest(jobId, "audio_generation");
      expect(failed!.state).toBe("failed");
      expect(failed!.lastError).toBe("boom");
      expect(failed!.externalOperationId).toBe("task_123");
      expect(failed!.checkpointReference).toBe("task_123");

      // A second attempt opens a NEW row; recoverOpen settles only the open one
      // and preserves its external id.
      repo.begin(jobId, "audio_generation", { attempt: 2 });
      expect(repo.recoverOpen(jobId)).toBe(1);
      const rows = repo.listByJob(jobId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.state).toBe("failed");
      expect(rows[0]!.lastError).toBe("boom");
      expect(rows[1]!.state).toBe("failed");
      expect(rows[1]!.lastError).toMatch(/interrupted by restart/);
      // Idempotent: nothing open left.
      expect(repo.recoverOpen(jobId)).toBe(0);
    } finally {
      p.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: metadata + hardening + stage recording
// ---------------------------------------------------------------------------

describe("podcast artifact storage (pipeline integration, mock provider)", () => {
  it("stored podcast row carries verified metadata; base rows are hashed", async () => {
    const p = setupHappy();
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await p.runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");

    const all = p.artifacts.listByJob(job.id);
    const pod = all.filter((a) => a.filename.startsWith("podcast-"));
    expect(pod).toHaveLength(1);
    const a = pod[0]!;
    expect(a.mediaType).toBe("audio/wav");
    expect(a.size).toBe(1068);
    expect(a.source).toBe("provider");
    expect(a.provenance).toBe("mock");
    expect(a.sourceArtifactId).toBeNull();
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Decoded from the stored WAV itself (1024 bytes at 32000 B/s).
    expect(a.durationSeconds).toBeCloseTo(0.032, 6);
    expect(a.codec).toBe("PCM");
    expect(a.sampleRate).toBe(16000);
    expect(a.channels).toBe(1);

    // The recorded hash must match an independent hash of the file on disk.
    const file = resolveWithin(p.jobsDir, job.id, a.storageKey);
    const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(a.sha256).toBe(expected);
    expect(sha256OfFile(file)).toBe(a.sha256);

    // Base (non-podcast) artifact rows also carry hash + provenance.
    const base = all.filter((x) => !x.filename.startsWith("podcast-"));
    expect(base.length).toBeGreaterThan(0);
    for (const b of base) {
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.provenance).toBe("mock");
    }

    // The result meta reports the decoded (not provider-claimed) metadata.
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.durationSeconds).toBeCloseTo(0.032, 6);
    expect(pm.codec).toBe("PCM");
    expect(pm.sampleRate).toBe(16000);
    expect(pm.channels).toBe(1);
    expect(pm.provenance).toBe("mock");
  });

  it("empty (0-byte) download: FAILED invalid_input, nothing stored", async () => {
    const p = setupHappy();
    p.provider.downloadAudio = async (req) => {
      writeFileSync(req.destPath, Buffer.alloc(0));
      return {
        ready: true,
        notebookId: req.notebookId,
        artifactId: req.artifactId,
        path: req.destPath,
        size: 0,
        artifactStatus: "completed",
        checkedAt: new Date().toISOString(),
      };
    };
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await p.runner.run(job.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/empty/i);
    const pod = p.artifacts.listByJob(job.id).filter((a) => a.filename.startsWith("podcast-"));
    expect(pod).toHaveLength(0);
  });

  it("over-limit download: FAILED invalid_input (size limit), no temp file left", async () => {
    const p = setupHappy();
    const big = Buffer.alloc(4096);
    big.write("RIFF", 0, "ascii");
    big.write("WAVE", 8, "ascii");
    p.provider.downloadAudio = async (req) => {
      writeFileSync(req.destPath, big);
      return {
        ready: true,
        notebookId: req.notebookId,
        artifactId: req.artifactId,
        path: req.destPath,
        size: big.length,
        artifactStatus: "completed",
        checkedAt: new Date().toISOString(),
      };
    };
    const { accounts, jobs, proxies, provider, proxyManager, runtime, vault, egress, jobsDir } = p;
    const runner = new JobRunner({
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
      maxPodcastBytes: 1024,
    });
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await runner.run(job.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/exceeds the size limit/);
    expect(done.errorMessage).toMatch(/4096 > 1024/);
    const out = readdirSync(resolveWithin(jobsDir, job.id, "output"));
    expect(out.filter((n) => n.startsWith("podcast-tmp-"))).toHaveLength(0);
    const pod = p.artifacts.listByJob(job.id).filter((a) => a.filename.startsWith("podcast-"));
    expect(pod).toHaveLength(0);
  });

  it("stage persistence: the happy path completes all three stages", async () => {
    const p = setupHappy();
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await p.runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");

    const rows = p.stages.listByJob(job.id);
    expect(rows.map((r) => r.stage)).toEqual([
      "audio_generation",
      "artifact_download",
      "artifact_store",
    ]);
    for (const r of rows) {
      expect(r.state).toBe("completed");
      expect(r.finishedAt).not.toBeNull();
      expect(r.attempt).toBe(1);
    }
    const gen = rows.find((r) => r.stage === "audio_generation")!;
    const taskId = p.provider.mockAudioTaskId(job.id);
    expect(gen.externalOperationId).toBe(taskId);
    expect(gen.checkpointReference).toBe(taskId);
    expect(gen.deadlineMs).toBeGreaterThan(0);
  });

  it("stage persistence: an interrupted stage is the restart checkpoint (external id survives recoverOpen)", async () => {
    const p = setupHappy();
    p.provider.audioAutoComplete = false; // the external task never completes on its own
    const runner = new JobRunner({
      jobs: p.jobs,
      accounts: p.accounts,
      proxies: p.proxies,
      provider: p.provider,
      proxyManager: p.proxyManager,
      runtime: p.runtime,
      vault: p.vault,
      egress: p.egress,
      jobsDir: p.jobsDir,
      log: () => {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), // real timers: the loop yields
      rng: () => 0,
      podcastDeadlineMs: 30_000,
      artifacts: p.artifacts,
      stages: p.stages,
    });
    const job = createJob(p.jobs, "test prompt", { podcast: { enabled: true } });
    const p1 = runner.run(job.id);
    const gotTaskId = await waitFor(() => Boolean(p.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(gotTaskId).toBe(true);
    const taskId = p.provider.mockAudioTaskId(job.id);

    // Simulate a process restart: a fresh DB connection observes the
    // checkpoint row, then recovery settles it — WITHOUT touching the
    // external operation id.
    const db2 = Db.open(path.join(p.dir, "test.sqlite"));
    const stages2 = new JobStagesRepo(db2);
    try {
      const open = stages2.latest(job.id, "audio_generation");
      expect(open).not.toBeNull();
      expect(open!.state).toBe("in_progress");
      expect(open!.externalOperationId).toBe(taskId);
      expect(open!.checkpointReference).toBe(taskId);
      expect(open!.deadlineMs).toBe(30_000);

      expect(stages2.recoverOpen(job.id)).toBeGreaterThanOrEqual(1);
      const after = stages2.latest(job.id, "audio_generation");
      expect(after!.state).toBe("failed");
      expect(after!.lastError).toMatch(/interrupted by restart/);
      expect(after!.externalOperationId).toBe(taskId); // preserved
    } finally {
      db2.close();
    }

    // The old instance yields (it does not settle the job); the job is QUEUED
    // again for the restarted process to RESUME from the persisted task id.
    const recovered = p.jobs.recoverInFlight();
    expect(recovered).toContain(job.id);
    const p1Result = await p1;
    expect(p1Result.status).toBe("QUEUED");
  }, 30_000);
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}
