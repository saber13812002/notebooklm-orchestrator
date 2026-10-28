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
