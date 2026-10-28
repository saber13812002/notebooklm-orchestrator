import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes, type Job } from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import { JobArchive, sha256OfFile } from "../domain/archive.js";
import { dataPaths } from "../config.js";

/**
 * Shared job-creation core used by BOTH the legacy `/api/jobs` handler and
 * the versioned `/api/v1/jobs` handler. Keeping one implementation guarantees
 * the versioned surface cannot drift from the audited legacy behavior
 * (multipart drain semantics, audio validation, archive init + rollback).
 */

export interface ParsedJobUpload {
  fields: Record<string, string>;
  audio: { filename: string; type: string; tempPath: string } | null;
  /** Always called (success or failure) — removes the temp upload copy. */
  cleanup(): Promise<void>;
}

/**
 * Drain a multipart request. The iterator only advances past a file part
 * once its stream is consumed, so each file stream MUST be drained inside
 * the loop (to a temp file) or the request hangs forever.
 */
export async function parseJobMultipart(
  req: import("fastify").FastifyRequest,
  ctx: AppContext,
): Promise<ParsedJobUpload> {
  const fields: Record<string, string> = {};
  let audio: { filename: string; type: string; tempPath: string } | null = null;
  let tempAudioPath: string | null = null;

  try {
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (!audio) {
          tempAudioPath = await saveMultipartToTemp(ctx, part.file);
          audio = {
            filename: part.filename ?? "upload",
            type: part.mimetype ?? "application/octet-stream",
            tempPath: tempAudioPath,
          };
        } else {
          await drainStream(part.file); // extra file parts: discard
        }
      } else if (part.fieldname) {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    if (tempAudioPath) await rm(tempAudioPath);
    throw err;
  }

  return {
    fields,
    audio,
    cleanup: async () => {
      if (tempAudioPath) await rm(tempAudioPath);
    },
  };
}

/**
 * Validate the parsed upload and create the job (archive init included).
 * On any failure the job (if created) is marked FAILED and no temp file leaks.
 *
 * Idempotency: when `opts.idempotencyKey` + `opts.tokenId` are both given and
 * a job already exists for that (token, key), the existing job is returned
 * with `idempotentReplay = true` and NOTHING new is created.
 */
export async function createJobFromUpload(
  ctx: AppContext,
  parsed: ParsedJobUpload,
  opts: { idempotencyKey?: string | null; tokenId?: string | null } = {},
): Promise<{ job: Job; idempotentReplay: boolean }> {
  const { fields, audio } = parsed;
  const idempotencyKey = opts.idempotencyKey ?? null;
  const tokenId = opts.tokenId ?? null;

  try {
    // Idempotent replay: same token + key -> same job, no new side effects.
    if (idempotencyKey && tokenId) {
      const existing = ctx.jobs.findByIdempotencyKey(tokenId, idempotencyKey);
      if (existing) return { job: existing, idempotentReplay: true };
    }

    const prompt = (fields.prompt ?? "").trim();
    if (!prompt) {
      throw new ApiError(ApiCodes.validation, "prompt is required", 400);
    }

    const preferredAccountId = fields.preferredAccountId || null;
    const preferredNodeId = fields.preferredNodeId || null;
    const title = (fields.title ?? "").trim() || null;

    // Reject an unknown account ID up front (clearer than a runner failure
    // later); the runner re-checks eligibility + a live verified session.
    if (preferredAccountId && !ctx.accounts.get(preferredAccountId)) {
      throw new ApiError(ApiCodes.notFound, "preferred account not found", 404);
    }

    // Validate + hash the audio if present.
    let audioMeta: Job["input"]["audio"] = {
      originalName: "",
      mediaType: "",
      size: 0,
      sha256: "",
      providerConfirmed: false,
    };

    if (audio) {
      const ext = path.extname(audio.filename).toLowerCase().replace(".", "");
      if (!ctx.config.allowedAudioExtensions.includes(ext)) {
        throw new ApiError(ApiCodes.validation, `unsupported audio extension: .${ext}`, 400);
      }
      const size = await sizeOf(audio.tempPath);
      if (size === 0) {
        throw new ApiError(ApiCodes.validation, "audio file is empty", 400);
      }
      if (size > ctx.config.maxUploadBytes) {
        throw new ApiError(ApiCodes.validation, "audio file exceeds size limit", 413);
      }
      audioMeta = {
        originalName: audio.filename,
        mediaType: audio.type || `audio/${ext}`,
        size,
        sha256: sha256OfFile(audio.tempPath),
        // Only .wav is confirmed by the real provider; others are unverified.
        providerConfirmed: ext === "wav",
      };
    }

    const job = ctx.jobs.create({
      input: {
        prompt,
        title,
        audio: audioMeta,
        preferredAccountId,
        preferredNodeId,
      },
      configSnapshot: {
        provider: ctx.provider.name,
        proxyRuntime: ctx.config.proxyRuntime,
        host: ctx.config.host,
      },
      idempotencyKey: idempotencyKey && tokenId ? idempotencyKey : null,
      tokenId: idempotencyKey && tokenId ? tokenId : null,
    });

    // Initialize the archive and store the audio under a sanitized name.
    try {
      const archive = new JobArchive(dataPaths(ctx.config.dataDir).jobsDir, job.id);
      archive.init({
        prompt,
        originalAudioName: audioMeta.size > 0 ? audioMeta.originalName : null,
        audioMediaType: audioMeta.size > 0 ? audioMeta.mediaType : null,
        configSnapshot: job.configSnapshot,
        createdAt: job.createdAt,
      });
      if (audio) {
        await archive.storeAudio(audio.tempPath, audioMeta.originalName);
      }
      ctx.jobs.appendEvent(
        job.id,
        "created",
        idempotencyKey
          ? "job created and queued (idempotency key recorded)"
          : "job created and queued",
      );
    } catch {
      // Roll back: fail the job, do not leak the raw error.
      ctx.jobs.setStatus(job.id, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: "archive initialization failed",
      });
      throw new ApiError(ApiCodes.validation, "could not store request", 400);
    }

    return { job, idempotentReplay: false };
  } finally {
    // The temp upload is copied into the archive; drop the temp copy.
    await parsed.cleanup();
  }
}

async function saveMultipartToTemp(
  ctx: AppContext,
  stream: import("node:stream").Readable,
): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { mkdirSync, createWriteStream } = await import("node:fs");
  const dir = path.join(dataPaths(ctx.config.dataDir).tempDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `upl_${randomUUID()}`);
  const ws = createWriteStream(dest);
  await pipeline(stream, ws);
  return dest;
}

/** Consume and discard a stream (required to advance the multipart parser). */
async function drainStream(stream: import("node:stream").Readable): Promise<void> {
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(stream, sink);
}

async function rm(file: string): Promise<void> {
  const { rm: rmFn } = await import("node:fs/promises");
  await rmFn(file, { force: true }).catch(() => {});
}

async function sizeOf(file: string): Promise<number> {
  const { statSync } = await import("node:fs");
  return statSync(file).size;
}

/** Re-export for the routes that still stream job files. */
export type { FastifyInstance };
