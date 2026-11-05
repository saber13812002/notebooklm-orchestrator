import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/app-context.js";
import { dataPathsFor, makeAppContext, addAccount, addNode, markHealthy } from "./helpers.js";
import { buildApp } from "../src/api/server.js";

/**
 * H1 text-to-notebook: API-level integration tests (both surfaces) plus a
 * full in-process E2E with the mock provider (POST -> runner -> SUCCEEDED ->
 * structured result). Live NotebookLM execution is NOT covered here — see the
 * phase report for the live-acceptance runbook.
 */

interface RunningApp {
  ctx: AppContext;
  app: FastifyInstance;
  stop(): Promise<void>;
}

async function startApp(env: Record<string, string> = {}): Promise<RunningApp> {
  const ctx = await makeAppContext(env);
  const app = await buildApp(ctx);
  await app.ready();
  return {
    ctx,
    app,
    stop: async () => {
      await app.close();
      await ctx.close();
    },
  };
}

let running: RunningApp | null = null;
afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

const jsonH = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  ...extra,
});

describe("POST /notebooks/from-text (integration)", () => {
  beforeEach(async () => {
    running = await startApp({});
  });

  it("accepts text via the legacy /api surface with the documented 202 payload", async () => {
    const res = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({
        text: "Legacy surface text body.",
        metadata: { language: "fa", customer: "acme", category: "notes" },
      }),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      jobId: string;
      status: string;
      correlationId: string | null;
      createdAt: string;
      statusUrl: string;
    };
    expect(body.jobId).toMatch(/^j_[0-9a-f]{32}$/);
    expect(body.status).toBe("CREATED");
    expect(body.correlationId).toBeNull(); // legacy surface: no correlation ids
    expect(body.statusUrl).toBe(`/api/jobs/${body.jobId}`);

    // The created job records the text input (charCount in code points) and
    // a derived title from the first line.
    const job = running!.ctx.jobs.get(body.jobId);
    expect(job).not.toBeNull();
    expect(job!.input.text).toMatchObject({
      charCount: "Legacy surface text body.".length,
      language: "fa",
    });
    expect(job!.input.text!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(job!.input.title).toBe("Legacy surface text body.");
    expect(job!.input.promptVersion).toBe("v1"); // default master prompt
    expect(job!.input.metadata).toEqual({ language: "fa", customer: "acme", category: "notes" });
  });

  it("derives the notebook title from the first non-empty line when title is omitted", async () => {
    const res = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({
        text: "   \n\n  A meaningful first line for the notebook\nsecond line",
      }),
    });
    expect(res.statusCode).toBe(202);
    const jobId = (res.json() as { jobId: string }).jobId;
    const job = running!.ctx.jobs.get(jobId);
    expect(job!.input.title).toBe("A meaningful first line for the notebook");
  });

  it("uses the versioned default master prompt (v1) and honors summary.enabled=false", async () => {
    const withSummary = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "Body one." }),
    });
    expect(withSummary.statusCode).toBe(202);
    const j1 = running!.ctx.jobs.get((withSummary.json() as { jobId: string }).jobId);
    expect(j1!.input.prompt).toContain("Summarize the provided source text");
    expect(j1!.input.promptVersion).toBe("v1");

    const noSummary = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "Body two.", summary: { enabled: false } }),
    });
    expect(noSummary.statusCode).toBe(202);
    const j2 = running!.ctx.jobs.get((noSummary.json() as { jobId: string }).jobId);
    expect(j2!.input.prompt).toBe("");
    expect(j2!.input.promptVersion).toBeNull();
  });

  it("stores a caller-supplied prompt as version `custom`", async () => {
    const res = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "Body.", summary: { prompt: "My own prompt." } }),
    });
    expect(res.statusCode).toBe(202);
    const job = running!.ctx.jobs.get((res.json() as { jobId: string }).jobId);
    expect(job!.input.prompt).toBe("My own prompt.");
    expect(job!.input.promptVersion).toBe("custom");
  });

  it("rejects empty / whitespace-only / missing text with 400 validation_error", async () => {
    for (const payload of [{}, { text: "" }, { text: "   " }]) {
      const res = await running!.app.inject({
        method: "POST",
        url: "/api/notebooks/from-text",
        headers: jsonH(),
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  });

  it("rejects oversized text with 400 + the limit in details (NLO_MAX_TEXT_CHARS)", async () => {
    running!.app.close();
    await running!.ctx.close();
    running = null;
    running = await startApp({ NLO_MAX_TEXT_CHARS: "10" });
    const res = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "0123456789AB" }), // 12 chars > 10
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error as { code: string; details?: { maxTextChars?: number } };
    expect(err.code).toBe("validation_error");
    expect(err.details?.maxTextChars).toBe(10);
  });
});

describe("GET /jobs/{id}/result (integration)", () => {
  beforeEach(async () => {
    running = await startApp({});
  });

  it("404s for an unknown job with the standard envelope (both surfaces)", async () => {
    for (const url of ["/api/jobs/j_unknown/result", "/api/v1/jobs/j_unknown/result"]) {
      const res = await running!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("returns the null-result shape for a job that has not SUCCEEDED yet", async () => {
    const created = await running!.app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "Still queued." }),
    });
    const jobId = (created.json() as { jobId: string }).jobId;
    const res = await running!.app.inject({ method: "GET", url: `/api/jobs/${jobId}/result` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      jobId,
      status: "CREATED",
      notebook: null,
      source: null,
      summary: null,
      provenance: "unknown",
    });
  });
});

describe("idempotent text job creation", () => {
  it("replays the original job for the same token + key (200 + header), new job for a new token", async () => {
    running = await startApp({ NLO_API_AUTH: "true" });
    const { app, ctx } = running;
    const a = ctx.apiTokens.create({ name: "a", scopes: ["jobs:write"] });
    const b = ctx.apiTokens.create({ name: "b", scopes: ["jobs:write"] });
    const key = `text-${randomUUID()}`;
    const payload = JSON.stringify({ text: "Replay body." });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/notebooks/from-text",
      headers: { authorization: `Bearer ${a.plaintext}`, "idempotency-key": key, ...jsonH() },
      payload,
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { jobId: string }).jobId;

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/notebooks/from-text",
      headers: { authorization: `Bearer ${a.plaintext}`, "idempotency-key": key, ...jsonH() },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect((replay.json() as { jobId: string }).jobId).toBe(firstId);

    // Different token -> different job (token-scoped keys).
    const other = await app.inject({
      method: "POST",
      url: "/api/v1/notebooks/from-text",
      headers: { authorization: `Bearer ${b.plaintext}`, "idempotency-key": key, ...jsonH() },
      payload,
    });
    expect(other.statusCode).toBe(202);
    expect((other.json() as { jobId: string }).jobId).not.toBe(firstId);
  });
});

/** Full in-process E2E: create via HTTP -> run the job -> structured result. */
describe("E2E (in-process, mock provider)", () => {
  async function startE2E(): Promise<RunningApp> {
    const app = await startApp({});
    addAccount(app.ctx.accounts, "e2e");
    const node = addNode(app.ctx.proxies, app.ctx.vault, "n1");
    markHealthy(app.ctx.proxies, node.id);
    return app;
  }

  it("POST text -> SUCCEEDED with notebook/source/summary + mock provenance", async () => {
    running = await startE2E();
    const { app, ctx } = running;
    const text = "E2E text body: the quick brown fox jumps over the lazy dog.";

    const created = await app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ title: "E2E notebook", text }),
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;

    const job = (await ctx.runner.run(jobId)) as { status: string; answerMarkdown: string | null };
    expect(job.status).toBe("SUCCEEDED");

    // The stored text source is in the archive and the manifest records it.
    const root = path.join(dataPathsFor(ctx.config.dataDir).jobsDir, jobId);
    const textFile = path.join(root, "input", "text-source.md");
    expect(existsSync(textFile)).toBe(true);
    expect(readFileSync(textFile, "utf8")).toBe(text);
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(manifest.input.text).toMatchObject({
      file: "input/text-source.md",
      charCount: text.length,
    });

    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/result` });
    expect(res.statusCode).toBe(200);
    const suffix = jobId.slice(-16);
    expect(res.json()).toMatchObject({
      jobId,
      status: "SUCCEEDED",
      notebook: {
        id: `mock_nb_${suffix}`,
        title: "E2E notebook",
        url: null, // never fabricated
        shareUrl: null,
      },
      source: { id: `mock_src_${suffix}` },
      provenance: "mock",
    });
    const summary = (
      res.json() as { summary: { text: string | null; promptVersion: string | null } }
    ).summary;
    expect(summary.promptVersion).toBe("v1");
    expect(summary.text).toBeTruthy();
    expect(summary.text).toContain("E2E notebook"); // mock echoes the text title
    expect(summary.text).toContain(text.slice(0, 200)); // and a slice of the text

    // The jobs row carries the persisted operation ids + provenance.
    const row = ctx.jobs.get(jobId);
    expect(row!.notebookId).toBe(`mock_nb_${suffix}`);
    expect(row!.sourceId).toBe(`mock_src_${suffix}`);
    expect(row!.conversationId).toBe(`mock_conv_${suffix}`);
    expect(row!.resultProvenance).toBe("mock");
    expect(row!.answerMarkdown).toBeTruthy();
  });

  it("summary.enabled=false -> SUCCEEDED with null summary text and no conversation", async () => {
    running = await startE2E();
    const { app, ctx } = running;
    const created = await app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      headers: jsonH(),
      payload: JSON.stringify({ text: "No summary body.", summary: { enabled: false } }),
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;
    const job = (await ctx.runner.run(jobId)) as { status: string };
    expect(job.status).toBe("SUCCEEDED");

    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/result` });
    expect(res.statusCode).toBe(200);
    const suffix = jobId.slice(-16);
    const body = res.json() as {
      notebook: { id: string };
      source: { id: string } | null;
      summary: { text: string | null } | null;
      provenance: string;
    };
    expect(body.notebook.id).toBe(`mock_nb_${suffix}`);
    expect(body.source).not.toBeNull();
    expect(body.source!.id).toBe(`mock_src_${suffix}`);
    expect(body.summary).toEqual({ text: null, promptVersion: null });
    expect(body.provenance).toBe("mock");

    const row = ctx.jobs.get(jobId);
    expect(row!.answerMarkdown).toBeNull();
    expect(row!.conversationId).toBeNull();
  });
});
