import { createHash } from "node:crypto";
import {
  ApiError,
  ApiCodes,
  deriveTitleFromText,
  detectLanguage,
  resolveMasterPrompt,
  type Job,
} from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import { JobArchive } from "../domain/archive.js";
import { dataPaths } from "../config.js";

/**
 * H1 (text-to-notebook): shared job-creation core for BOTH the legacy
 * `/api/notebooks/from-text` handler and the versioned
 * `/api/v1/notebooks/from-text` handler (same module => no drift).
 *
 * Mirrors createJobFromUpload's guarantees: idempotent replay, validation,
 * archive init + rollback on failure.
 * See docs/architecture/h1-text-to-notebook.md.
 */

export interface CreateJobFromTextBody {
  title?: string | null;
  text: string;
  metadata?: {
    language?: string | null;
    customer?: string | null;
    category?: string | null;
  } | null;
  summary?: { enabled?: boolean; prompt?: string | null } | null;
}

export async function createJobFromText(
  ctx: AppContext,
  body: CreateJobFromTextBody,
  opts: { idempotencyKey?: string | null; tokenId?: string | null } = {},
): Promise<{ job: Job; idempotentReplay: boolean }> {
  const idempotencyKey = opts.idempotencyKey ?? null;
  const tokenId = opts.tokenId ?? null;

  // Idempotent replay: same token + key -> same job, no new side effects.
  if (idempotencyKey && tokenId) {
    const existing = ctx.jobs.findByIdempotencyKey(tokenId, idempotencyKey);
    if (existing) return { job: existing, idempotentReplay: true };
  }

  // --- validation ---------------------------------------------------------
  const text = body.text ?? "";
  if (text.trim() === "") {
    throw new ApiError(ApiCodes.validation, "text is required", 400);
  }
  // Characters = code points (Persian text counts one per character).
  const charCount = Array.from(text).length;
  if (charCount > ctx.config.maxTextChars) {
    throw new ApiError(ApiCodes.validation, "text exceeds maximum length", 400, {
      maxTextChars: ctx.config.maxTextChars,
      charCount,
    });
  }

  // --- prompt (versioned) ---------------------------------------------------
  const summaryEnabled = body.summary?.enabled !== false;
  const promptResolution = resolveMasterPrompt(body.summary?.prompt ?? null);
  // summary.enabled=false -> the job creates notebook + source but runs NO
  // prompt (providers skip the ask step entirely).
  const prompt = summaryEnabled ? promptResolution.text : "";
  const promptVersion = summaryEnabled ? promptResolution.version : null;

  // --- title (resolved at creation; used for notebook + source titles) -----
  const title = (body.title ?? "").trim() || deriveTitleFromText(text);
  // Caller-declared language wins (normalized to fa/en); otherwise a
  // script-based hint (fa/en). Persisted as metadata — never appended to the
  // title.
  const language = normalizeLanguage(body.metadata?.language) ?? detectLanguage(text) ?? null;

  const job = ctx.jobs.create({
    input: {
      prompt,
      title,
      inputType: "text",
      language: language ?? null,
      audio: {
        originalName: "",
        mediaType: "",
        size: 0,
        sha256: "",
        providerConfirmed: false,
      },
      text: {
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
        sizeBytes: Buffer.byteLength(text, "utf8"),
        charCount,
        language,
      },
      promptVersion,
      metadata: {
        language: language ?? null,
        customer: body.metadata?.customer?.trim() || null,
        category: body.metadata?.category?.trim() || null,
      },
      preferredAccountId: null,
      preferredNodeId: null,
    },
    configSnapshot: {
      provider: ctx.provider.name,
      proxyRuntime: ctx.config.proxyRuntime,
      host: ctx.config.host,
      maxTextChars: ctx.config.maxTextChars,
    },
    idempotencyKey: idempotencyKey && tokenId ? idempotencyKey : null,
    tokenId: idempotencyKey && tokenId ? tokenId : null,
  });

  // Initialize the archive and store the text source (server-chosen name).
  try {
    const archive = new JobArchive(dataPaths(ctx.config.dataDir).jobsDir, job.id);
    archive.init({
      prompt,
      originalAudioName: null,
      audioMediaType: null,
      configSnapshot: job.configSnapshot,
      createdAt: job.createdAt,
      text: { charCount, sizeBytes: Buffer.byteLength(text, "utf8"), language },
    });
    archive.storeText(text);
    ctx.jobs.appendEvent(
      job.id,
      "created",
      idempotencyKey
        ? "text job created and queued (idempotency key recorded)"
        : "text job created and queued",
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

/** Normalize a caller-declared language hint to the known fa/en codes. */
function normalizeLanguage(v: string | null | undefined): "fa" | "en" | null {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "fa" || s === "en") return s;
  if (s === "fa-ir" || s === "persian") return "fa";
  if (s === "en-us" || s === "en-gb" || s === "english") return "en";
  return null;
}
