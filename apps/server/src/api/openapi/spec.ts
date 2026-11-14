import type { AppContext } from "../../app-context.js";

/**
 * OpenAPI 3.x document for the versioned API (C2).
 *
 * This is the OFFICIAL contract for `/api/v1`. It is served at
 * `/api/openapi.json` and `/api/v1/openapi.json` and rendered by Swagger at
 * `/api/docs`. It is built programmatically (not hand-maintained JSON) so the
 * version, the live provider identity, and the configured rate limits stay in
 * sync with the running process. A contract test in apps/server/test asserts
 * that every documented path+method exists on the live app AND that every
 * live v1 route is documented (no silent drift in either direction).
 *
 * Paths below are relative to `/api/v1` (OpenAPI `servers[0].url`).
 */

const ok = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", description: "Stable machine-readable code (ApiCodes)." },
        message: { type: "string", description: "Human-readable, already redacted." },
        details: { type: "object", additionalProperties: true, nullable: true },
      },
    },
  },
  description: "Standard error envelope.",
};

const bearer = [{ apiKeyAuth: [] }];

function jobObject() {
  return {
    type: "object",
    properties: {
      id: { type: "string", example: "j_0123456789abcdef0123456789abcdef" },
      status: {
        type: "string",
        enum: [
          "CREATED",
          "VALIDATING",
          "QUEUED",
          "WAITING_FOR_ACCOUNT",
          "WAITING_FOR_PROXY",
          "RUNNING",
          "SUCCEEDED",
          "FAILED",
          "CANCEL_REQUESTED",
          "CANCELLED",
          "RETRY_WAIT",
          "NEEDS_ATTENTION",
          "PROVIDER_CONFIRMED",
        ],
      },
      progress: { type: "integer", minimum: 0, maximum: 100 },
      input: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          title: { type: ["string", "null"] },
          preferredAccountId: { type: ["string", "null"] },
          preferredNodeId: { type: ["string", "null"] },
          audio: {
            type: "object",
            properties: {
              originalName: { type: "string" },
              mediaType: { type: "string" },
              size: { type: "integer" },
              sha256: { type: "string" },
              providerConfirmed: { type: "boolean" },
            },
          },
          text: {
            type: ["object", "null"],
            description: "Present for text-to-notebook jobs (H1): the stored text source.",
            properties: {
              sha256: { type: "string" },
              sizeBytes: { type: "integer" },
              charCount: { type: "integer" },
              language: { type: ["string", "null"] },
            },
          },
          promptVersion: {
            type: ["string", "null"],
            description:
              "Master-prompt version used for the summary (`v1`, or `custom` when the caller supplied its own prompt). Null when no summary was requested.",
          },
          metadata: {
            type: ["object", "null"],
            properties: {
              language: { type: ["string", "null"] },
              customer: { type: ["string", "null"] },
              category: { type: ["string", "null"] },
            },
          },
        },
      },
      idempotencyKey: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  };
}

function listEnvelope(inner: object) {
  return {
    type: "object",
    required: ["items", "total"],
    properties: {
      items: { type: "array", items: inner },
      total: { type: "integer" },
    },
  };
}

function idParam(name = "id") {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

function bearerParams() {
  return { security: bearer };
}

/** Build the live OpenAPI document. */
export function buildOpenApiDocument(ctx: AppContext): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "NotebookLM Orchestrator API",
      version: "1.0.0",
      summary: "Versioned REST API for creating, tracking and downloading NotebookLM jobs.",
      description: [
        "The official contract for `/api/v1`. Every request may be attributed to an API token",
        "(`Authorization: Bearer nlo_...`). When the server runs with auth enforcement enabled",
        "(NLO_API_AUTH=true) a valid token is required for all routes except the exempt GETs",
        "(health, openapi.json, docs). Errors use the standard envelope",
        '`{ "error": { "code", "message", "details?" } }`.',
      ].join("\n"),
    },
    servers: [{ url: "/api/v1", description: "Versioned API (this document)." }],
    tags: [
      { name: "jobs", description: "Job lifecycle: create, poll, download, cancel." },
      { name: "auth", description: "Auth sessions for the python-worker provider." },
      { name: "accounts", description: "Google account management." },
      { name: "proxies", description: "VLESS proxy node management + health." },
      { name: "meta", description: "Health, provider capability, settings, secrets." },
      { name: "tokens", description: "API token management (admin)." },
      {
        name: "orchestrator",
        description: "Cross-product RAG orchestration (radio RAG + NotebookLM).",
      },
      { name: "webhooks", description: "Webhook endpoint management + delivery log (admin)." },
    ],
    security: [],
    components: {
      securitySchemes: {
        apiKeyAuth: {
          type: "http",
          scheme: "bearer",
          description: "API token, prefixed `nlo_`. Create via POST /tokens (admin scope).",
        },
      },
      schemas: {
        ErrorEnvelope: errorSchema,
        Job: jobObject(),
        JobList: listEnvelope(jobObject()),
        ApiToken: {
          type: "object",
          properties: {
            id: { type: "string", example: "tok_0123456789abcdef01234567" },
            name: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
            lastUsedAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            revokedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        AuditEvent: {
          type: "object",
          properties: {
            id: { type: "integer" },
            at: { type: "string", format: "date-time" },
            tokenId: { type: ["string", "null"] },
            tokenName: { type: ["string", "null"] },
            action: { type: "string" },
            method: { type: "string" },
            path: { type: "string" },
            status: { type: "integer" },
            detail: { type: ["string", "null"] },
            ip: { type: ["string", "null"] },
          },
        },
        FromTextRequest: {
          type: "object",
          required: ["text"],
          properties: {
            title: {
              type: "string",
              maxLength: 200,
              description: "Notebook title. When omitted, derived from the first line of the text.",
            },
            text: {
              type: "string",
              minLength: 1,
              description:
                "Source text (non-empty). Must not exceed NLO_MAX_TEXT_CHARS (default 200000).",
            },
            metadata: {
              type: ["object", "null"],
              properties: {
                language: { type: "string", maxLength: 32 },
                customer: { type: "string", maxLength: 200 },
                category: { type: "string", maxLength: 200 },
              },
            },
            summary: {
              type: ["object", "null"],
              properties: {
                enabled: { type: "boolean", default: true },
                prompt: {
                  type: "string",
                  maxLength: 20000,
                  description:
                    "Custom summary prompt. When omitted, the versioned master prompt (default v1) is used.",
                },
              },
            },
          },
        },
        FromTextResponse: {
          type: "object",
          required: ["jobId", "status", "createdAt", "statusUrl"],
          properties: {
            jobId: { type: "string", example: "j_0123456789abcdef0123456789abcdef" },
            status: { type: "string" },
            correlationId: {
              type: ["string", "null"],
              description:
                "Present on /api/v1 (supplied or generated cr_<32hex>); null on the legacy /api surface.",
            },
            createdAt: { type: "string", format: "date-time" },
            statusUrl: { type: "string", description: "URL to poll for job status." },
          },
        },
        JobResult: {
          type: "object",
          required: ["jobId", "status", "notebook", "source", "summary", "provenance", "artifacts"],
          properties: {
            jobId: { type: "string" },
            status: { type: "string" },
            notebook: {
              type: ["object", "null"],
              description:
                "Present (non-null) only for SUCCEEDED jobs with a confirmed notebook id.",
              properties: {
                id: { type: "string" },
                title: { type: ["string", "null"] },
                url: {
                  type: ["string", "null"],
                  description:
                    "Only when the provider confirmed it; never fabricated (null today).",
                },
                shareUrl: {
                  type: ["string", "null"],
                  description:
                    "Only when the provider confirmed it; never fabricated (null today).",
                },
              },
            },
            source: {
              type: ["object", "null"],
              description: "Present only for SUCCEEDED jobs with a confirmed source id.",
              properties: { id: { type: "string" } },
            },
            summary: {
              type: ["object", "null"],
              description:
                "Present for SUCCEEDED jobs; text is null when no summary prompt was run.",
              properties: {
                text: { type: ["string", "null"] },
                promptVersion: { type: ["string", "null"] },
              },
            },
            provenance: {
              type: "string",
              enum: ["real", "mock", "unknown"],
              description:
                "Where the result came from: a real provider run, the mock provider, or unconfirmed.",
            },
            artifacts: {
              type: "array",
              description: "Stored output artifacts (podcast audio, MP3 variants).",
              items: { $ref: "#/components/schemas/Artifact" },
            },
          },
        },
        Artifact: {
          type: "object",
          description:
            "A stored artifact with metadata verified by NLO at write time (null = not reported, never guessed).",
          required: ["id", "filename", "mediaType", "size", "source", "createdAt", "downloadUrl"],
          properties: {
            id: { type: "string", example: "art_0123456789abcdef" },
            filename: { type: "string" },
            mediaType: { type: "string", example: "audio/wav" },
            size: { type: "integer", minimum: 0 },
            source: { type: "string", enum: ["provider", "application"] },
            durationSeconds: { type: ["number", "null"] },
            codec: { type: ["string", "null"] },
            sampleRate: { type: ["integer", "null"] },
            channels: { type: ["integer", "null"] },
            bitrate: { type: ["integer", "null"] },
            sourceArtifactId: {
              type: ["string", "null"],
              description:
                "For application-produced artifacts: the artifact they were derived from.",
            },
            sha256: {
              type: ["string", "null"],
              description: "SHA-256 of the stored file, when verified.",
            },
            provenance: { type: ["string", "null"], enum: ["real", "mock", "unknown", null] },
            createdAt: { type: "string", format: "date-time" },
            downloadUrl: {
              type: "string",
              description: "Canonical download endpoint for this artifact.",
            },
          },
        },
        WebhookEndpoint: {
          type: "object",
          description:
            "A webhook delivery target. The HMAC signing secret is stored in the vault; the plaintext is returned exactly once (create/rotate).",
          required: [
            "id",
            "name",
            "url",
            "hasSecret",
            "events",
            "enabled",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string", example: "whk_0123456789abcdef" },
            name: { type: "string", minLength: 1, maxLength: 64 },
            url: { type: "string", format: "uri", description: "http(s) delivery URL." },
            hasSecret: { type: "boolean" },
            events: {
              type: "array",
              description: "Event filter; empty = all events.",
              items: {
                type: "string",
                enum: [
                  "job.created",
                  "job.running",
                  "job.succeeded",
                  "job.failed",
                  "job.cancelled",
                  "job.needs_attention",
                ],
              },
            },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        WebhookDelivery: {
          type: "object",
          description: "One outbox delivery. The log never exposes payloads or signing secrets.",
          required: ["id", "eventType", "status", "attempts", "createdAt"],
          properties: {
            id: { type: "string", example: "dlv_0123456789abcdef" },
            jobId: { type: ["string", "null"] },
            eventType: { type: "string", example: "job.succeeded" },
            status: { type: "string", enum: ["pending", "delivered", "dead"] },
            attempts: { type: "integer", minimum: 0 },
            lastStatus: { type: ["integer", "null"] },
            lastError: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
            lastAttemptAt: { type: ["string", "null"], format: "date-time" },
            deliveredAt: { type: ["string", "null"], format: "date-time" },
            deadAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        OrchestratorAskRequest: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 1, maxLength: 2000 },
            variant: {
              type: "string",
              enum: ["06b", "4b", "rrf"],
              default: "06b",
              description: "Radio RAG retrieval variant.",
            },
            notebooklm: {
              type: ["object", "null"],
              properties: {
                enabled: { type: "boolean", default: true },
                collection: {
                  type: ["string", "null"],
                  maxLength: 200,
                  description:
                    "Recorded in the notebook job metadata. When omitted, the top citation's real collection is used (never fabricated).",
                },
              },
            },
          },
        },
        OrchestratorAskResponse: {
          type: "object",
          required: [
            "question",
            "answer",
            "selected_variant",
            "trace_id",
            "collection",
            "sources",
            "notebooklm",
            "timings",
          ],
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
            selected_variant: { type: "string", enum: ["06b", "4b", "rrf"] },
            trace_id: {
              type: ["string", "null"],
              description:
                "Real trace id from the radio RAG API (uuid4 hex); null when the API did not report one.",
            },
            collection: {
              type: ["string", "null"],
              description:
                "Real collection value from the radio RAG API; null when no citation reported one.",
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "integer" },
                  source_id: { type: ["string", "null"] },
                  title: { type: ["string", "null"] },
                  url: { type: ["string", "null"] },
                  date: { type: ["string", "null"] },
                  relevant_text: { type: ["string", "null"] },
                  score: { type: ["number", "null"] },
                  rrf_score: { type: ["number", "null"] },
                  collection: { type: ["string", "null"] },
                },
              },
            },
            notebooklm: {
              type: "object",
              required: ["jobId", "status", "timedOut"],
              properties: {
                jobId: { type: ["string", "null"] },
                status: { type: ["string", "null"] },
                timedOut: { type: "boolean" },
                notebook: {
                  type: ["object", "null"],
                  properties: {
                    id: { type: "string" },
                    title: { type: ["string", "null"] },
                    url: { type: ["string", "null"] },
                    shareUrl: { type: ["string", "null"] },
                  },
                },
                source: { type: ["object", "null"], properties: { id: { type: "string" } } },
                summary: {
                  type: ["object", "null"],
                  properties: {
                    text: { type: ["string", "null"] },
                    promptVersion: { type: ["string", "null"] },
                  },
                },
                provenance: { type: "string", enum: ["real", "mock", "unknown"] },
                statusUrl: { type: ["string", "null"] },
              },
            },
            timings: {
              type: "object",
              properties: {
                radioMs: { type: "integer" },
                notebookMs: { type: ["integer", "null"] },
                totalMs: { type: "integer" },
              },
            },
          },
        },
      },
    },
    paths: {
      // ---------------- contract (self-describing) ----------------
      "/openapi.json": {
        get: {
          tags: ["meta"],
          summary: "This OpenAPI document (auth-exempt; also served at /api/openapi.json).",
          responses: { "200": jsonResponse("OpenAPI 3.x document.") },
        },
      },
      "/docs": {
        get: {
          tags: ["meta"],
          summary: "Swagger UI (auth-exempt; also served at /api/docs).",
          responses: {
            "200": {
              description: "Swagger UI page.",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },

      // ---------------- jobs ----------------
      "/jobs": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "List jobs (filtered, paginated).",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "accountId", in: "query", schema: { type: "string" } },
            { name: "nodeId", in: "query", schema: { type: "string" } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
          ],
          responses: {
            "200": {
              description: "Job list.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/JobList" } } },
            },
            "401": errorResponse("unauthorized"),
          },
        },
        post: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Create a job (multipart: prompt + optional audio).",
          description:
            "Send `Idempotency-Key` (8-128 chars of [A-Za-z0-9._-]) with a valid token to make the create replayable; a replay returns the original job with 200 and `x-idempotent-replay: true`.",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", pattern: "^[A-Za-z0-9._-]{8,128}$" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    title: { type: "string" },
                    preferredAccountId: { type: "string" },
                    preferredNodeId: { type: "string" },
                    audio: { type: "string", format: "binary" },
                  },
                  required: ["prompt"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Job created (or replayed with 200 on idempotent re-post).",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, status: { type: "string" } },
                  },
                },
              },
            },
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/notebooks/from-text": {
        post: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Create a text-to-notebook job (H1) from raw text.",
          description:
            "Creates an async job that stores the text, creates/reuses a NotebookLM notebook named after the job title, and adds the text as a source (real mechanism: notebooklm-py `sources.add_text`). When `summary.prompt` is omitted, a versioned master prompt (default `v1`) is used; when `summary.enabled` is false, no summary prompt is executed. Text longer than NLO_MAX_TEXT_CHARS (default 200000 characters) is rejected with 400. Send `Idempotency-Key` (8-128 chars of [A-Za-z0-9._-]) with a valid token to make the create replayable; a replay returns the original job with 200 and `x-idempotent-replay: true`.",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", pattern: "^[A-Za-z0-9._-]{8,128}$" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/FromTextRequest" } },
            },
          },
          responses: {
            "202": {
              description: "Job accepted and queued; poll via `statusUrl`.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/FromTextResponse" } },
              },
            },
            "200": {
              description:
                "Idempotent replay of an earlier create with the same key (x-idempotent-replay: true).",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/FromTextResponse" } },
              },
            },
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/orchestrator/ask": {
        post: {
          tags: ["orchestrator"],
          ...bearerParams(),
          summary:
            "Radio-ma'arif RAG orchestrator: one question -> RAG answer + NotebookLM consolidation.",
          description:
            'Calls the radio RAG v1 API (POST /api/v1/chat/completions, variant from the body) and returns the answer with the real 12-field contract values (trace_id, collection, rrf_score, ranked cited sources). When notebooklm.enabled (default true), the Q&A transcript is also stored as a real text-to-notebook job on this server and polled until a terminal state or NLO_ORCH_NLO_TIMEOUT_MS; a timeout does not fail the request — the notebooklm section then carries the job id, current status and timedOut=true. Errors: 503 runtime_not_configured when NLO_RADIO_TOKEN is not set; 502 provider_unavailable when the radio RAG API is unreachable or errors (details.stage="radio").',
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OrchestratorAskRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Consolidated answer (radio RAG + optional NotebookLM job).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/OrchestratorAskResponse" },
                },
              },
            },
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "429": errorResponse("rate_limited"),
            "502": errorResponse("provider_unavailable"),
            "503": errorResponse("runtime_not_configured"),
          },
        },
      },
      "/jobs/{id}": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Get a job by id.",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "Job.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
            },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/result": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Get the structured result of a job (notebook + source + summary + provenance).",
          description:
            "Returns the provider-confirmed notebook/source identities, the summary answer with the prompt version used, and the result provenance. `notebook.url`/`shareUrl` are present only when the provider actually confirmed them (never fabricated; null today). For a job that has not SUCCEEDED, the fields are null and `status` reflects the current state.",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "Job result.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/JobResult" } },
              },
            },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/events": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Job event trail.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Event list."), "404": errorResponse("not_found") },
        },
      },
      "/jobs/{id}/attempts": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Provider attempt history for a job.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Attempt history."), "404": errorResponse("not_found") },
        },
      },
      "/jobs/{id}/artifacts": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "List downloadable artifacts for a job.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Artifact list (no file bodies)."),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/artifacts/{artifactId}": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Download one artifact (octet-stream).",
          parameters: [idParam(), idParam("artifactId")],
          responses: {
            "200": {
              description: "File bytes.",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/artifacts/{artifactId}/download": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary:
            "Download a stored artifact (canonical endpoint). Token-owned artifacts require the owning token or an admin token (403 otherwise).",
          parameters: [idParam("artifactId")],
          responses: {
            "200": {
              description:
                "File bytes with content-type, content-length and an attachment content-disposition.",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/audio": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Stream the job's input audio (inline).",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "Audio bytes.",
              content: { "audio/wav": { schema: { type: "string", format: "binary" } } },
            },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/audio/download": {
        get: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Download the job's input audio (attachment).",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "Audio bytes.",
              content: { "audio/wav": { schema: { type: "string", format: "binary" } } },
            },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/jobs/{id}/cancel": {
        post: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Cancel a job (state-aware).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Cancel result."),
            "404": errorResponse("not_found"),
            "409": errorResponse("invalid_state_transition"),
          },
        },
      },
      "/jobs/{id}/requeue": {
        post: {
          tags: ["jobs"],
          ...bearerParams(),
          summary: "Re-queue a NEEDS_ATTENTION job.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Requeue result."),
            "404": errorResponse("not_found"),
            "409": errorResponse("invalid_state_transition"),
          },
        },
      },

      // ---------------- auth sessions ----------------
      "/sessions": {
        get: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "List auth sessions (per account).",
          responses: {
            "200": jsonResponse("Session overview."),
            "401": errorResponse("unauthorized"),
          },
        },
      },
      "/sessions/{id}": {
        get: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Get one auth session.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Session view."), "404": errorResponse("not_found") },
        },
        delete: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Log out / delete a session.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("ok"), "404": errorResponse("not_found") },
        },
      },
      "/sessions/{id}/login": {
        post: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Interactive browser login (python-worker).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Authenticated session."),
            "401": errorResponse("unauthorized"),
            "409": errorResponse("conflict"),
          },
        },
      },
      "/sessions/{id}/browser-import": {
        post: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Import a signed-in browser's cookies and verify.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Authenticated session."),
            "401": errorResponse("unauthorized"),
            "409": errorResponse("conflict"),
          },
        },
      },
      "/sessions/{id}/verify": {
        post: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Verify the stored session against the real service.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Verification result."),
            "401": errorResponse("unauthorized"),
          },
        },
      },
      "/sessions/{id}/refresh": {
        post: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Refresh the stored session (same check as verify; the service decides).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Verification result."),
            "401": errorResponse("unauthorized"),
          },
        },
      },
      "/sessions/{id}/import": {
        post: {
          tags: ["auth"],
          ...bearerParams(),
          summary: "Import a Playwright storage-state JSON (base64 or serverPath).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Import + verify result."),
            "400": errorResponse("validation"),
          },
        },
      },

      // ---------------- accounts ----------------
      "/accounts": {
        get: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "List Google accounts.",
          responses: { "200": jsonResponse("Account list (secrets masked).") },
        },
        post: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Create an account.",
          responses: {
            "201": jsonResponse("Account created."),
            "400": errorResponse("validation"),
          },
        },
      },
      "/accounts/{id}": {
        get: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Get an account.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Account."), "404": errorResponse("not_found") },
        },
        patch: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Update an account.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Account updated."), "404": errorResponse("not_found") },
        },
        delete: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Delete an account (removes its stored session file).",
          parameters: [idParam()],
          responses: { "204": { description: "Deleted." }, "404": errorResponse("not_found") },
        },
      },
      "/accounts/{id}/default": {
        post: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Set/clear the default account.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Account."), "404": errorResponse("not_found") },
        },
      },
      "/accounts/{id}/health": {
        post: {
          tags: ["accounts"],
          ...bearerParams(),
          summary: "Provider-backed account health check.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Health + account."),
            "404": errorResponse("not_found"),
          },
        },
      },

      // ---------------- proxies ----------------
      "/proxies": {
        get: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "List proxy nodes (masked) with last health.",
          responses: { "200": jsonResponse("Node list.") },
        },
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Add a node from a vless:// URI (UUID vaulted).",
          responses: {
            "201": jsonResponse("Node created (masked)."),
            "400": errorResponse("validation"),
          },
        },
      },
      "/proxies/manual": {
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Add a node from explicit fields (UUID vaulted).",
          responses: {
            "201": jsonResponse("Node created (masked)."),
            "400": errorResponse("validation"),
          },
        },
      },
      "/proxies/ping-all": {
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Health-check all nodes (bounded concurrency).",
          responses: { "200": jsonResponse("Per-node results.") },
        },
      },
      "/proxies/runtime": {
        get: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Proxy runtime availability status.",
          responses: { "200": jsonResponse("Runtime status.") },
        },
      },
      "/proxies/{id}": {
        get: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Get one node (masked) with health history.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Node + health."), "404": errorResponse("not_found") },
        },
        patch: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Update one node.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Node (masked)."), "404": errorResponse("not_found") },
        },
        delete: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Delete a node (removes its vaulted secret if unreferenced).",
          parameters: [idParam()],
          responses: { "204": { description: "Deleted." }, "404": errorResponse("not_found") },
        },
      },
      "/proxies/{id}/validate": {
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Validate node config (no network).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Validation result."),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/proxies/{id}/health": {
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Staged health check (config -> tunnel -> real fetch).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Node + check result."),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/proxies/{id}/connectivity": {
        post: {
          tags: ["proxies"],
          ...bearerParams(),
          summary: "Connectivity test through the tunnel.",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Connectivity result."),
            "404": errorResponse("not_found"),
            "503": errorResponse("runtime_not_configured"),
          },
        },
      },

      // ---------------- meta ----------------
      "/health": {
        get: {
          tags: ["meta"],
          summary: "Liveness (auth-exempt).",
          responses: { "200": { description: "ok", content: jsonContent(ok) } },
        },
      },
      "/health/ready": {
        get: {
          tags: ["meta"],
          summary: "Readiness: provider + proxy runtime state (auth-exempt).",
          responses: { "200": jsonResponse("Ready report.") },
        },
      },
      "/health/account": {
        post: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "Provider account health probe.",
          responses: { "200": jsonResponse("Status."), "400": errorResponse("validation") },
        },
      },
      "/health/egress": {
        post: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "SSRF-guarded allowlist reachability check.",
          responses: {
            "200": jsonResponse("Allowlist entry + note."),
            "400": errorResponse("ssrf_blocked"),
          },
        },
      },
      "/provider": {
        get: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "Provider identity + honest capability matrix.",
          responses: {
            "200": {
              description: "Provider info.",
              content: jsonContent({
                type: "object",
                properties: {
                  name: { type: "string", example: ctx.provider.name },
                  isMock: { type: "boolean" },
                  liveDisabled: { type: "boolean" },
                  configured: { type: "boolean" },
                  capabilities: { type: "object" },
                },
              }),
            },
          },
        },
      },
      "/settings": {
        get: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "Read runtime settings.",
          responses: { "200": jsonResponse("Settings + defaults.") },
        },
        put: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "Update whitelisted runtime settings.",
          responses: { "200": jsonResponse("Updated keys."), "400": errorResponse("validation") },
        },
      },
      "/secrets": {
        get: {
          tags: ["meta"],
          ...bearerParams(),
          summary: "Secret inventory (refs masked; never values).",
          responses: { "200": jsonResponse("Masked secret refs.") },
        },
      },

      // ---------------- tokens (admin) ----------------
      "/tokens": {
        get: {
          tags: ["tokens"],
          ...bearerParams(),
          summary: "List API tokens (admin).",
          responses: {
            "200": {
              description: "Tokens (non-secret fields only).",
              content: jsonContent(listEnvelope({ $ref: "#/components/schemas/ApiToken" })),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
          },
        },
        post: {
          tags: ["tokens"],
          ...bearerParams(),
          summary: "Create an API token (admin). Plaintext returned once.",
          responses: {
            "201": {
              description: "Token + one-time plaintext.",
              content: jsonContent({
                type: "object",
                properties: {
                  token: { $ref: "#/components/schemas/ApiToken" },
                  plaintext: { type: "string" },
                  note: { type: "string" },
                },
              }),
            },
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
          },
        },
      },
      "/tokens/{id}": {
        patch: {
          tags: ["tokens"],
          ...bearerParams(),
          summary: "Enable/disable a token (admin).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Updated token."),
            "400": errorResponse("validation"),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          tags: ["tokens"],
          ...bearerParams(),
          summary: "Revoke a token (admin).",
          parameters: [idParam()],
          responses: {
            "200": jsonResponse("Revocation result."),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/audit": {
        get: {
          tags: ["tokens"],
          ...bearerParams(),
          summary: "Query the audit trail (admin).",
          parameters: [
            { name: "tokenId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
          ],
          responses: {
            "200": {
              description: "Audit events (newest first).",
              content: jsonContent(listEnvelope({ $ref: "#/components/schemas/AuditEvent" })),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
          },
        },
      },
      // ---------------- webhooks (admin) ----------------
      "/webhooks": {
        get: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary: "List webhook endpoints (admin).",
          responses: {
            "200": {
              description: "Endpoints (never include the secret value).",
              content: jsonContent(listEnvelope({ $ref: "#/components/schemas/WebhookEndpoint" })),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
          },
        },
        post: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary:
            "Create a webhook endpoint (admin). The signing secret is returned exactly once.",
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              required: ["name", "url"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 64 },
                url: { type: "string", format: "uri" },
                secret: {
                  type: "string",
                  minLength: 16,
                  maxLength: 128,
                  description: "HMAC-SHA256 secret; generated when omitted.",
                },
                events: { type: "array", items: { type: "string" } },
              },
            }),
          },
          responses: {
            "201": {
              description: "Created endpoint, with the one-time `secret` field.",
              content: jsonContent({
                type: "object",
                required: [
                  "id",
                  "name",
                  "url",
                  "hasSecret",
                  "events",
                  "enabled",
                  "createdAt",
                  "updatedAt",
                ],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  url: { type: "string" },
                  hasSecret: { type: "boolean" },
                  events: { type: "array", items: { type: "string" } },
                  enabled: { type: "boolean" },
                  secret: { type: "string", description: "One-time plaintext signing secret." },
                  createdAt: { type: "string", format: "date-time" },
                  updatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "409": errorResponse("conflict"),
          },
        },
      },
      "/webhooks/{id}": {
        get: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary: "Get one webhook endpoint (admin).",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "The endpoint.",
              content: jsonContent({ $ref: "#/components/schemas/WebhookEndpoint" }),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary:
            "Update a webhook endpoint (admin). Supplying `secret` rotates it (returned once).",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              properties: {
                name: { type: "string", minLength: 1, maxLength: 64 },
                url: { type: "string", format: "uri" },
                secret: { type: "string", minLength: 16, maxLength: 128 },
                events: { type: "array", items: { type: "string" } },
                enabled: { type: "boolean" },
              },
            }),
          },
          responses: {
            "200": jsonResponse("Updated endpoint (secret included only when rotated)."),
            "400": errorResponse("validation"),
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary: "Delete a webhook endpoint (admin; also removes its vault secret).",
          parameters: [idParam()],
          responses: {
            "204": { description: "Deleted." },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/webhooks/{id}/deliveries": {
        get: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary: "Delivery log for an endpoint (admin; no payloads, no secrets).",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "Newest-first delivery rows.",
              content: jsonContent(listEnvelope({ $ref: "#/components/schemas/WebhookDelivery" })),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/webhooks/{id}/test": {
        post: {
          tags: ["webhooks"],
          ...bearerParams(),
          summary: "Enqueue a manual test delivery (admin).",
          parameters: [idParam()],
          responses: {
            "202": {
              description: "Queued.",
              content: jsonContent({
                type: "object",
                required: ["ok", "deliveryId"],
                properties: { ok: { type: "boolean" }, deliveryId: { type: "string" } },
              }),
            },
            "401": errorResponse("unauthorized"),
            "403": errorResponse("forbidden"),
            "404": errorResponse("not_found"),
          },
        },
      },
    },
  };
}

/** A 4xx/5xx response in the standard error envelope. */
function errorResponse(code: string) {
  return {
    description: `Error: ${code}`,
    content: jsonContent(errorSchema),
    examples: {
      [code]: {
        value: { error: { code, message: "see ApiCodes for the stable code" } },
      },
    },
  };
}

function jsonResponse(description: string) {
  return { description, content: jsonContent({ type: "object" }) };
}

function jsonContent(schema: object) {
  return { "application/json": { schema } };
}
