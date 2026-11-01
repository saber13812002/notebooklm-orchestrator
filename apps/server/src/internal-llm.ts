import type { AppConfig } from "./config.js";

/**
 * Minimal client for the internal LLM proxy (LiteLLM, OpenAI-compatible).
 *
 * Endpoint-migration addendum Phase E (server s52 → 172.30.0.133): the target
 * of every call is `config.internalApiBaseUrl` — `NLO_INTERNAL_API_BASE_URL`,
 * verified 2026-11-01 as `http://172.30.0.133:4000` (LiteLLM v1.101.0). The
 * legacy host 172.20.1.52 (s52) is decommissioned and must never be the
 * target of a request; this module has no hardcoded host at all — the base
 * URL comes exclusively from config.
 *
 * Security invariants:
 * - Only paths under `/v1/...` are accepted (OpenAI-compatible surface).
 * - Error messages contain ONLY the target host, HTTP status, and the
 *   upstream `error.message` string — never the API key, never a stack.
 */

export type LlmErrorCode = "llm_unreachable" | "llm_error" | "llm_timeout";

export type LlmResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; code: LlmErrorCode; message: string; status?: number };

export interface LlmRequestOptions {
  /** Absolute path on the proxy, e.g. "/v1/models". Must start with /v1. */
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** When provided, sent as `Authorization: Bearer <key>`. Never logged. */
  apiKey?: string;
  /** Per-request timeout in ms (default: 15000). */
  timeoutMs?: number;
}

export interface InternalLlmClient {
  request<T = unknown>(opts: LlmRequestOptions): Promise<LlmResult<T>>;
  /** GET /v1/models — convenience wrapper. */
  listModels(apiKey?: string): Promise<LlmResult<unknown>>;
}

/** OpenAI-style error body; only `message` is surfaced by the client. */
interface OpenAiErrorBody {
  error?: { message?: unknown };
}

const PATH_RE = /^\/v1(?:\/[A-Za-z0-9._~-]+)+$/;

function buildUrl(base: string, path: string): URL | null {
  if (path.includes("..") || !PATH_RE.test(path)) return null;
  try {
    return new URL(path, base);
  } catch {
    return null;
  }
}

export function createInternalLlmClient(config: AppConfig): InternalLlmClient {
  const base = config.internalApiBaseUrl;

  async function request<T = unknown>(opts: LlmRequestOptions): Promise<LlmResult<T>> {
    const url = buildUrl(base, opts.path);
    if (!url) {
      return {
        ok: false,
        code: "llm_error",
        message: `invalid internal LLM path: ${opts.path} (only /v1/... paths are allowed)`,
      };
    }

    const timeoutMs = opts.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? "llm_timeout" : "llm_unreachable",
        message: aborted
          ? `internal LLM proxy ${url.host} did not respond within ${timeoutMs}ms`
          : `internal LLM proxy ${url.host} is unreachable`,
      };
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null; // non-JSON body; keep null
    }

    if (!res.ok) {
      let detail = "";
      if (parsed !== null) {
        const m = (parsed as OpenAiErrorBody)?.error?.message;
        if (typeof m === "string" && m.length > 0) detail = `: ${m}`;
      }
      return {
        ok: false,
        code: "llm_error",
        status: res.status,
        message: `internal LLM proxy ${url.host} responded ${res.status}${detail}`,
      };
    }

    return { ok: true, status: res.status, data: parsed as T };
  }

  return {
    request,
    listModels: (apiKey?: string) => request<unknown>({ path: "/v1/models", apiKey }),
  };
}
