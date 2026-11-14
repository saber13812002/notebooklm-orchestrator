/**
 * NLO-P2 fault-injection / recovery matrix (mission §14: >=15 scenarios with
 * recorded states).
 *
 * One fault is injected at one boundary (provider scenario, audio task state,
 * download bytes, proxy availability, process restart, user cancel, missing
 * provider capability, transcode executable) and the RESULTING STATE is
 * recorded and asserted: terminal status, error class/message, attempt ledger
 * (outcomes + detail), per-stage rows (state + last error + external op id),
 * egress calls, artifact presence, event timeline, temp-file hygiene and
 * account status.
 *
 * The controlled mock lives ONLY at the provider boundary (MockProvider);
 * everything around it is real application code. These are
 * MOCK_PROVIDER_INTEGRATION verifications — they do NOT prove real NotebookLM
 * execution (that is the live E2E gate, scripts/nlo-e2e.ts).
 *
 * Matrix (FI-01..FI-19):
 *  FI-01 base auth failure            -> FAILED auth; no egress; account AUTH_REQUIRED
 *  FI-02 base rate limit              -> retrying, retrying, failed -> FAILED rate_limit
 *  FI-03 base transient error         -> retrying, retrying, failed -> FAILED provider
 *  FI-04 no proxy route               -> FAILED proxy (fail-closed); NO attempt row
 *  FI-05 generate-stage auth          -> FAILED auth; audio_generation stage failed
 *  FI-06 generate transient -> ok     -> RECOVERY: retrying, ok -> SUCCEEDED (2 attempts)
 *  FI-07 generate-stage ambiguous     -> NEEDS_ATTENTION (no auto-retry)
 *  FI-08 external task proven failed  -> resubmit (audited priorStatus) -> SUCCEEDED
 *  FI-09 external task not_found      -> polling budget -> NEEDS_ATTENTION ambiguous
 *  FI-10 external task stuck          -> polling budget -> NEEDS_ATTENTION ambiguous
 *  FI-11 0-byte download              -> FAILED invalid_input; download stage completed
 *  FI-12 oversize download            -> FAILED invalid_input (size limit)
 *  FI-13 download not ready           -> NEEDS_ATTENTION ambiguous; download stage failed
 *  FI-14 bad audio signature          -> FAILED invalid_input; artifact_store stage failed
 *  FI-15 process restart mid-poll     -> yield QUEUED; restart_recover; RESUME (no dup submit)
 *  FI-16 user cancel mid-poll         -> CANCELLED; external task id preserved
 *  FI-17 provider without audio ops   -> FAILED invalid_input; no stage rows
 *  FI-18 base without notebook id     -> FAILED invalid_input; no generate egress
 *  FI-19 transcode failure            -> SUCCEEDED with wav only; honest transcode report
 *
 * Runners use a REAL timer sleep (unlike makeParts' microtask sleep) so the
 * poll loop yields to the event loop and test-side observers can interleave.
 * `rng: () => 0` makes every backoff 0 ms: retryable faults burn their 3
 * attempts instantly, and deadline scenarios use a short real budget (200 ms).
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWithin } from "@nlo/shared";

import type { MockProviderEgress, ProviderEgress } from "../src/proxy/egress.js";
import { ProviderFailure } from "../src/providers/types.js";
import { JobRunner } from "../src/queue/job-runner.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "./helpers.js";

const partsList: TestParts[] = [];

afterEach(() => {
  while (partsList.length) partsList.pop()!.dispose();
});

function setupHappy(): TestParts & { accountId: string } {
  const parts = makeParts();
  partsList.push(parts);
  const accountId = addAccount(parts.accounts, "fi@example.com").id;
  const nodeId = addNode(parts.proxies, parts.vault, "fi-node").id;
  markHealthy(parts.proxies, nodeId);
  return { ...parts, accountId };
}

/** Account present but NO proxy node: fail-closed proxy selection. */
function setupBare(): TestParts & { accountId: string } {
  const parts = makeParts();
  partsList.push(parts);
  const accountId = addAccount(parts.accounts, "fi@example.com").id;
  return { ...parts, accountId };
}

/** Record egress request paths (EgressAttempt does not carry the path). */
function wrapEgress(inner: MockProviderEgress): { egress: ProviderEgress; paths: string[] } {
  const paths: string[] = [];
  const egress: ProviderEgress = {
    attempts: inner.attempts,
    request: (tunnel, target, body) => {
      paths.push(body.path);
      return inner.request(tunnel, target, body);
    },
  };
  return { egress, paths };
}

const generateCount = (paths: string[]): number =>
  paths.filter((p) => p === "/artifacts/generate_audio").length;

/** Podcast-dedicated runner with a REAL timer sleep (see header). */
function makeRunner(
  parts: TestParts,
  egress: ProviderEgress,
  opts: { podcastDeadlineMs?: number; maxPodcastBytes?: number; ffmpegBin?: string } = {},
): JobRunner {
  return new JobRunner({
    jobs: parts.jobs,
    accounts: parts.accounts,
    proxies: parts.proxies,
    provider: parts.provider,
    proxyManager: parts.proxyManager,
    runtime: parts.runtime,
    vault: parts.vault,
    egress,
    jobsDir: parts.jobsDir,
    log: () => {},
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rng: () => 0,
    podcastDeadlineMs: opts.podcastDeadlineMs,
    maxPodcastBytes: opts.maxPodcastBytes,
    ffmpegBin: opts.ffmpegBin,
    artifacts: parts.artifacts,
    stages: parts.stages,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function podcastJob(parts: TestParts): ReturnType<typeof createJob> {
  return createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
}

/** Attempt ledger outcomes, in order. */
const outcomeSeq = (parts: TestParts, jobId: string): string[] =>
  parts.jobs.attempts(jobId).map((a) => a.outcome);

const eventTypes = (parts: TestParts, jobId: string): string[] =>
  parts.jobs.events(jobId).map((e) => e.type);

const podcastArtifacts = (parts: TestParts, jobId: string) =>
  parts.artifacts.listByJob(jobId).filter((a) => a.filename.startsWith("podcast-"));

const baseArtifacts = (parts: TestParts, jobId: string) =>
  parts.artifacts.listByJob(jobId).filter((a) => a.filename.startsWith("mock-sample-"));

/** Leftover `podcast-tmp-*` temp files in the job output dir (hygiene). */
function tempFilesLeft(parts: TestParts, jobId: string): string[] {
  const out = resolveWithin(parts.jobsDir, jobId, "output");
  if (!existsSync(out)) return [];
  return readdirSync(out).filter((n) => n.startsWith("podcast-tmp-"));
}

/** Minimal fake ffmpeg (node script): FAIL branch + 16-byte mp3 on success. */
function makeFakeFfmpeg(dir: string): string {
  const body = path.join(dir, "fake-ffmpeg-body.mjs");
  writeFileSync(
    body,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      "const out = args[args.length - 1];",
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

describe("NLO-P2 fault-injection / recovery matrix (FI-01..FI-19)", () => {
  it("FI-01 base auth failure: FAILED auth, no egress, account marked AUTH_REQUIRED", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.setScenario(parts.accountId, "auth");

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("auth");
    expect(done.errorMessage).toMatch(/401 authentication required/);
    // The scenario check fires before any egress: the provider was never reached.
    expect(paths).toEqual([]);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    expect(parts.jobs.attempts(job.id)[0]?.detail.failureClass).toBe("auth");
    // The account is quarantined for re-authentication.
    expect(parts.accounts.get(parts.accountId)?.status).toBe("AUTH_REQUIRED");
    // The podcast pipeline never started: no stage rows, no artifacts at all.
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(parts.artifacts.listByJob(job.id)).toHaveLength(0);
  });

  it("FI-02 base rate limit: two 0ms-backoff retries then FAILED rate_limit", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.setScenario(parts.accountId, "rate_limit");

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("rate_limit");
    expect(done.errorMessage).toMatch(/429 too many requests/);
    // maxAttempts = 3: attempt 1,2 -> "retrying" (0 ms backoff with rng 0), 3 -> "failed".
    expect(outcomeSeq(parts, job.id)).toEqual(["retrying", "retrying", "failed"]);
    expect(parts.jobs.attempts(job.id)[1]?.detail.nextDelayMs).toBe(0);
    expect(paths).toEqual([]); // still no provider egress
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(parts.artifacts.listByJob(job.id)).toHaveLength(0);
  });

  it("FI-03 base transient error: bounded retry exhaustion -> FAILED provider", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.setScenario(parts.accountId, "transient");

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("provider");
    expect(done.errorMessage).toMatch(/500 transient provider error/);
    expect(outcomeSeq(parts, job.id)).toEqual(["retrying", "retrying", "failed"]);
    expect(paths).toEqual([]);
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(parts.artifacts.listByJob(job.id)).toHaveLength(0);
  });

  it("FI-04 no proxy route: fail-closed FAILED proxy, NO attempt row recorded", async () => {
    const parts = setupBare(); // account but no node
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("proxy");
    expect(done.errorMessage).toMatch(/no approved proxy route available/);
    // The attempt never started (proxy selection precedes RUNNING).
    expect(outcomeSeq(parts, job.id)).toEqual([]);
    expect(eventTypes(parts, job.id)).toContain("proxy_unavailable");
    expect(paths).toEqual([]);
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(parts.artifacts.listByJob(job.id)).toHaveLength(0);
  });

  it("FI-05 generate-stage auth: FAILED auth; base artifact kept; stage row failed", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.generateAudio = async () => {
      throw new ProviderFailure({
        failureClass: "auth",
        message: "mock: 401 authentication required",
        httpStatus: 401,
        ambiguous: false,
        needsReauth: true,
      });
    };

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("auth");
    expect(done.errorMessage).toMatch(/401 authentication required/);
    // Base workflow completed (one egress, one sample artifact); the generate
    // call threw before reaching the egress boundary.
    expect(paths).not.toContain("/artifacts/generate_audio");
    expect(paths.filter((p) => p === "/batchexecute")).toHaveLength(1);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("failed");
    expect(gen?.lastError).toMatch(/401 authentication required/);
    expect(gen?.attempt).toBe(1);
    expect(baseArtifacts(parts, job.id)).toHaveLength(1);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
  });

  it("FI-06 generate transient -> ok: RECOVERY, second attempt succeeds end-to-end", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    const origGenerate = parts.provider.generateAudio.bind(parts.provider);
    let genCalls = 0;
    parts.provider.generateAudio = async (req) => {
      genCalls += 1;
      if (genCalls === 1) {
        throw new ProviderFailure({
          failureClass: "provider",
          message: "mock: 500 transient provider error",
          httpStatus: 500,
          ambiguous: false,
          needsReauth: false,
        });
      }
      return origGenerate(req);
    };

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("SUCCEEDED");
    expect(done.resultProvenance).toBe("mock");
    expect(outcomeSeq(parts, job.id)).toEqual(["retrying", "ok"]);
    expect(genCalls).toBe(2);
    expect(generateCount(paths)).toBe(1); // only the recovered call hit the egress
    // Fresh generation (no resume id existed at attempt 1).
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.resumed).toBe(false);
    expect(pm.priorStatus).toBeNull();
    // Stage ledger: attempt 1 failed, attempt 2 completed (attempt column = 2).
    const rows = parts.stages.listByJob(job.id).filter((s) => s.stage === "audio_generation");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("failed");
    expect(rows[0]?.lastError).toMatch(/500 transient provider error/);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[1]?.state).toBe("completed");
    expect(rows[1]?.attempt).toBe(2);
    expect(rows[1]?.externalOperationId).toBe(parts.provider.mockAudioTaskId(job.id));
    expect(podcastArtifacts(parts, job.id)).toHaveLength(1);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
  });

  it("FI-07 generate-stage ambiguous: NEEDS_ATTENTION (no auto-retry), no egress", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.generateAudio = async () => {
      throw new ProviderFailure({
        failureClass: "ambiguous",
        message: "mock: worker interrupted, completion unknown",
        ambiguous: true,
        needsReauth: false,
      });
    };

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.errorMessage).toMatch(/worker interrupted/);
    // Ambiguous failures are NEVER auto-retried (the external task may exist).
    expect(outcomeSeq(parts, job.id)).toEqual(["ambiguous"]);
    expect(paths).not.toContain("/artifacts/generate_audio");
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("failed");
    expect(gen?.lastError).toMatch(/worker interrupted/);
    expect(baseArtifacts(parts, job.id)).toHaveLength(1);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-08 external task proven failed: audited resubmission, then SUCCEEDED", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    const taskId = parts.provider.mockAudioTaskId(job.id);
    parts.provider.setAudioTaskState(taskId, "failed");
    parts.provider.audioAutoComplete = true;

    const done = await p;
    expect(done.status).toBe("SUCCEEDED");
    expect(outcomeSeq(parts, job.id)).toEqual(["retrying", "ok"]);
    expect(generateCount(paths)).toBe(2); // original submit + proven-failure resubmit
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.resumed).toBe(false);
    expect(pm.priorStatus).toBe("failed"); // audited: the resubmission replaced a failed task
    expect(pm.taskId).toBe(taskId);
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("completed");
    expect(gen?.externalOperationId).toBe(taskId);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(1);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
  });

  it("FI-09 external task not_found: polling budget -> NEEDS_ATTENTION ambiguous", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress, { podcastDeadlineMs: 200 });
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    // Terminal but neither complete nor failed: the poll loop cannot finish it.
    parts.provider.setAudioTaskState(parts.provider.mockAudioTaskId(job.id), "not_found");

    const done = await p;
    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.errorMessage).toMatch(/polling budget/);
    expect(outcomeSeq(parts, job.id)).toEqual(["ambiguous"]);
    // The external id survives for reconciliation; the stage records the budget failure.
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("failed");
    expect(gen?.lastError).toMatch(/polling budget/);
    expect(gen?.externalOperationId).toBe(parts.provider.mockAudioTaskId(job.id));
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-10 external task stuck in_progress: polling budget -> NEEDS_ATTENTION ambiguous", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress, { podcastDeadlineMs: 200 });
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    // Explicitly exists but never finishes (different fault from FI-09's vanished task).
    parts.provider.setAudioTaskState(parts.provider.mockAudioTaskId(job.id), "in_progress");

    const done = await p;
    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.errorMessage).toMatch(/polling budget/);
    expect(outcomeSeq(parts, job.id)).toEqual(["ambiguous"]);
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("failed");
    expect(gen?.lastError).toMatch(/polling budget/);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-11 0-byte download: FAILED invalid_input; download stage completed, nothing stored", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.downloadAudio = async (req) => {
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

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/empty \(0 bytes\)/);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    // The size gate runs AFTER the download stage is closed: download is
    // completed, and no artifact_store row was ever opened.
    expect(parts.stages.latest(job.id, "artifact_download")?.state).toBe("completed");
    expect(parts.stages.latest(job.id, "artifact_store")).toBeNull();
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
    expect(baseArtifacts(parts, job.id)).toHaveLength(1);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-12 oversize download: FAILED invalid_input (size limit), temp file removed", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress, { maxPodcastBytes: 1024 });
    const big = Buffer.alloc(4096);
    big.write("RIFF", 0, "ascii");
    big.write("WAVE", 8, "ascii");
    parts.provider.downloadAudio = async (req) => {
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

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/exceeds the size limit/);
    expect(done.errorMessage).toMatch(/4096 > 1024/);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    expect(parts.stages.latest(job.id, "artifact_download")?.state).toBe("completed");
    expect(parts.stages.latest(job.id, "artifact_store")).toBeNull();
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-13 download not ready: NEEDS_ATTENTION ambiguous; download stage failed", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.downloadAudio = async (req) => ({
      ready: false,
      notebookId: req.notebookId,
      artifactId: req.artifactId,
      artifactStatus: "in_progress",
      checkedAt: new Date().toISOString(),
    });

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.errorMessage).toMatch(/not ready after confirmed completion/);
    expect(outcomeSeq(parts, job.id)).toEqual(["ambiguous"]);
    const dl = parts.stages.latest(job.id, "artifact_download");
    expect(dl?.state).toBe("failed");
    expect(dl?.lastError).toMatch(/not ready/);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-14 bad audio signature: FAILED invalid_input; artifact_store stage failed", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.downloadAudio = async (req) => {
      const buf = Buffer.from("definitely not audio; this is plain text", "utf8");
      writeFileSync(req.destPath, buf);
      return {
        ready: true,
        notebookId: req.notebookId,
        artifactId: req.artifactId,
        path: req.destPath,
        size: buf.length,
        artifactStatus: "completed",
        checkedAt: new Date().toISOString(),
      };
    };

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/unrecognized audio signature/);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    // The signature check fails INSIDE the store stage (the row exists, failed).
    expect(parts.stages.latest(job.id, "artifact_download")?.state).toBe("completed");
    const store = parts.stages.latest(job.id, "artifact_store");
    expect(store?.state).toBe("failed");
    expect(store?.lastError).toMatch(/unrecognized audio signature/);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-15 process restart mid-poll: yield QUEUED; resume keeps the external task", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner1 = makeRunner(parts, egress);
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p1 = runner1.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    const taskId = parts.provider.mockAudioTaskId(job.id);
    // The open stage row IS the checkpoint: in_progress with the external id.
    const checkpoint = parts.stages.latest(job.id, "audio_generation");
    expect(checkpoint?.state).toBe("in_progress");
    expect(checkpoint?.externalOperationId).toBe(taskId);

    // Simulate a process restart while the external operation is in flight.
    expect(parts.jobs.recoverInFlight()).toContain(job.id);
    const p1Result = await p1;
    expect(p1Result.status).toBe("QUEUED"); // this instance yielded; did NOT settle
    expect(generateCount(paths)).toBe(1);
    // Restart settlement: the open row is failed, the external id PRESERVED.
    expect(parts.stages.recoverOpen(job.id)).toBeGreaterThanOrEqual(1);
    const settled = parts.stages.listByJob(job.id).filter((s) => s.stage === "audio_generation");
    expect(settled[0]?.state).toBe("failed");
    expect(settled[0]?.lastError).toBe("interrupted by restart");
    expect(settled[0]?.externalOperationId).toBe(taskId);

    // A new instance re-takes the job: RESUME, not re-submit.
    parts.provider.audioAutoComplete = true;
    const runner2 = makeRunner(parts, egress);
    const done2 = await runner2.run(job.id);
    expect(done2.status).toBe("SUCCEEDED");
    expect(done2.operationIds?.audioTaskId).toBe(taskId);
    expect(generateCount(paths)).toBe(1); // the resume path performs no egress
    const pm = (done2.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.resumed).toBe(true);
    expect(pm.priorStatus).toBe("in_progress");
    expect(pm.taskId).toBe(taskId);
    // The yielded attempt recorded no ledger row; only the resumed attempt did.
    expect(outcomeSeq(parts, job.id)).toEqual(["ok"]);
    expect(eventTypes(parts, job.id)).toContain("restart_recover");
    expect(eventTypes(parts, job.id)).toContain("podcast_resume_kept");
    const rows = parts.stages.listByJob(job.id).filter((s) => s.stage === "audio_generation");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("failed");
    expect(rows[1]?.state).toBe("completed");
    expect(rows[1]?.externalOperationId).toBe(taskId);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(1);
    expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
  });

  it("FI-16 user cancel mid-poll: CANCELLED; external task id preserved", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const polling = await waitFor(() => {
      const j = parts.jobs.get(job.id);
      return j?.status === "RUNNING" && j.progress === 95;
    });
    expect(polling).toBe(true);
    expect(runner.cancel(job.id)).toBe(true);

    const done = await p;
    expect(done.status).toBe("CANCELLED");
    expect(done.errorClass).toBe("provider");
    expect(done.errorMessage).toMatch(/cancelled by user/);
    expect(outcomeSeq(parts, job.id)).toEqual(["cancelled"]);
    // The external task keeps its id for later reconciliation (it may still
    // complete server-side; nobody re-submits it blindly).
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));
    const gen = parts.stages.latest(job.id, "audio_generation");
    expect(gen?.state).toBe("failed");
    // The abort is observed either in the runner's poll-loop guard
    // ("cancelled while polling podcast generation") or in the provider's
    // audio preflight ("cancelled before start") — whichever runs first after
    // cancel() fires during the 0ms poll sleep. Both are the same recorded
    // outcome: a non-ambiguous provider-class cancellation mid-poll.
    expect(gen?.lastError).toMatch(/cancelled (while polling podcast generation|before start)/);
    expect(gen?.externalOperationId).toBe(parts.provider.mockAudioTaskId(job.id));
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-17 provider without audio ops: FAILED invalid_input; no stage rows, no egress", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    Object.assign(parts.provider, {
      generateAudio: undefined,
      getAudioStatus: undefined,
      downloadAudio: undefined,
    });

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/does not support audio generation/);
    // The capability check runs before any stage is opened.
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(paths).not.toContain("/artifacts/generate_audio");
    expect(baseArtifacts(parts, job.id)).toHaveLength(1);
    expect(podcastArtifacts(parts, job.id)).toHaveLength(0);
  });

  it("FI-18 base without notebook id: FAILED invalid_input; podcast never started", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.runJob = async () => ({
      answerMarkdown: null,
      providerMeta: { provider: "mock", simulated: true },
      artifacts: [],
    });

    const job = podcastJob(parts);
    const done = await runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/did not report a notebook id/);
    expect(outcomeSeq(parts, job.id)).toEqual(["failed"]);
    expect(paths).not.toContain("/artifacts/generate_audio");
    expect(parts.stages.listByJob(job.id)).toHaveLength(0);
    expect(parts.artifacts.listByJob(job.id)).toHaveLength(0);
  });

  it("FI-19 transcode failure: SUCCEEDED with the original wav; honest transcode report", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-fake-ffmpeg-"));
    const fake = makeFakeFfmpeg(dir);
    const runner = makeRunner(parts, egress, { ffmpegBin: fake });
    process.env.FAKE_FFMPEG_FAIL = "1";
    try {
      const job = podcastJob(parts);
      const done = await runner.run(job.id);

      expect(done.status).toBe("SUCCEEDED");
      expect(outcomeSeq(parts, job.id)).toEqual(["ok"]);
      // Original wav stored; the failed encode produced NO mp3 row or file.
      const rows = parts.artifacts.listByJob(job.id);
      expect(rows.filter((a) => a.filename.endsWith(".wav"))).toHaveLength(1);
      expect(rows.filter((a) => a.filename.endsWith(".mp3"))).toHaveLength(0);
      const tr = parts.stages.latest(job.id, "mp3_transcode");
      expect(tr?.state).toBe("failed");
      expect(tr?.lastError).toMatch(/ffmpeg_failed/);
      const out = readdirSync(resolveWithin(parts.jobsDir, job.id, "output"));
      expect(out.filter((n) => n.endsWith(".mp3"))).toHaveLength(0);
      const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
        string,
        unknown
      >;
      expect(pm.transcode).toMatchObject({ status: "failed" });
      expect((pm.transcode as Record<string, unknown>).reason).toMatch(/simulated encode failure/);
      expect(eventTypes(parts, job.id)).toContain("podcast_transcode_failed");
      expect(podcastArtifacts(parts, job.id)).toHaveLength(1);
      expect(tempFilesLeft(parts, job.id)).toHaveLength(0);
    } finally {
      delete process.env.FAKE_FFMPEG_FAIL;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
