import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, statSync } from "node:fs";
import { ApiError, ApiCodes, resolveWithin, safeName } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { dataPaths } from "../../config.js";
import type { ArtifactRow } from "../../domain/artifacts.repo.js";
import { createJobFromUpload, parseJobMultipart } from "../job-create.js";
import { createJobFromText } from "../job-create-text.js";
import "../request-augment.js";

const listQuery = z.object({
  status: z.string().optional(),
  accountId: z.string().optional(),
  nodeId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** A valid Idempotency-Key: 8-128 chars, printable, unambiguous. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function registerJobRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  base: string = "/api",
): void {
  /** NLO-P2: artifact view — full verified metadata + the canonical download URL. */
  const artifactView = (a: ArtifactRow) => ({
    id: a.id,
    filename: a.filename,
    mediaType: a.mediaType,
    size: a.size,
    source: a.source,
    durationSeconds: a.durationSeconds,
    codec: a.codec,
    sampleRate: a.sampleRate,
    channels: a.channels,
    bitrate: a.bitrate,
    sourceArtifactId: a.sourceArtifactId,
    sha256: a.sha256,
    provenance: a.provenance,
    createdAt: a.createdAt,
    downloadUrl: `${base}/artifacts/${a.id}/download`,
  });

  /**
   * NLO-P2: ownership check + safe streaming for artifact downloads.
   *
   * Ownership: an artifact whose owning job was created by an API token
   * (token_id != null) can only be downloaded by that SAME token or an
   * admin token. Artifacts of unowned jobs (token_id null — UI / local
   * loopback) are served to any caller that can reach the server (the
   * established loopback trust model).
   *
   * Safety: the file path is re-derived from the row's own storage_key via
   * resolveWithin (no client-controlled path component); a missing or
   * escaping file is a 404 that never discloses an internal path.
   */
  const sendArtifact = (req: FastifyRequest, reply: FastifyReply, art: ArtifactRow): void => {
    if (art.tokenId !== null) {
      const tok = req.apiToken ?? null;
      const owned = tok !== null && (tok.id === art.tokenId || tok.scopes.includes("admin"));
      if (!owned) {
        throw new ApiError(ApiCodes.forbidden, "artifact belongs to a different owner", 403);
      }
    }
    let file: string;
    try {
      file = resolveWithin(dataPaths(ctx.config.dataDir).jobsDir, art.jobId, art.storageKey);
    } catch {
      throw new ApiError(ApiCodes.notFound, "artifact file not found", 404);
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new ApiError(ApiCodes.notFound, "artifact file not found", 404);
    }
    reply.header("content-type", art.mediaType);
    reply.header("content-length", stat.size);
    reply.header(
      "content-disposition",
      `attachment; filename="${encodeURIComponent(art.filename)}"`,
    );
    reply.send(createReadStream(file));
  };
  // Create a job: multipart with fields prompt, preferredAccountId,
  // preferredNodeId and an optional file part "audio".
  //
  // Idempotency (C5): an `Idempotency-Key` header is honored ONLY when the
  // request carries a resolved API token (the v1 surface). Legacy loopback
  // callers have no token, so their behavior is unchanged (always a fresh
  // job). A replay (same token + key) returns the ORIGINAL job with 200 and
  // `x-idempotent-replay: true` — no second job, no second archive.
  app.post(`${base}/jobs`, async (req, reply) => {
    const parsed = await parseJobMultipart(req, ctx);
    const rawKey = req.headers["idempotency-key"];
    let idempotencyKey: string | null = null;
    if (rawKey !== undefined) {
      const key = Array.isArray(rawKey) ? (rawKey[0] ?? "") : String(rawKey);
      if (!IDEMPOTENCY_KEY_RE.test(key)) {
        await parsed.cleanup();
        throw new ApiError(
          ApiCodes.validation,
          "Idempotency-Key must be 8-128 chars of [A-Za-z0-9._-]",
          400,
        );
      }
      idempotencyKey = key;
    }
    const { job, idempotentReplay } = await createJobFromUpload(ctx, parsed, {
      idempotencyKey,
      tokenId: req.apiToken?.id ?? null,
    });
    if (idempotentReplay) {
      reply.header("x-idempotent-replay", "true");
      return reply.code(200).send({ id: job.id, status: job.status });
    }
    ctx.webhooks.publish(job.id, "job.created");
    return reply.code(201).send({ id: job.id, status: job.status });
  });

  // H1: create a notebook job from pasted text (JSON).
  //
  // Returns 202 (accepted for asynchronous processing — not 201, because the
  // request produces a job, not a finished resource). Idempotency semantics
  // are identical to POST /jobs (token-scoped; replay -> 200 +
  // x-idempotent-replay: true). See docs/architecture/h1-text-to-notebook.md.
  const fromTextBody = z.object({
    title: z.string().max(200).optional().nullable(),
    text: z.string().min(1),
    metadata: z
      .object({
        language: z.string().max(32).optional().nullable(),
        customer: z.string().max(200).optional().nullable(),
        category: z.string().max(200).optional().nullable(),
      })
      .optional()
      .nullable(),
    summary: z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().max(20_000).optional().nullable(),
      })
      .optional()
      .nullable(),
    // NLO-P2 (podcast): optional Audio Overview generation after the base
    // notebook workflow.
    podcast: z
      .object({
        enabled: z.boolean(),
        instructions: z.string().max(20_000).optional().nullable(),
        language: z.enum(["en", "fa"]).optional().nullable(),
        format: z.enum(["deep_dive", "brief", "critique", "debate"]).optional().nullable(),
        length: z.enum(["short", "default", "long"]).optional().nullable(),
      })
      .optional()
      .nullable(),
  });

  app.post(`${base}/notebooks/from-text`, async (req, reply) => {
    const body = fromTextBody.parse(req.body);
    const rawKey = req.headers["idempotency-key"];
    let idempotencyKey: string | null = null;
    if (rawKey !== undefined) {
      const key = Array.isArray(rawKey) ? (rawKey[0] ?? "") : String(rawKey);
      if (!IDEMPOTENCY_KEY_RE.test(key)) {
        throw new ApiError(
          ApiCodes.validation,
          "Idempotency-Key must be 8-128 chars of [A-Za-z0-9._-]",
          400,
        );
      }
      idempotencyKey = key;
    }
    const { job, idempotentReplay } = await createJobFromText(ctx, body, {
      idempotencyKey,
      tokenId: req.apiToken?.id ?? null,
    });
    const payload = {
      jobId: job.id,
      status: job.status,
      correlationId: req.correlationId ?? null,
      createdAt: job.createdAt,
      statusUrl: `${base}/jobs/${job.id}`,
    };
    if (idempotentReplay) {
      reply.header("x-idempotent-replay", "true");
      return reply.code(200).send(payload);
    }
    ctx.webhooks.publish(job.id, "job.created");
    return reply.code(202).send(payload);
  });

  // List with filters + pagination.
  app.get(`${base}/jobs`, async (req) => {
    const q = listQuery.parse(req.query);
    const status = q.status
      ? (q.status.split(",") as import("@nlo/shared").JobStatus[])
      : undefined;
    return ctx.jobs.list({
      status,
      accountId: q.accountId,
      nodeId: q.nodeId,
      search: q.search,
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get<{ Params: { id: string } }>(`${base}/jobs/:id`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return job;
  });

  // H1: stable result contract for a text (or any) job.
  // url/shareUrl are NEVER fabricated — null until a provider confirms them.
  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/result`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    const succeeded = job.status === "SUCCEEDED";
    return {
      jobId: job.id,
      status: job.status,
      notebook:
        succeeded && job.notebookId
          ? {
              id: job.notebookId,
              title: job.notebookTitle ?? null,
              url: null,
              shareUrl: null,
            }
          : null,
      source: succeeded && job.sourceId ? { id: job.sourceId } : null,
      summary: succeeded
        ? {
            text: job.answerMarkdown ?? null,
            promptVersion: job.input.promptVersion ?? null,
          }
        : null,
      provenance: job.resultProvenance ?? "unknown",
      artifacts: ctx.artifacts.listByJob(job.id).map(artifactView),
    };
  });

  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/events`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return ctx.jobs.events(job.id);
  });

  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/attempts`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return ctx.jobs.attempts(job.id);
  });

  // NLO-P2: the job's stored artifacts with full verified metadata.
  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/artifacts`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return ctx.artifacts.listByJob(job.id).map(artifactView);
  });

  // Download a single artifact (safe: storage_key is server-assigned).
  app.get<{ Params: { id: string; artifactId: string } }>(
    `${base}/jobs/:id/artifacts/:artifactId`,
    (req, reply) => {
      const job = ctx.jobs.get(req.params.id);
      if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
      const art = ctx.artifacts.listByJob(job.id).find((a) => a.id === req.params.artifactId);
      if (!art) throw new ApiError(ApiCodes.notFound, "artifact not found", 404);
      sendArtifact(req, reply, art);
    },
  );

  // NLO-P2: the canonical artifact download endpoint (job-agnostic).
  // Ownership: artifacts of token-created jobs are restricted to the owning
  // token or an admin token; unowned artifacts follow the loopback model.
  app.get<{ Params: { artifactId: string } }>(
    `${base}/artifacts/:artifactId/download`,
    (req, reply) => {
      const art = ctx.artifacts.getById(req.params.artifactId);
      if (!art) throw new ApiError(ApiCodes.notFound, "artifact not found", 404);
      sendArtifact(req, reply, art);
    },
  );

  // Stream the job's INPUT audio back to the web player. The file is
  // server-stored at data/jobs/<id>/input/audio-<safeName> and the path is
  // re-derived from the job's own recorded metadata (resolveWithin keeps it
  // inside the job dir), so no client-controlled path component exists.
  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/audio`, async (req, reply) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    const { originalName, size, mediaType } = job.input.audio;
    if (size <= 0) {
      throw new ApiError(ApiCodes.notFound, "no input audio recorded for this job", 404);
    }
    let safe: string;
    try {
      safe = safeName(originalName);
    } catch {
      throw new ApiError(ApiCodes.notFound, "no input audio recorded for this job", 404);
    }
    const file = resolveWithin(
      dataPaths(ctx.config.dataDir).jobsDir,
      job.id,
      "input",
      `audio-${safe}`,
    );
    const { createReadStream, statSync } = await import("node:fs");
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new ApiError(ApiCodes.notFound, "input audio file missing", 404);
    }
    reply.header("content-type", mediaType);
    reply.header("content-length", stat.size);
    reply.header("content-disposition", `inline; filename="${encodeURIComponent(originalName)}"`);
    return reply.send(createReadStream(file));
  });

  // Download variant of the input audio (attachment disposition).
  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/audio/download`, async (req, reply) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    const { originalName, size, mediaType } = job.input.audio;
    if (size <= 0) {
      throw new ApiError(ApiCodes.notFound, "no input audio recorded for this job", 404);
    }
    let safe: string;
    try {
      safe = safeName(originalName);
    } catch {
      throw new ApiError(ApiCodes.notFound, "no input audio recorded for this job", 404);
    }
    const file = resolveWithin(
      dataPaths(ctx.config.dataDir).jobsDir,
      job.id,
      "input",
      `audio-${safe}`,
    );
    const { createReadStream, statSync } = await import("node:fs");
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new ApiError(ApiCodes.notFound, "input audio file missing", 404);
    }
    reply.header("content-type", mediaType);
    reply.header("content-length", stat.size);
    reply.header(
      "content-disposition",
      `attachment; filename="${encodeURIComponent(originalName)}"`,
    );
    return reply.send(createReadStream(file));
  });

  app.post<{ Params: { id: string } }>(`${base}/jobs/:id/cancel`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    // Terminal: nothing to do.
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) {
      return { ok: true, cancelled: false, status: job.status, note: "already terminal" };
    }
    if (job.status === "RUNNING") {
      // Only RUNNING requests cancel; the runner finalizes CANCELLED.
      ctx.jobs.setStatus(job.id, "CANCEL_REQUESTED");
      const aborted = ctx.runner.cancel(job.id);
      return { ok: true, cancelled: aborted, status: "CANCEL_REQUESTED" };
    }
    // Other in-flight / pending states may go straight to CANCELLED.
    if (
      [
        "CREATED",
        "VALIDATING",
        "QUEUED",
        "WAITING_FOR_ACCOUNT",
        "WAITING_FOR_PROXY",
        "RETRY_WAIT",
        "NEEDS_ATTENTION",
      ].includes(job.status)
    ) {
      ctx.jobs.setStatus(job.id, "CANCELLED", { errorMessage: "cancelled by user" });
      ctx.jobs.appendEvent(job.id, "cancelled", "job cancelled");
      ctx.webhooks.publish(job.id, "job.cancelled");
      return { ok: true, cancelled: true, status: "CANCELLED" };
    }
    throw new ApiError(ApiCodes.invalidState, "job cannot be cancelled in this state", 409);
  });

  // Re-queue a NEEDS_ATTENTION job (human reconciliation).
  app.post<{ Params: { id: string } }>(`${base}/jobs/:id/requeue`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    if (job.status !== "NEEDS_ATTENTION") {
      throw new ApiError(ApiCodes.invalidState, "only NEEDS_ATTENTION jobs can be requeued", 409);
    }
    ctx.jobs.setStatus(job.id, "QUEUED");
    ctx.jobs.appendEvent(job.id, "requeued", "job requeued by operator");
    return { ok: true, status: "QUEUED" };
  });
}
