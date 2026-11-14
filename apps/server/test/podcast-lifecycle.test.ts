/**
 * NLO-P2 job-lifecycle tests for the Audio Overview (podcast) pipeline.
 *
 * These tests exercise the EXISTING job engine (JobRunner + state machine +
 * persistence + egress boundary + artifact storage) with the podcast
 * pipeline extension: base notebook workflow -> external generation
 * (resumable) -> poll -> download -> signature validation -> artifact row +
 * stored file -> SUCCEEDED.
 *
 * The controlled mock lives ONLY at the provider boundary (MockProvider);
 * everything around it is real application code. These tests are
 * MOCK_PROVIDER_INTEGRATION verification — they do NOT prove real NotebookLM
 * execution (that is the live E2E gate, scripts/nlo-e2e.ts).
 *
 * The runners built here use a REAL timer sleep (unlike makeParts'
 * microtask sleep) so the external-operation poll loop yields to the event
 * loop and test-side observers (waitFor, fault injection, restart recovery)
 * can interleave deterministically.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWithin } from "@nlo/shared";

import type { MockProviderEgress, ProviderEgress } from "../src/proxy/egress.js";
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
  const accountId = addAccount(parts.accounts, "podcast@example.com").id;
  const nodeId = addNode(parts.proxies, parts.vault, "podcast-node").id;
  markHealthy(parts.proxies, nodeId);
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

/**
 * Podcast-dedicated runner: same deps as makeParts' runner, but with a REAL
 * timer sleep so the external-operation poll loop yields to the event loop
 * (a microtask-only sleep would starve the test-side observers).
 */
function makeRunner(
  parts: TestParts,
  egress: ProviderEgress,
  opts: { podcastDeadlineMs?: number } = {},
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

function artifactRows(parts: TestParts, jobId: string): Record<string, unknown>[] {
  const raw = (
    parts.db as unknown as {
      raw: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } };
    }
  ).raw;
  return raw.prepare("SELECT * FROM artifacts WHERE job_id = ?").all(jobId);
}

function podcastJob(parts: TestParts): ReturnType<typeof createJob> {
  return createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
}

describe("NLO-P2 podcast pipeline (job lifecycle)", () => {
  it("audio job: base workflow + external podcast generation -> stored wav artifact -> SUCCEEDED", async () => {
    const parts = setupHappy();
    const job = podcastJob(parts);
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("SUCCEEDED");
    expect(done.resultProvenance).toBe("mock");
    expect(done.notebookId).toBe(`mock_nb_${job.id.slice(-16)}`);
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));

    // Exactly ONE podcast artifact row (the base mock-sample txt is separate).
    const pod = artifactRows(parts, job.id).filter((r) =>
      String(r.filename).startsWith("podcast-"),
    );
    expect(pod).toHaveLength(1);
    const row = pod[0] as Record<string, unknown>;
    expect(row.media_type).toBe("audio/wav");
    expect(row.size).toBe(1068);
    expect(row.storage_key).toBe(`output/${row.filename}`);
    expect(row.source).toBe("provider");

    // The stored file exists at its server-generated path, correct size.
    const filePath = resolveWithin(parts.jobsDir, job.id, String(row.storage_key));
    expect(statSync(filePath).size).toBe(1068);
    // No temp file left behind.
    const out = readdirSync(resolveWithin(parts.jobsDir, job.id, "output"));
    expect(out.filter((n) => n.startsWith("podcast-tmp-"))).toHaveLength(0);

    // Podcast provenance block in the result meta.
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.taskId).toBe(parts.provider.mockAudioTaskId(job.id));
    expect(pm.resumed).toBe(false);
    expect(pm.priorStatus).toBeNull();
    expect(pm.mediaType).toBe("audio/wav");
    expect(pm.size).toBe(1068);
    expect(pm.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pm.artifactId).toBe(row.id);
    expect(pm.storedAs).toBe(`output/${row.filename}`);
    // The duration is now parsed from the stored WAV itself (the mock WAV is
    // 1024 bytes at 32000 bytes/s = 0.032 s), not the provider's claim.
    expect(pm.durationSeconds).toBeCloseTo(0.032, 6);

    // Timeline evidence of every pipeline stage.
    const types = parts.jobs.events(job.id).map((e) => e.type);
    for (const t of ["podcast_submitted", "podcast_completed", "podcast_artifact_stored"]) {
      expect(types).toContain(t);
    }
  });

  it("text job (core mission: text -> podcast): base text workflow + stored podcast artifact", async () => {
    const parts = setupHappy();
    const content = "The quick brown fox jumps over the lazy dog. ";
    const job = parts.jobs.create({
      input: {
        prompt: "turn this into a podcast episode",
        title: "Text to Podcast",
        inputType: "text",
        audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
        text: {
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
          sizeBytes: Buffer.byteLength(content, "utf8"),
          charCount: Array.from(content).length,
          language: "en",
        },
        podcast: { enabled: true, format: "deep_dive", language: "en" },
        preferredAccountId: null,
        preferredNodeId: null,
      },
      configSnapshot: { provider: "mock" },
    });
    const inputDir = resolveWithin(parts.jobsDir, job.id, "input");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(resolveWithin(parts.jobsDir, job.id, "input", "text-source.md"), content, "utf8");

    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("SUCCEEDED");
    expect(done.resultProvenance).toBe("mock");
    expect(done.notebookId).toBe(`mock_nb_${job.id.slice(-16)}`);
    const pod = artifactRows(parts, job.id).filter((r) =>
      String(r.filename).startsWith("podcast-"),
    );
    expect(pod).toHaveLength(1);
    expect((pod[0] as Record<string, unknown>).media_type).toBe("audio/wav");
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.taskId).toBe(parts.provider.mockAudioTaskId(job.id));
    expect(pm.resumed).toBe(false);
  });

  it("restart recovery: external task id survives; the re-taken job RESUMES (no duplicate submit)", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner1 = makeRunner(parts, egress);
    parts.provider.audioAutoComplete = false; // the external task never completes on its own

    const job = podcastJob(parts);
    const p1 = runner1.run(job.id);
    const gotTaskId = await waitFor(() =>
      Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId),
    );
    expect(gotTaskId).toBe(true);
    const taskId = parts.jobs.get(job.id)!.operationIds!.audioTaskId;
    expect(taskId).toBe(parts.provider.mockAudioTaskId(job.id));

    // Simulate a process restart while the external operation is in flight.
    const recovered = parts.jobs.recoverInFlight();
    expect(recovered).toContain(job.id);
    const p1Result = await p1;
    expect(p1Result.status).toBe("QUEUED"); // instance yielded; it did NOT settle the job
    expect(generateCount(paths)).toBe(1);

    // A new instance re-takes the job: resume, not re-submit.
    parts.provider.audioAutoComplete = true;
    const runner2 = makeRunner(parts, egress);
    const done2 = await runner2.run(job.id);
    expect(done2.status).toBe("SUCCEEDED");
    expect(done2.operationIds?.audioTaskId).toBe(taskId);
    const pm = (done2.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.resumed).toBe(true);
    expect(pm.taskId).toBe(taskId);
    expect(generateCount(paths)).toBe(1); // the resume path performs no egress
    const pod = artifactRows(parts, job.id).filter((r) =>
      String(r.filename).startsWith("podcast-"),
    );
    expect(pod).toHaveLength(1);
  });

  it("external task failure -> proven-failure resubmission (audited priorStatus), then success", async () => {
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

    // Retryable provider failure -> bounded retry; the re-run's generate
    // polls the recorded task first, sees proven failure, and re-submits.
    const done = await p;
    expect(done.status).toBe("SUCCEEDED");
    const pm = (done.resultProviderMeta as Record<string, unknown>).podcast as Record<
      string,
      unknown
    >;
    expect(pm.resumed).toBe(false);
    expect(pm.priorStatus).toBe("failed");
    expect(pm.taskId).toBe(taskId);
    expect(generateCount(paths)).toBe(2); // original submit + one proven-failure resubmit
    const pod = artifactRows(parts, job.id).filter((r) =>
      String(r.filename).startsWith("podcast-"),
    );
    expect(pod).toHaveLength(1);
  });

  it("ambiguous worker interruption during polling -> NEEDS_ATTENTION (no auto-retry), task id preserved", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    parts.provider.setScenario(parts.accountId, "ambiguous");

    const done = await p;
    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));
  });

  it("polling budget: a vanished task (not_found) cannot complete -> ambiguous NEEDS_ATTENTION", async () => {
    const parts = setupHappy();
    const { egress } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress, { podcastDeadlineMs: 200 });
    parts.provider.audioAutoComplete = false;

    const job = podcastJob(parts);
    const p = runner.run(job.id);
    const ok = await waitFor(() => Boolean(parts.jobs.get(job.id)?.operationIds?.audioTaskId));
    expect(ok).toBe(true);
    // The task vanishes server-side (terminal, but neither complete nor failed).
    parts.provider.setAudioTaskState(parts.provider.mockAudioTaskId(job.id), "not_found");

    const done = await p;
    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(done.errorMessage).toMatch(/polling budget/i);
  });

  it("cancel mid-poll: CANCELLED, external task id preserved for later reconciliation", async () => {
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
    expect(done.operationIds?.audioTaskId).toBe(parts.provider.mockAudioTaskId(job.id));
  });

  it("plain audio job (no podcast): unchanged behavior — no notebook id, no generate egress", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);

    const job = createJob(parts.jobs); // podcast: null
    const done = await runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.resultProvenance).toBe("mock");
    expect(done.notebookId ?? null).toBeNull();
    expect((done.resultProviderMeta as Record<string, unknown>).podcast).toBeUndefined();
    expect(paths).not.toContain("/artifacts/generate_audio");
    const pod = artifactRows(parts, job.id).filter((r) =>
      String(r.filename).startsWith("podcast-"),
    );
    expect(pod).toHaveLength(0);
  });

  it("provider without audio operations: podcast job fails invalid_input (never silently skipped)", async () => {
    const parts = setupHappy();
    Object.assign(parts.provider, {
      generateAudio: undefined,
      getAudioStatus: undefined,
      downloadAudio: undefined,
    });

    const job = podcastJob(parts);
    const done = await parts.runner.run(job.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/does not support audio generation/);
  });

  it("base workflow failure: the podcast pipeline is not started (no generate egress)", async () => {
    const parts = setupHappy();
    const { egress, paths } = wrapEgress(parts.egress);
    const runner = makeRunner(parts, egress);
    parts.provider.setScenario(parts.accountId, "transient");

    const job = podcastJob(parts);
    const done = await runner.run(job.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("provider");
    expect(paths).not.toContain("/artifacts/generate_audio");
  });

  it("base job without a reported notebook id: podcast fails invalid_input with a clear reason", async () => {
    const parts = setupHappy();
    parts.provider.runJob = async () => ({
      answerMarkdown: null,
      providerMeta: { provider: "mock", simulated: true },
      artifacts: [],
    });

    const job = podcastJob(parts);
    const done = await parts.runner.run(job.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("invalid_input");
    expect(done.errorMessage).toMatch(/did not report a notebook id/);
  });
});
