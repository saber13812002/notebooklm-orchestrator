import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import type { ApiTokenRow } from "../domain/api-tokens.repo.js";
import "./request-augment.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerProxyRoutes } from "./routes/proxies.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerTokenRoutes, registerAuditRoutes } from "./routes/tokens.js";
import { buildOpenApiDocument } from "./openapi/spec.js";

/**
 * The versioned, productized API surface: `/api/v1/*`.
 *
 *  - Every legacy `/api/*` route module is registered a SECOND time under
 *    `/api/v1` (same handlers, `base`-parameterized — the two surfaces
 *    cannot drift in behavior) plus the new product routes (tokens, audit).
 *  - Auth: `Authorization: Bearer nlo_...` is RESOLVED on every v1 request.
 *    When `config.apiAuthEnforced` is true, a valid token is REQUIRED
 *    (health/openapi/docs GETs are exempt); when false it is OPTIONAL and
 *    used for attribution, scoping, rate limiting and idempotency. The
 *    legacy loopback surface is unaffected either way.
 *  - Rate limiting: per-token sliding window ON TOP of the global per-IP
 *    limit, so one chatty consumer cannot starve the loopback UI.
 *  - Audit: every token-attributed v1 request appends a redacted row
 *    (never the token value; token id + name only).
 *  - Correlation: `x-correlation-id` is generated (or echoed) per request.
 *
 * NOTE: the v1 group is a child encapsulation WITHOUT a Fastify `prefix`
 * (route modules are re-registered with the `/api/v1` base directly). That
 * keeps `req.url` in its true incoming form for the hooks — verified
 * behavior, since `prefix` + `rewriteUrl` do not remap already-registered
 * routes.
 */

/** Per-token sliding-window rate limiter (in-memory; per-process). */
export class TokenRateLimiter {
  private readonly windows = new Map<string, number[]>();

  /** Returns true when the token may proceed; false when over budget. */
  allow(tokenId: string, max: number, windowMs: number, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    const prev = (this.windows.get(tokenId) ?? []).filter((t) => t > cutoff);
    if (prev.length >= max) {
      this.windows.set(tokenId, prev);
      return false;
    }
    prev.push(now);
    this.windows.set(tokenId, prev);
    return true;
  }

  /** Drop stale windows (called opportunistically). */
  prune(now = Date.now()): void {
    for (const [k, v] of this.windows) {
      const live = v.filter((t) => t > now - 5 * 60_000);
      if (live.length === 0) this.windows.delete(k);
      else this.windows.set(k, live);
    }
  }

  /** Test hook: clear all windows (in-memory state is per-process). */
  reset(): void {
    this.windows.clear();
  }
}

export const rateLimiter = new TokenRateLimiter();

const V1 = "/api/v1";

/** Extract the raw bearer token, if any. */
export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

function correlationIdFor(req: FastifyRequest): string {
  const incoming = req.headers["x-correlation-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return `cr_${randomUUID().replace(/-/g, "")}`;
}

/** Map an incoming URL to the versioned path (no /api/v1 prefix, no query). */
function v1Path(url: string): string {
  const p = url.split("?")[0] ?? "/";
  const rel = p.startsWith(V1) ? p.slice(V1.length) : p;
  return rel || "/";
}

/**
 * Scope required for a v1 method+path (path is the versioned form, e.g.
 * `/jobs/123/cancel`). Conservative default: unknown shapes need `admin`.
 */
function requiredScope(method: string, path: string): string {
  if (path === "/tokens" || path.startsWith("/tokens/") || path === "/audit") return "admin";
  if (path.startsWith("/sessions") || path.startsWith("/accounts") || path.startsWith("/proxies")) {
    return "admin";
  }
  if (method === "PUT" && path === "/settings") return "admin";
  if (
    method === "GET" &&
    (path === "/settings" ||
      path === "/secrets" ||
      path === "/provider" ||
      path === "/health" ||
      path === "/health/ready")
  ) {
    return "meta:read";
  }
  if (method === "POST" && (path === "/health/account" || path === "/health/egress")) {
    return "meta:read";
  }
  if (method === "GET") {
    if (/^\/jobs\/[^/]+\/artifacts\/[^/]+$/.test(path)) return "jobs:download";
    if (/^\/jobs\/[^/]+\/audio(\/download)?$/.test(path)) return "jobs:download";
    return "jobs:read";
  }
  if (method === "POST") {
    if (path === "/jobs") return "jobs:write";
    if (path.endsWith("/cancel")) return "jobs:cancel";
    if (path.endsWith("/requeue")) return "jobs:write";
    return "admin";
  }
  return "admin";
}

/** `admin` implies every other scope. */
function hasScope(token: ApiTokenRow, scope: string): boolean {
  if (token.scopes.includes("admin")) return true;
  return token.scopes.includes(scope);
}

/** Paths that never require a token, even when enforcement is on. */
function isExempt(method: string, path: string): boolean {
  return (
    method === "GET" &&
    (path === "/health" || path === "/health/ready" || path === "/openapi.json" || path === "/docs")
  );
}

/** Append a redacted audit row (best-effort; never throws). */
function audit(
  req: FastifyRequest,
  ctx: AppContext,
  token: ApiTokenRow | null,
  action: string,
  status: number,
  detail: string | null,
): void {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined) ?? req.ip ?? null;
    ctx.apiTokens.audit({
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
      action,
      method: req.method,
      path: req.url.split("?")[0] ?? "/",
      status,
      detail,
      ip,
    });
  } catch {
    // audit must never break the request path
  }
}

export async function registerV1Routes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // OpenAPI document + Swagger UI (versioned copies too). These are static
  // and exempt from auth: the contract itself must be inspectable.
  app.get("/api/openapi.json", async () => buildOpenApiDocument(ctx));
  app.get(`${V1}/openapi.json`, async () => buildOpenApiDocument(ctx));
  app.get("/api/docs", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(swaggerHtml()),
  );
  app.get(`${V1}/docs`, async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(swaggerHtml()),
  );

  // The versioned group: hooks + all route modules re-registered under /api/v1.
  await app.register(async (instance) => {
    instance.addHook("onRequest", async (req, reply) => {
      // Correlation id (always on v1; echoed when the client supplies one).
      const cid = correlationIdFor(req);
      req.correlationId = cid;
      reply.header("x-correlation-id", cid);

      const path = v1Path(req.url);

      // Resolve the token (unknown/revoked/disabled => "no valid token").
      const raw = bearerToken(req);
      let token: ApiTokenRow | null = null;
      if (raw) {
        token = ctx.apiTokens.resolve(raw);
        if (!token && ctx.config.apiAuthEnforced) {
          req.apiAuditRecorded = true;
          audit(req, ctx, null, "auth_failed", 401, "invalid_or_revoked_token");
          throw new ApiError(ApiCodes.unauthorized, "invalid or revoked API token", 401);
        }
      }
      req.apiToken = token;
      req.apiTokenAuthorized = token !== null;

      // Enforce presence when enabled (health/openapi/docs GETs exempt).
      if (ctx.config.apiAuthEnforced && !isExempt(req.method, path) && !token) {
        req.apiAuditRecorded = true;
        audit(req, ctx, null, "auth_required", 401, "token_required");
        throw new ApiError(ApiCodes.unauthorized, "API token required", 401);
      }

      if (token) {
        // Per-token rate limit.
        const ok = rateLimiter.allow(
          token.id,
          ctx.config.apiRateLimitMax,
          ctx.config.apiRateLimitWindowMs,
        );
        if (!ok) {
          req.apiAuditRecorded = true;
          audit(req, ctx, token, "rate_limited", 429, null);
          throw new ApiError(ApiCodes.rateLimited, "token rate limit exceeded", 429, {
            retryAfterSeconds: Math.ceil(ctx.config.apiRateLimitWindowMs / 1000),
          });
        }
        // Scope check (always applied when a token is present).
        const scope = requiredScope(req.method, path);
        if (!hasScope(token, scope)) {
          req.apiAuditRecorded = true;
          audit(req, ctx, token, "forbidden", 403, `missing_scope:${scope}`);
          throw new ApiError(ApiCodes.forbidden, `token lacks scope: ${scope}`, 403);
        }
      }
    });

    // Final-status audit for every token-attributed v1 request. Failure rows
    // raised synchronously in onRequest are guarded by `apiAuditRecorded` so
    // each request yields exactly one audit row.
    instance.addHook("onResponse", async (req, reply) => {
      if (req.apiAuditRecorded) return;
      if (!req.apiToken) return; // anonymous loopback traffic is not audited
      audit(req, ctx, req.apiToken, "request", reply.statusCode, null);
    });

    // Mirror the full legacy surface under /api/v1 (same handler modules).
    registerHealthRoutes(instance, ctx, V1);
    registerJobRoutes(instance, ctx, V1);
    registerAccountRoutes(instance, ctx, V1);
    registerProxyRoutes(instance, ctx, V1);
    registerProviderRoutes(instance, ctx, V1);
    registerSessionRoutes(instance, ctx, V1);
    registerSettingsRoutes(instance, ctx, V1);
    // New product surface (tokens + audit trail).
    registerTokenRoutes(instance, ctx, V1);
    registerAuditRoutes(instance, ctx, V1);
  });
}

/** Minimal, dependency-free Swagger UI page (served from the API itself). */
function swaggerHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>NLO API — Swagger UI</title>",
    '    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />',
    "    <style>body{margin:0}</style>",
    "  </head>",
    "  <body>",
    '    <div id="swagger-ui"></div>',
    '    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>',
    "    <script>",
    "      window.ui = SwaggerUIBundle({",
    '        url: "/api/openapi.json",',
    '        dom_id: "#swagger-ui",',
    "        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],",
    '        layout: "BaseLayout",',
    "      });",
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
}
