/**
 * NLO-P4-1D / C2 — Capability honesty (audit map §4.4).
 *
 * For EVERY declared contract operation, one test named
 * `c2:notebooklm.web:<op>` (the runner discovers conformance C2 evidence by
 * this prefix) drives the operation through the EXISTING job engine or the
 * provider boundary and asserts the provider actually produced what it
 * declares — no fabricated artifacts.
 *
 * F-C1 (honesty): `notebook.create`, `source.add.file` and `chat.ask` are
 * fused into ONE `job`/`job_text` run. One shared podcast job evidences all
 * three (the adapter reports one notebook/source/conversation for the run).
 * `source.add.text` is evidenced by a real text-to-notebook job. The seven
 * `generate.audio.*` ops, `artifact.download` and `session.verify` are
 * exercised at the provider boundary with a per-op job id.
 *
 * A final `c2:notebooklm.web:undeclared-*` test asserts every UNDECLARED
 * contract operation is cleanly rejected by the capability gate (level
 * `unsupported`) rather than silently executed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "@nlo/shared";

import type { EgressEndpoint } from "../../src/proxy/gateway.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "../helpers.js";
import { CONFORMANCE_PROVIDER_ID, deriveMockDescriptor } from "./runner.js";

const suffix = (jobId: string): string => jobId.slice(-16);

/** A loopback tunnel endpoint good enough for the mock egress (scenario "up"). */
function fakeEndpoint(nodeId: string): EgressEndpoint {
  return { nodeId, localPort: 48700, expectedEgressIp: "198.51.100.7", evidenceRef: null };
}

describe(`C2 capability honesty (${CONFORMANCE_PROVIDER_ID})`, () => {
  let parts: TestParts;
  let accountId: string;
  let nodeId: string;
  let podcastJob: Job;
  let podcastDone: Job;

  beforeAll(async () => {
    // One shared happy-path stack for the whole C2 suite. Provider-boundary
    // calls use per-op job ids, so mock task ids never alias.
    parts = makeParts();
    accountId = addAccount(parts.accounts, "c2@example.com").id;
    nodeId = addNode(parts.proxies, parts.vault, "c2-node").id;
    markHealthy(parts.proxies, nodeId);

    // The single fused job evidencing notebook.create + source.add.file + chat.ask.
    podcastJob = createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
    podcastDone = await parts.runner.run(podcastJob.id);
  });

  afterAll(() => {
    parts.dispose();
  });

  // ---- F-C1 fused operations (one shared podcast job) --------------------
  it("c2:notebooklm.web:notebook.create", () => {
    expect(podcastDone.status).toBe("SUCCEEDED");
    expect(podcastDone.notebookId).toBe(`mock_nb_${suffix(podcastJob.id)}`);
  });

  it("c2:notebooklm.web:source.add.file", () => {
    // A podcast job always works in a notebook with the uploaded source; the
    // adapter reports one source id for the fused run.
    expect(podcastDone.sourceId).toBe(`mock_src_${suffix(podcastJob.id)}`);
  });

  it("c2:notebooklm.web:chat.ask", () => {
    // The ask step produced a grounded answer AND a conversation id.
    expect(podcastDone.conversationId).toBe(`mock_conv_${suffix(podcastJob.id)}`);
    expect(podcastDone.answerMarkdown).toBeTruthy();
    expect(podcastDone.answerMarkdown).toContain("Mock Answer");
  });

  it("c2:notebooklm.web:source.add.text", async () => {
    // A real text-to-notebook job. The from-text creation route writes the
    // stored source at input/text-source.md; archive.init() only records the
    // metadata, so this test writes the content the same way the route does.
    const text = "Conformance text source: the provider must add this as a NotebookLM source.";
    const job = parts.jobs.create({
      input: {
        prompt: "summarize",
        inputType: "text",
        audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
        text: {
          sha256: "aa".repeat(32),
          sizeBytes: text.length,
          charCount: text.length,
          language: "en",
        },
        podcast: null,
        preferredAccountId: null,
        preferredNodeId: null,
      },
      configSnapshot: { provider: "mock" },
    });
    const inputDir = path.join(parts.jobsDir, job.id, "input");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "text-source.md"), text, "utf8");

    const done = await parts.runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.notebookId).toBe(`mock_nb_${suffix(job.id)}`);
    expect(done.sourceId).toBe(`mock_src_${suffix(job.id)}`);
    // Honesty: the answer reflects the ACTUAL stored text, not a template.
    expect(done.answerMarkdown).toContain(text.slice(0, 100));
  });

  // ---- Audio generation (provider boundary, per-op job id) ---------------
  for (const [op, extra] of [
    ["generate.audio.deep_dive", { audioFormat: "deep_dive" }],
    ["generate.audio.brief", { audioFormat: "brief" }],
    ["generate.audio.critique", { audioFormat: "critique" }],
    ["generate.audio.debate", { audioFormat: "debate" }],
    ["generate.audio.language.en", { language: "en" }],
    ["generate.audio.language.fa", { language: "fa" }],
    ["generate.audio.language.other", { language: "other" }],
  ] as const) {
    it(`c2:notebooklm.web:${op}`, async () => {
      const jobId = `j_c2_${op.replace(/[^a-z0-9]/g, "")}`;
      const res = await parts.provider.generateAudio({
        jobId,
        accountId,
        credentialRef: `session:${accountId}`,
        notebookId: `mock_nb_${suffix(jobId)}`,
        endpoint: fakeEndpoint(nodeId),
        egress: parts.egress,
        signal: new AbortController().signal,
        onProgress: () => {},
        ...extra,
      });
      expect(res.resumed).toBe(false);
      expect(res.notebookId).toBe(`mock_nb_${suffix(jobId)}`);
      // The returned task id is the recoverable handle, deterministic per job.
      expect(res.status.taskId).toBe(parts.provider.mockAudioTaskId(jobId));
      expect(res.status.isComplete).toBe(false); // in_progress after submit
    });
  }

  it("c2:notebooklm.web:artifact.download", async () => {
    const jobId = "j_c2_artifact_download";
    const taskId = parts.provider.mockAudioTaskId(jobId);
    parts.provider.setAudioTaskState(taskId, "completed");
    const res = await parts.provider.downloadAudio({
      jobId,
      accountId,
      credentialRef: `session:${accountId}`,
      notebookId: `mock_nb_${suffix(jobId)}`,
      artifactId: taskId,
      destPath: path.join(parts.dir, "c2-artifact", "podcast.wav"),
      endpoint: fakeEndpoint(nodeId),
      egress: parts.egress,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(res.ready).toBe(true);
    expect(res.size).toBe(1068);
    expect(res.path).toBeDefined();
    expect(existsSync(res.path as string)).toBe(true);
  });

  it("c2:notebooklm.web:session.verify", async () => {
    const st = await parts.provider.getAccountStatus(accountId, `session:${accountId}`);
    expect(st.ok).toBe(true);
    expect(st.email).toBeTruthy();
  });

  it("c2:notebooklm.web:undeclared-* (capability gate rejects cleanly)", () => {
    // Re-derive the descriptor (same source of truth as the capabilities API)
    // and assert every op NOT backed by the worker is `unsupported` — a clean
    // rejection, never a silent execution or an inflated level.
    const d = deriveMockDescriptor();
    const byOp = new Map<string, string>(d.capabilities.map((c) => [c.operation, c.level]));
    const undeclared = [
      "source.add.url",
      "source.add.audio",
      "source.add.video",
      "source.add.pdf",
      "source.add.docx",
      "source.add.md",
      "generate.video.explainer",
      "generate.video.cinematic",
      "generate.video.short",
      "generate.slide_deck",
      "generate.infographic",
      "generate.quiz",
      "generate.flashcards",
      "generate.mind_map",
      "generate.report",
      "generate.data_table",
      "artifact.download.batch",
      "usage.introspect",
    ];
    for (const op of undeclared) {
      expect(byOp.get(op), `level for ${op}`).toBe("unsupported");
    }
  });
});
