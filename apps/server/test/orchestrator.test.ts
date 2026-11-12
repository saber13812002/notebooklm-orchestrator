import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/app-context.js";
import { addAccount, addNode, makeAppContext, markHealthy } from "./helpers.js";
import { buildApp } from "../src/api/server.js";

/**
 * M2-6-05 (C): POST /api/v1/orchestrator/ask — the radio RAG -> NotebookLM
 * orchestrator. The radio RAG API is stubbed at the `fetch` level; the
 * NotebookLM leg runs the REAL in-process text-job pipeline with the mock
 * provider (jobs.create is wrapped to auto-run the job, since the test
 * queue is stopped).
 */

interface RunningApp {
  ctx: AppContext;
  app: FastifyInstance;
  stop(): Promise<void>;
}

const ORCH_ENV: Record<string, string> = {
  NLO_RADIO_BASE: "http://127.0.0.1:18043",
  NLO_RADIO_TOKEN: "test-radio-token",
  NLO_RADIO_TIMEOUT_MS: "5000",
  NLO_ORCH_NLO_TIMEOUT_MS: "3000",
  NLO_ORCH_POLL_MS: "10",
};

async function startApp(env: Record<string, string> = {}): Promise<RunningApp> {
  const ctx = await makeAppContext({ ...ORCH_ENV, ...env });
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

const jsonH = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  ...extra,
});

function radioOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const C1 = {
  source: "معارف",
  date: "۱۴۰۴/۰۸/۰۱",
  link: "https://radio.ai.ismc.ir/s/ep1",
  text: "متن مرتبط با سؤال از آرشیو رادیو معارف.",
  score: 0.91,
  session_id: "sess-1",
  chunk_id: "chunk-1",
  rrf_score: null,
  collection: "radio",
  trace_id: "t1",
};
const C2 = {
  source: "معارف",
  date: null,
  link: null,
  text: "متن دوم.",
  score: 0.42,
  session_id: null,
  chunk_id: null,
  rrf_score: null,
  collection: "radio",
  trace_id: "t1",
};
const RRF_C1 = { ...C1, rrf_score: 0.032787, collection: "radio, radio-4b" };
const RRF_C2 = { ...C2, rrf_score: 0.030117, collection: "radio, radio-4b" };

function radioBody(traceId: string, citations: Record<string, unknown>[]) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "rag-radio",
    trace_id: traceId,
    choices: [{ index: 0, message: { role: "assistant", content: "پاسخ تستی از رادیو." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    rag: { citations, metadata: { service: "radio", top_score: 0.91 } },
  };
}

/** The real text-job pipeline with the mock provider: wrap jobs.create to
 *  auto-run each new job (the test queue is stopped). */
function autoRunJobs(running: RunningApp): void {
  const origCreate = running.ctx.jobs.create.bind(running.ctx.jobs);
  running.ctx.jobs.create = ((input: Parameters<typeof origCreate>[0]) => {
    const job = origCreate(input);
    void running.ctx.runner.run(job.id).catch(() => {
      /* job row carries the failure state */
    });
    return job;
  }) as typeof origCreate;
}

let running: RunningApp | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (running) {
    await running.stop();
    running = null;
  }
});

describe("POST /orchestrator/ask (M2-6-05 C)", () => {
  it("returns the RAG answer with the full 12-field contract; notebooklm disabled", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        return radioOk(radioBody("a".repeat(32), [C1, C2]));
      }),
    );
    running = await startApp();
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "آیه اول سوره بقره چیست؟", notebooklm: { enabled: false } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // top-level 12-field contract
    expect(body.question).toBe("آیه اول سوره بقره چیست؟");
    expect(body.answer).toBe("پاسخ تستی از رادیو.");
    expect(body.selected_variant).toBe("06b");
    expect(body.trace_id).toBe("a".repeat(32));
    expect(body.collection).toBe("radio");
    // per-source fields
    expect(body.sources).toHaveLength(2);
    const [s1, s2] = body.sources;
    expect(s1.rank).toBe(1);
    expect(s1.source_id).toBe("sess-1#chunk-1");
    expect(s1.title).toBe("معارف");
    expect(s1.url).toBe("https://radio.ai.ismc.ir/s/ep1");
    expect(s1.date).toBe("۱۴۰۴/۰۸/۰۱");
    expect(s1.relevant_text).toBe("متن مرتبط با سؤال از آرشیو رادیو معارف.");
    expect(s1.score).toBeCloseTo(0.91);
    expect(s1.rrf_score).toBeNull();
    expect(s1.collection).toBe("radio");
    expect(s2.rank).toBe(2);
    expect(s2.source_id).toBeNull(); // missing session_id/chunk_id -> null, not fabricated
    expect(s2.url).toBeNull();
    expect(s2.date).toBeNull();
    // notebooklm skipped
    expect(body.notebooklm).toEqual({
      jobId: null,
      status: null,
      timedOut: false,
      notebook: null,
      source: null,
      summary: null,
      provenance: "unknown",
      statusUrl: null,
    });
    // the radio call
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:18043/api/v1/chat/completions");
    const init = call.init;
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-radio-token");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("rag-radio");
    expect(sent.stream).toBe(false);
    expect(sent.variant).toBe("06b");
    expect(sent.messages).toEqual([{ role: "user", content: "آیه اول سوره بقره چیست؟" }]);
    expect(body.timings.radioMs).toBeGreaterThanOrEqual(0);
    expect(body.timings.notebookMs).toBeNull();
    expect(body.timings.totalMs).toBeGreaterThanOrEqual(body.timings.radioMs);
  });

  it("maps the rrf variant: rrf_score + the real combined collection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => radioOk(radioBody("b".repeat(32), [RRF_C1, RRF_C2]))));
    running = await startApp();
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "قربانی چیست؟", variant: "rrf", notebooklm: { enabled: false } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selected_variant).toBe("rrf");
    expect(body.collection).toBe("radio, radio-4b");
    expect(body.sources[0].rrf_score).toBeCloseTo(0.032787);
    expect(body.sources[1].rrf_score).toBeCloseTo(0.030117);
    const fetchMock = vi.mocked(globalThis.fetch);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(sent.variant).toBe("rrf");
  });

  it("notebooklm enabled: creates a REAL text job that SUCCEEDS (mock provider)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => radioOk(radioBody("c".repeat(32), [C1]))));
    running = await startApp();
    addAccount(running.ctx.accounts, "orch-e2e");
    const node = addNode(running.ctx.proxies, running.ctx.vault, "orch-node");
    markHealthy(running.ctx.proxies, node.id);
    autoRunJobs(running);
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "آیه اول سوره بقره چیست؟" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const nb = body.notebooklm;
    expect(nb.jobId).toMatch(/^j_/);
    expect(nb.status).toBe("SUCCEEDED");
    expect(nb.timedOut).toBe(false);
    expect(nb.notebook.id).toBe(`mock_nb_${nb.jobId.slice(-16)}`);
    expect(nb.source.id).toBe(`mock_src_${nb.jobId.slice(-16)}`);
    expect(nb.summary.text).toBeTruthy();
    expect(nb.summary.promptVersion).toBe("v1");
    expect(nb.provenance).toBe("mock");
    expect(nb.statusUrl).toBe(`/api/v1/jobs/${nb.jobId}`);
    // the transcript stored on the job starts with the question (title)
    const job = running.ctx.jobs.get(nb.jobId);
    expect(job).not.toBeNull();
    expect(job?.input.title).toBe("آیه اول سوره بقره چیست؟");
    expect(body.timings.notebookMs).toBeGreaterThanOrEqual(0);
  });

  it("radio RAG 502 -> 502 provider_unavailable with stage=radio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "retrieval failed" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    running = await startApp();
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "x", notebooklm: { enabled: false } },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe("provider_unavailable");
    expect(body.error.details.stage).toBe("radio");
    expect(body.error.details.status).toBe(502);
  });

  it("radio network failure (fetch rejects) -> 502 provider_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed");
    }));
    running = await startApp();
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "x", notebooklm: { enabled: false } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(res.json().error.details.stage).toBe("radio");
  });

  it("NLO_RADIO_TOKEN not set -> 503 runtime_not_configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => radioOk(radioBody("d".repeat(32), [C1]))));
    running = await startApp({ NLO_RADIO_TOKEN: "" });
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "x", notebooklm: { enabled: false } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("runtime_not_configured");
  });

  it("validation: empty question and unknown variant -> 400", async () => {
    running = await startApp();
    for (const payload of [{ question: "  " }, { question: "ok", variant: "nope" }]) {
      const res = await running.app.inject({
        method: "POST",
        url: "/api/v1/orchestrator/ask",
        headers: jsonH(),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  });

  it("scope: jobs:read token -> 403; jobs:write token -> 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => radioOk(radioBody("e".repeat(32), [C1]))));
    running = await startApp();
    const readTok = running.ctx.apiTokens.create({ name: "orch-read", scopes: ["jobs:read"] });
    const writeTok = running.ctx.apiTokens.create({ name: "orch-write", scopes: ["jobs:write"] });
    const forbidden = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH({ authorization: `Bearer ${readTok.plaintext}` }),
      payload: { question: "x", notebooklm: { enabled: false } },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    const ok = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH({ authorization: `Bearer ${writeTok.plaintext}` }),
      payload: { question: "x", notebooklm: { enabled: false } },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("notebooklm timeout: job never runs -> 200 with timedOut=true + pollable statusUrl", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => radioOk(radioBody("f".repeat(32), [C1]))));
    running = await startApp({ NLO_ORCH_NLO_TIMEOUT_MS: "60", NLO_ORCH_POLL_MS: "10" });
    const res = await running.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/ask",
      headers: jsonH(),
      payload: { question: "سؤال زمان‌بندی‌شده" },
    });
    expect(res.statusCode).toBe(200);
    const nb = res.json().notebooklm;
    expect(nb.jobId).toMatch(/^j_/);
    expect(nb.timedOut).toBe(true);
    expect(nb.status).not.toBe("SUCCEEDED");
    expect(nb.notebook).toBeNull();
    expect(nb.statusUrl).toBe(`/api/v1/jobs/${nb.jobId}`);
  });
});
