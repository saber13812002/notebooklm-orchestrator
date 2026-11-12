import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, ApiCodes, JOB_TERMINAL_STATUSES, type JobStatus } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { createJobFromText } from "../job-create-text.js";

/**
 * M2-6-05 (C): the radio-ma'arif RAG orchestrator endpoint.
 *
 * POST /orchestrator/ask  { question, variant?, notebooklm? }
 *
 * Glues the two existing products into one consolidated answer:
 *   1. radio-rag-service v1  (radio_api, 172.20.1.53:8043)
 *        POST /api/v1/chat/completions {model:"rag-radio", messages, stream:false, variant}
 *      -> { answer, trace_id (real uuid4 hex), rag.citations[] with the 12-field
 *          NotebookLM M2-2 contract values (collection, rrf_score, ...).
 *   2. NLO text-to-notebook (this server): the Q&A transcript is stored as a
 *      real text job (POST /notebooks/from-text core), polled until a terminal
 *      state, and its notebook/source/summary/provenance are included.
 *
 * Contract rules (M2-2): every reported field is either a REAL upstream value
 * or null/UNKNOWN — nothing is fabricated. A notebooklm timeout does NOT fail
 * the request (the radio answer is already produced); the notebooklm section
 * reports the job id + current status + `timedOut: true`.
 *
 * Errors:
 *   400 validation_error          — malformed body (zod).
 *   401/403/429                   — standard v1 token handling (jobs:write).
 *   503 runtime_not_configured    — NLO_RADIO_TOKEN not set on this server.
 *   502 provider_unavailable      — the radio RAG API is unreachable/failed
 *                                   (stage "radio"), or the NLO job could not
 *                                   be created (stage "notebooklm").
 */

const askBody = z.object({
  question: z.string().min(1).max(2000),
  variant: z.enum(["06b", "4b", "rrf"]).default("06b"),
  notebooklm: z
    .object({
      enabled: z.boolean().default(true),
      collection: z.string().max(200).optional().nullable(),
    })
    .optional()
    .nullable(),
});

type Citation = {
  source?: string | null;
  date?: string | null;
  link?: string | null;
  text?: string | null;
  score?: number | null;
  session_id?: string | null;
  chunk_id?: string | null;
  rrf_score?: number | null;
  collection?: string | null;
  trace_id?: string | null;
};

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  // Some upstream fields (e.g. the radio service's `session_id`) arrive as
  // numbers. A real numeric id IS a real value — coerce, don't drop it.
  let s: string;
  if (typeof v === "number" && Number.isFinite(v)) s = String(v);
  else if (typeof v === "string") s = v;
  else return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** Build the NotebookLM transcript: question first (drives the derived
 *  notebook title), then the RAG answer and its ranked, cited sources. */
function buildTranscript(question: string, answer: string, sources: OrchestratorSource[]): string {
  const lines: string[] = [question, "", "پاسخ:", answer, "", "منابع:"];
  if (sources.length === 0) {
    lines.push("—");
  } else {
    for (const s of sources) {
      const parts = [`${s.rank}. ${s.title ?? "نامشخص"}`];
      if (s.date) parts.push(`(${s.date})`);
      lines.push(parts.join(" "));
      if (s.relevant_text) lines.push(s.relevant_text);
      if (s.url) lines.push(s.url);
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

export interface OrchestratorSource {
  rank: number;
  source_id: string | null;
  title: string | null;
  url: string | null;
  date: string | null;
  relevant_text: string | null;
  score: number | null;
  rrf_score: number | null;
  collection: string | null;
}

export function registerOrchestratorRoutes(app: FastifyInstance, ctx: AppContext, base = "/api/v1"): void {
  app.post(`${base}/orchestrator/ask`, async (req) => {
    const parsed = askBody.parse(req.body ?? {});
    const question = parsed.question.trim();
    if (question === "") {
      throw new ApiError(ApiCodes.validation, "question must not be empty", 400);
    }
    const variant = parsed.variant;
    const nbEnabled = parsed.notebooklm?.enabled !== false;
    const requestedCollection = parsed.notebooklm?.collection ?? null;

    const cfg = ctx.config;
    if (!cfg.radioToken) {
      throw new ApiError(
        ApiCodes.runtimeNotConfigured,
        "radio RAG token is not configured (NLO_RADIO_TOKEN)",
        503,
      );
    }

    // ---- 1) radio RAG (OpenAI-compatible v1, non-streaming) ----------------
    const t0 = Date.now();
    const url = `${cfg.radioBase}/api/v1/chat/completions`;
    let res: Response;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), cfg.radioTimeoutMs);
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.radioToken}`,
          },
          body: JSON.stringify({
            model: "rag-radio",
            messages: [{ role: "user", content: question }],
            stream: false,
            variant,
          }),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.name : "network_error";
      throw new ApiError(ApiCodes.providerUnavailable, "radio RAG API unreachable", 502, {
        stage: "radio",
        reason,
      });
    }
    let data: {
      choices?: { message?: { content?: unknown } }[];
      trace_id?: unknown;
      rag?: { citations?: Citation[] };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new ApiError(ApiCodes.providerUnavailable, "radio RAG API returned non-JSON", 502, {
        stage: "radio",
      });
    }
    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = JSON.stringify(data);
      } catch {
        bodyText = "n/a";
      }
      throw new ApiError(ApiCodes.providerUnavailable, "radio RAG API error", 502, {
        stage: "radio",
        status: res.status,
        detail: bodyText.slice(0, 300),
      });
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const firstMsg = choices.length > 0 ? choices[0]?.message : undefined;
    const answer = strOrNull(firstMsg?.content) ?? "";
    const radioMs = Date.now() - t0;

    // ---- 2) the 12-field contract: map citations (real value or null) ------
    const citations: Citation[] = Array.isArray(data.rag?.citations) ? (data.rag?.citations as Citation[]) : [];
    const topCollection = strOrNull(requestedCollection) ?? strOrNull(citations.length > 0 ? citations[0]?.collection : undefined) ?? null;
    const sources: OrchestratorSource[] = citations.map((c, i) => {
      const sessionId = strOrNull(c.session_id);
      const chunkId = strOrNull(c.chunk_id);
      return {
        rank: i + 1,
        source_id: sessionId && chunkId ? `${sessionId}#${chunkId}` : sessionId ?? null,
        title: strOrNull(c.source),
        url: strOrNull(c.link),
        date: strOrNull(c.date),
        relevant_text: strOrNull((c.text ?? "").slice(0, 400)),
        score: numOrNull(c.score),
        rrf_score: numOrNull(c.rrf_score),
        collection: strOrNull(c.collection) ?? topCollection,
      };
    });
    const traceId = strOrNull(data.trace_id);

    // ---- 3) optional NotebookLM consolidation (in-process text job) --------
    let notebookMs: number | null = null;
    let nb: {
      jobId: string | null;
      status: JobStatus | null;
      timedOut: boolean;
      notebook: { id: string; title: string | null; url: null; shareUrl: null } | null;
      source: { id: string } | null;
      summary: { text: string | null; promptVersion: string | null } | null;
      provenance: string;
      statusUrl: string | null;
    };
    if (!nbEnabled) {
      nb = {
        jobId: null,
        status: null,
        timedOut: false,
        notebook: null,
        source: null,
        summary: null,
        provenance: "unknown",
        statusUrl: null,
      };
    } else {
      const t1 = Date.now();
      let job: import("@nlo/shared").Job;
      try {
        const transcript = buildTranscript(question, answer, sources);
        const created = await createJobFromText(
          ctx,
          {
            text: transcript,
            metadata: { language: "fa", customer: "radio-ma-arif", category: topCollection },
          },
          { tokenId: req.apiToken?.id ?? null },
        );
        job = created.job;
      } catch (err) {
        const code = err instanceof ApiError ? err.code : ApiCodes.validation;
        const status = err instanceof ApiError ? err.httpStatus : 502;
        throw new ApiError(
          code,
          "could not create the notebooklm job",
          status === 502 ? 502 : status,
          { stage: "notebooklm" },
        );
      }
      // Poll (the queue is the normal executor; polling is what this
      // synchronous contract needs — the same state the /jobs/:id/result
      // endpoint reports).
      const deadline = Date.now() + cfg.orchNloTimeoutMs;
      let finalJob: import("@nlo/shared").Job = job;
      for (;;) {
        finalJob = ctx.jobs.get(job.id) ?? finalJob;
        if (JOB_TERMINAL_STATUSES.includes(finalJob.status) || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, cfg.orchNloPollMs));
      }
      const succeeded = finalJob.status === "SUCCEEDED";
      nb = {
        jobId: finalJob.id,
        status: finalJob.status,
        timedOut: !JOB_TERMINAL_STATUSES.includes(finalJob.status),
        notebook:
          succeeded && finalJob.notebookId
            ? { id: finalJob.notebookId, title: finalJob.notebookTitle ?? null, url: null, shareUrl: null }
            : null,
        source: succeeded && finalJob.sourceId ? { id: finalJob.sourceId } : null,
        summary: succeeded
          ? { text: finalJob.answerMarkdown ?? null, promptVersion: finalJob.input.promptVersion ?? null }
          : null,
        provenance: finalJob.resultProvenance ?? "unknown",
        statusUrl: `${base}/jobs/${finalJob.id}`,
      };
      notebookMs = Date.now() - t1;
    }

    return {
      question,
      answer,
      selected_variant: variant,
      trace_id: traceId,
      collection: topCollection,
      sources,
      notebooklm: nb,
      timings: {
        radioMs,
        notebookMs,
        totalMs: Date.now() - t0,
      },
    };
  });
}
