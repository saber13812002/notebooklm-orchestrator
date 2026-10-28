import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes, resolveWithin, safeName } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { dataPaths } from "../../config.js";
import { createJobFromUpload, parseJobMultipart } from "../job-create.js";
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
    return reply.code(201).send({ id: job.id, status: job.status });
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

  app.get<{ Params: { id: string } }>(`${base}/jobs/:id/artifacts`, async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    const rows = (ctx.jobs as unknown as { db: { raw: import("node:sqlite").DatabaseSync } }).db.raw
      .prepare(
        "SELECT id, filename, media_type, size, source, storage_key, created_at FROM artifacts WHERE job_id = ? ORDER BY id",
      )
      .all(job.id) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      filename: r.filename as string,
      mediaType: r.media_type as string,
      size: r.size as number,
      source: r.source as string,
      storageKey: r.storage_key as string,
      createdAt: r.created_at as string,
    }));
  });

  // Download a single artifact (safe: storage_key is server-assigned).
  app.get<{ Params: { id: string; artifactId: string } }>(
    `${base}/jobs/:id/artifacts/:artifactId`,
    async (req, reply) => {
      const job = ctx.jobs.get(req.params.id);
      if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
      const art = (
        ctx.jobs as unknown as { db: { raw: import("node:sqlite").DatabaseSync } }
      ).db.raw
        .prepare("SELECT * FROM artifacts WHERE id = ? AND job_id = ?")
        .get(req.params.artifactId, job.id) as Record<string, unknown> | undefined;
      if (!art) throw new ApiError(ApiCodes.notFound, "artifact not found", 404);

      const { createReadStream, statSync } = await import("node:fs");
      const storageKey = art.storage_key as string;
      const file = resolveWithin(dataPaths(ctx.config.dataDir).jobsDir, job.id, storageKey);
      const stat = statSync(file);
      reply.header("content-type", art.media_type as string);
      reply.header("content-length", stat.size);
      reply.header(
        "content-disposition",
        `attachment; filename="${encodeURIComponent(art.filename as string)}"`,
      );
      return reply.send(createReadStream(file));
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
