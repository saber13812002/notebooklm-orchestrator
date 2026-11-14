import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ApiError,
  ApiCodes,
  cleanFilename,
  deriveNotebookTitle,
  deriveTitleFromText,
  detectLanguage,
  parseSrt,
  resolveMasterPrompt,
  safeName,
  type Job,
} from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import { JobArchive, sha256OfFile } from "../domain/archive.js";
import { extractDocxText } from "../domain/docx.js";
import { dataPaths } from "../config.js";

/**
 * Shared job-creation core used by BOTH the legacy `/api/jobs` handler and
 * the versioned `/api/v1/jobs` handler. Keeping one implementation guarantees
 * the versioned surface cannot drift from the audited legacy behavior
 * (multipart drain semantics, audio validation, archive init + rollback).
 *
 * Phase 3.1: two accepted input shapes (never both):
 *   - audio file  (field `audio` or any file part) — the legacy audio path
 *   - source document (field `source`; .txt/.docx/.srt) — validated and
 *     extracted to plain text, then submitted as a NotebookLM text source
 */

export interface ParsedJobUpload {
  fields: Record<string, string>;
  audio: { filename: string; type: string; tempPath: string } | null;
  /** Phase 3.1: document source (txt/docx/srt) — the alternative to audio. */
  source: { filename: string; type: string; tempPath: string } | null;
  /** Always called (success or failure) — removes the temp upload copies. */
  cleanup(): Promise<void>;
}

/**
 * Drain a multipart request. The iterator only advances past a file part
 * once its stream is consumed, so each file stream MUST be drained inside
 * the loop (to a temp file) or the request hangs forever.
 *
 * File routing: a part with fieldname `source` becomes the document source;
 * every other file part becomes the audio (first one wins, extras discarded —
 * legacy behavior preserved).
 */
export async function parseJobMultipart(
  req: import("fastify").FastifyRequest,
  ctx: AppContext,
): Promise<ParsedJobUpload> {
  const fields: Record<string, string> = {};
  let audio: { filename: string; type: string; tempPath: string } | null = null;
  let source: { filename: string; type: string; tempPath: string } | null = null;
  const tempPaths: string[] = [];

  try {
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname === "source") {
          if (!source) {
            const p = await saveMultipartToTemp(ctx, part.file);
            tempPaths.push(p);
            source = {
              filename: part.filename ?? "upload",
              type: part.mimetype ?? "application/octet-stream",
              tempPath: p,
            };
          } else {
            await drainStream(part.file); // extra document parts: discard
          }
        } else if (!audio) {
          const p = await saveMultipartToTemp(ctx, part.file);
          tempPaths.push(p);
          audio = {
            filename: part.filename ?? "upload",
            type: part.mimetype ?? "application/octet-stream",
            tempPath: p,
          };
        } else {
          await drainStream(part.file); // extra file parts: discard
        }
      } else if (part.fieldname) {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    for (const p of tempPaths) await rm(p);
    throw err;
  }

  return {
    fields,
    audio,
    source,
    cleanup: async () => {
      for (const p of tempPaths) await rm(p);
    },
  };
}

/**
 * Phase 3.1: validate a document upload and extract it to plain text.
 * Distinct error codes keep failures machine-readable:
 *   unsupported extension / empty file / traversal filename -> validation
 *   corrupted DOCX -> invalid_docx ; malformed SRT -> invalid_srt
 */
async function resolveDocumentSource(
  ctx: AppContext,
  source: { filename: string; type: string; tempPath: string },
): Promise<{ content: string; firstText: string | null }> {
  // Dotfiles (".srt") have no extension by path.extname rules; treat the stem
  // after the leading dot as the extension.
  const base = source.filename.split(/[\\/]/).pop() ?? source.filename;
  const ext = (path.extname(base) || (base.startsWith(".") && base.length > 1 ? base.slice(1) : ""))
    .replace(/^\./, "")
    .toLowerCase();
  if (!ctx.config.allowedDocumentExtensions.includes(ext)) {
    throw new ApiError(ApiCodes.validation, `unsupported document extension: .${ext}`, 400);
  }
  // Traversal defense: path components in an upload filename are never accepted.
  if (source.filename.includes("/") || source.filename.includes("\\")) {
    throw new ApiError(ApiCodes.validation, "invalid document filename", 400);
  }
  try {
    safeName(source.filename);
  } catch {
    throw new ApiError(ApiCodes.validation, "invalid document filename", 400);
  }
  const size = await sizeOf(source.tempPath);
  if (size === 0) {
    throw new ApiError(ApiCodes.validation, "document file is empty", 400);
  }
  if (size > ctx.config.maxUploadBytes) {
    throw new ApiError(ApiCodes.validation, "document file exceeds size limit", 413);
  }

  let firstText: string | null = null;
  let content: string;
  if (ext === "docx") {
    try {
      content = await extractDocxText(source.tempPath);
    } catch {
      throw new ApiError(
        ApiCodes.invalidDocx,
        "could not extract text from DOCX (corrupted or invalid file)",
        400,
      );
    }
  } else {
    // Preserve the original document verbatim (SRT keeps its timestamps);
    // only a UTF-8 BOM and surrounding whitespace are removed.
    const raw = readFileSync(source.tempPath, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    if (ext === "srt") {
      const parsed = parseSrt(raw);
      if (!parsed.ok) {
        throw new ApiError(ApiCodes.invalidSrt, `invalid SRT: ${parsed.reason}`, 400);
      }
      firstText = parsed.firstText;
    }
    content = raw;
  }

  if (content.trim() === "") {
    throw new ApiError(ApiCodes.validation, "document contains no text", 400);
  }
  const charCount = Array.from(content).length;
  if (charCount > ctx.config.maxTextChars) {
    throw new ApiError(ApiCodes.validation, "document text exceeds maximum length", 400, {
      maxTextChars: ctx.config.maxTextChars,
      charCount,
    });
  }
  return { content, firstText };
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
  const { fields, audio, source } = parsed;
  const idempotencyKey = opts.idempotencyKey ?? null;
  const tokenId = opts.tokenId ?? null;

  try {
    // Idempotent replay: same token + key -> same job, no new side effects.
    if (idempotencyKey && tokenId) {
      const existing = ctx.jobs.findByIdempotencyKey(tokenId, idempotencyKey);
      if (existing) return { job: existing, idempotentReplay: true };
    }

    if (audio && source) {
      throw new ApiError(
        ApiCodes.validation,
        "provide either an audio file or a source document (not both)",
        400,
      );
    }

    const prompt = (fields.prompt ?? "").trim();
    // A document source may omit the prompt (the versioned default master
    // prompt is used); the audio path keeps its existing "prompt required".
    if (!source && !prompt) {
      throw new ApiError(ApiCodes.validation, "prompt is required", 400);
    }

    const preferredAccountId = fields.preferredAccountId || null;
    const preferredNodeId = fields.preferredNodeId || null;

    // Reject an unknown account ID up front (clearer than a runner failure
    // later); the runner re-checks eligibility + a live verified session.
    if (preferredAccountId && !ctx.accounts.get(preferredAccountId)) {
      throw new ApiError(ApiCodes.notFound, "preferred account not found", 404);
    }

    // --- document source (Phase 3.1): txt/docx/srt -> text job -------------
    if (source) {
      const doc = await resolveDocumentSource(ctx, source);
      const docPrompt = prompt || resolveMasterPrompt(null).text;
      const title = deriveNotebookTitle(
        fields.title ?? null,
        cleanFilename(source.filename),
        doc.firstText ?? deriveTitleFromText(doc.content),
      );
      const language = detectLanguage(doc.content);
      const charCount = Array.from(doc.content).length;
      const sizeBytes = Buffer.byteLength(doc.content, "utf8");

      const job = ctx.jobs.create({
        input: {
          prompt: docPrompt,
          title,
          inputType: "text",
          audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
          text: {
            sha256: createHash("sha256").update(doc.content, "utf8").digest("hex"),
            sizeBytes,
            charCount,
            language,
            originalName: source.filename,
          },
          promptVersion: prompt ? "custom" : "v1",
          language: language ?? null,
          metadata: { language: language ?? null, customer: null, category: null },
          podcast: parsePodcastField(fields.podcast),
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

      try {
        const archive = new JobArchive(dataPaths(ctx.config.dataDir).jobsDir, job.id);
        archive.init({
          prompt: docPrompt,
          originalAudioName: null,
          audioMediaType: null,
          configSnapshot: job.configSnapshot,
          createdAt: job.createdAt,
          text: { charCount, sizeBytes, language },
        });
        archive.storeText(doc.content);
        ctx.jobs.appendEvent(
          job.id,
          "created",
          idempotencyKey
            ? "document job created and queued (idempotency key recorded)"
            : "document job created and queued",
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
    }

    // --- audio path (Phase 3.3: title = user override || cleaned filename) --
    // The notebook title comes from the user override when given, otherwise
    // from the cleaned audio filename (basename, extension stripped, -/_
    // normalized to spaces). Prompt-only jobs keep the legacy null title.
    const title = (fields.title ?? "").trim() || (audio ? cleanFilename(audio.filename) : null);

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
        inputType: "audio",
        audio: audioMeta,
        podcast: parsePodcastField(fields.podcast),
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
    // The temp uploads are copied into the archive; drop the temp copies.
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

/**
 * NLO-P2: parse the multipart `podcast` form field. The upload form carries
 * it as a string: "true"/"false"/"1"/"0" toggles, or a JSON object with
 * {enabled, instructions?, language?, format?, length?}. Anything malformed
 * is dropped to null (the job still runs as a plain audio job).
 */
function parsePodcastField(raw: string | undefined): Job["input"]["podcast"] {
  if (!raw) return null;
  const v = raw.trim();
  if (v === "true" || v === "1") return { enabled: true };
  if (v === "false" || v === "0") return { enabled: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.enabled !== "boolean") return null;
  const podcast: NonNullable<Job["input"]["podcast"]> = { enabled: p.enabled };
  if (typeof p.instructions === "string" && p.instructions.trim() !== "") {
    podcast.instructions = p.instructions;
  }
  if (p.language === "en" || p.language === "fa") podcast.language = p.language;
  if (
    p.format === "deep_dive" ||
    p.format === "brief" ||
    p.format === "critique" ||
    p.format === "debate"
  ) {
    podcast.format = p.format;
  }
  if (p.length === "short" || p.length === "default" || p.length === "long") {
    podcast.length = p.length;
  }
  return podcast;
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
