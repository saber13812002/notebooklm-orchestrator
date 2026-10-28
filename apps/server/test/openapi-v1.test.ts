import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";
import { rateLimiter } from "../src/api/v1.js";
import { buildOpenApiDocument } from "../src/api/openapi/spec.js";

/**
 * Phase C contract + auth tests for the versioned API surface.
 *
 *  - C2: OpenAPI document + Swagger UI are served; the spec and the LIVE app
 *    agree in BOTH directions (every documented path+method exists, and every
 *    live /api/v1 route is documented — no silent drift either way).
 *  - C3: /api/v1 mirrors the legacy /api surface (same handlers, same
 *    envelope).
 *  - C4: optional vs enforced bearer auth, scopes, per-token rate limiting,
 *    token lifecycle, audit trail (redacted, queryable).
 *  - C5: idempotent job creation + correlation ids.
 *
 * The background queue is stopped in the test context (see makeAppContext),
 * so created jobs stay in CREATED — no job execution races.
 */

const MP_BOUNDARY = "----nlo-test-boundary";
type MpPart = string | { field: string; filename?: string; bytes?: Buffer; type?: string };

/** Build a correct multipart/form-data body (CRLF-terminated parts). */
function multipart(parts: MpPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      chunks.push(
        Buffer.from(
          `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    } else {
      const header = `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${part.field}"; filename="${part.filename ?? "upload.bin"}"\r\ncontent-type: ${part.type ?? "application/octet-stream"}\r\n\r\n`;
      chunks.push(Buffer.from(header));
      if (part.bytes && part.bytes.length > 0) chunks.push(part.bytes);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${MP_BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

interface RunningApp {
  ctx: AppContext;
  app: FastifyInstance;
  stop(): Promise<void>;
}

/** Build an isolated app with a specific env profile (auth mode, limits...). */
async function startApp(env: Record<string, string> = {}): Promise<RunningApp> {
  const ctx = await makeAppContext(env);
  const app = await buildApp(ctx);
  await app.ready();
  return {
    ctx,
    app,
    stop: async () => {
      await app.close();
      await ctx.close();
    },
  };
}

/** Create an admin token directly through the repo (bootstrap credential). */
function createAdminToken(running: RunningApp): { id: string; name: string; plaintext: string } {
  const { token, plaintext } = running.ctx.apiTokens.create({ name: "admin", scopes: ["admin"] });
  return { id: token.id, name: token.name, plaintext };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/**
 * Enumerate the live route table by parsing Fastify's `printRoutes()` tree
 * (Fastify 5 exposes no public `app.routes` array).
 *
 * Tree format (verified against the running app): each level indents by 4
 * chars; a node label is one of:
 *   - "api/"  -> directory fragment (contributes `api/`)
 *   - "/"     -> separator node between segments (contributes `/`)
 *   - "pro"   -> merged common-prefix fragment (contributes `pro`, no slash;
 *                its children "xies"/"vider" complete "proxies"/"provider")
 *   - "jobs (POST, GET, HEAD)" -> route node; may ALSO have children
 *     (e.g. `jobs` + `/:id/...`), so a methods annotation does not imply leaf.
 * The route path is the concatenation of the ancestor contributions; the
 * `* (OPTIONS)` wildcard and the `(empty root node)` are skipped.
 */
function liveRoutes(app: FastifyInstance): { path: string; methods: string[] }[] {
  const lines = app
    .printRoutes()
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const out: { path: string; methods: string[] }[] = [];
  const chain: string[] = []; // path-text contribution per depth
  for (const line of lines) {
    const m = line.match(/^([│\s]*)(?:├── |└── )(.+)$/);
    if (!m) continue;
    const depth = (m[1] ?? "").length / 4;
    let label = (m[2] ?? "").trim();
    let methods: string[] | null = null;
    const mm = label.match(/\(([^)]*)\)\s*$/);
    if (mm) {
      methods = (mm[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      label = label.slice(0, mm.index).trim();
    }
    chain.length = depth;
    chain[depth] = label === "/" ? "/" : label; // dir fragments keep their slash
    if (depth === 0) continue; // "(empty root node)"
    if (!methods || label === "*") continue; // prefix/directory/wildcard node
    const path = chain
      .slice(1, depth + 1)
      .join("")
      .replace(/\/{2,}/g, "/")
      .replace(/^(?!\/)/, "/");
    out.push({ path, methods: methods.filter((x) => x !== "HEAD") });
  }
  return out;
}

/** Expand the OpenAPI document into (path, method) pairs under /api/v1. */
function specRoutes(doc: Record<string, unknown>): { path: string; method: string }[] {
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  const out: { path: string; method: string }[] = [];
  for (const [p, item] of Object.entries(paths)) {
    for (const m of Object.keys(item)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(m)) {
        out.push({ path: "/api/v1" + p, method: m.toUpperCase() });
      }
    }
  }
  return out;
}

/** Normalize OpenAPI `{param}` to Fastify `:param`. */
const normParam = (p: string): string => p.replace(/\{(\w+)\}/g, ":$1");

/** Shared teardown; each describe owns its app profile. */
let running: RunningApp | null = null;
afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

describe("OpenAPI contract (C2)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("serves a valid OpenAPI 3.x document at /api/openapi.json and /api/v1/openapi.json", async () => {
    for (const url of ["/api/openapi.json", "/api/v1/openapi.json"]) {
      const res = await running!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      const doc = res.json() as Record<string, unknown>;
      expect(String(doc.openapi)).toMatch(/^3\./);
      expect(doc.info).toBeTruthy();
      expect(doc.paths).toBeTruthy();
      expect(doc.components).toBeTruthy();
    }
    // The served document matches the programmatic builder exactly.
    const res = await running!.app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(res.json()).toEqual(buildOpenApiDocument(running!.ctx));
  });

  it("serves the Swagger UI at /api/docs and /api/v1/docs", async () => {
    for (const url of ["/api/docs", "/api/v1/docs"]) {
      const res = await running!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.payload).toContain("swagger-ui");
    }
  });

  it("spec and live app agree in BOTH directions (no drift either way)", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const doc = res.json() as Record<string, unknown>;

    const spec = new Set(specRoutes(doc).map((r) => `${r.method} ${normParam(r.path)}`));
    const live = new Set(
      liveRoutes(running!.app)
        .filter((r) => r.path.startsWith("/api/v1/"))
        .flatMap((r) => r.methods.map((m) => `${m} ${r.path}`)),
    );

    const missingOnLive = [...spec].filter((k) => !live.has(k)).sort();
    const undocumented = [...live].filter((k) => !spec.has(k)).sort();
    expect(missingOnLive, `Documented but NOT live:\n  ${missingOnLive.join("\n  ")}`).toEqual([]);
    expect(undocumented, `Live but NOT documented:\n  ${undocumented.join("\n  ")}`).toEqual([]);
    expect(spec.size).toBeGreaterThanOrEqual(50); // sanity: the contract is substantial
  });
});

describe("v1 mirrors the legacy surface (C3)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("resources created via legacy are visible via v1 (and vice versa)", async () => {
    const { app } = running!;
    // Create an account through the LEGACY surface...
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: JSON.stringify({ label: "legacy-created" }),
      headers: { "content-type": "application/json" },
    });
    expect(created.statusCode).toBe(201);
    const accountId = (created.json() as { id: string }).id;

    // ...and read it through the VERSIONED surface.
    const viaV1 = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    expect(viaV1.statusCode).toBe(200);
    const list = viaV1.json() as { id: string }[];
    expect(list.some((a) => a.id === accountId)).toBe(true);

    // Create a job through v1, read it through legacy.
    const jobRes = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: { "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}` },
      payload: multipart(["prompt=from v1"]),
    });
    expect(jobRes.statusCode).toBe(201);
    const jobId = (jobRes.json() as { id: string }).id;
    const viaLegacy = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(viaLegacy.statusCode).toBe(200);
    expect((viaLegacy.json() as { input: { prompt: string } }).input.prompt).toBe("from v1");
  });

  it("uses the same standard error envelope on both surfaces", async () => {
    const { app } = running!;
    for (const url of ["/api/jobs/j_doesnotexist", "/api/v1/jobs/j_doesnotexist"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
      expect(res.json().error.message).toBeTruthy();
    }
  });
});

describe("optional auth mode (default): tokens attribute, never block", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("serves v1 to anonymous loopback callers", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("items");
  });

  it("audits token-attributed requests but NOT anonymous traffic", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);

    const before = ctx.apiTokens.auditList({ limit: 500 }).total;
    const anon = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(anon.statusCode).toBe(200);
    expect(ctx.apiTokens.auditList({ limit: 500 }).total).toBe(before); // anonymous: no row

    const attributed = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(admin.plaintext),
    });
    expect(attributed.statusCode).toBe(200);
    const { items } = ctx.apiTokens.auditList({ tokenId: admin.id, limit: 10 });
    expect(items.length).toBe(1);
    expect(items[0]!.action).toBe("request");
    expect(items[0]!.method).toBe("GET");
    expect(items[0]!.path).toBe("/api/v1/jobs");
    expect(items[0]!.status).toBe(200);
    expect(items[0]!.tokenName).toBe("admin");
  });

  it("never lets token/audit routes run anonymously (defense in depth)", async () => {
    for (const [method, url] of [
      ["POST", "/api/v1/tokens"],
      ["GET", "/api/v1/tokens"],
      ["GET", "/api/v1/audit"],
    ] as const) {
      const res = await running!.app.inject({
        method,
        url,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ name: "x" }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });
});

describe("enforced auth mode (NLO_API_AUTH=true)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({ NLO_API_AUTH: "true" });
  });

  it("rejects anonymous non-exempt requests with 401 + an auth_required audit row", async () => {
    const { app, ctx } = running!;
    const res = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    const { items } = ctx.apiTokens.auditList({ limit: 10 });
    expect(items.some((i) => i.action === "auth_required" && i.status === 401)).toBe(true);
  });

  it("keeps the exempt GETs open (health, ready, openapi, docs)", async () => {
    for (const url of [
      "/api/v1/health",
      "/api/v1/health/ready",
      "/api/v1/openapi.json",
      "/api/v1/docs",
    ]) {
      const res = await running!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects invalid or revoked bearer tokens with 401 + an auth_failed audit row", async () => {
    const { app, ctx } = running!;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(`nlo_bogus_${"0".repeat(64)}`),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    const { items } = ctx.apiTokens.auditList({ limit: 10 });
    expect(
      items.some((i) => i.action === "auth_failed" && i.detail === "invalid_or_revoked_token"),
    ).toBe(true);
  });

  it("leaves the legacy /api surface untouched (loopback trust model preserved)", async () => {
    const { app } = running!;
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const job = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}` },
      payload: multipart(["prompt=legacy still open"]),
    });
    expect(job.statusCode).toBe(201);
  });

  it("enforces scopes: a jobs:read token cannot create jobs (403 + audit)", async () => {
    const { app, ctx } = running!;
    const reader = ctx.apiTokens.create({ name: "reader", scopes: ["jobs:read"] });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: {
        ...bearer(reader.plaintext),
        "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
      },
      payload: multipart(["prompt=nope"]),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(res.json().error.message).toContain("jobs:write");
    const { items } = ctx.apiTokens.auditList({ tokenId: reader.token.id, limit: 10 });
    expect(
      items.some((i) => i.action === "forbidden" && i.detail === "missing_scope:jobs:write"),
    ).toBe(true);
  });

  it("admin implies every scope; non-admin cannot manage tokens", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);
    const adminOk = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: bearer(admin.plaintext),
    });
    expect(adminOk.statusCode).toBe(200);

    const reader = ctx.apiTokens.create({ name: "reader", scopes: ["jobs:read"] });
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: bearer(reader.plaintext),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("treats disabled and revoked tokens as invalid", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);
    const worker = ctx.apiTokens.create({
      name: "worker",
      scopes: ["jobs:read", "jobs:write"],
    });

    const okBefore = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(worker.plaintext),
    });
    expect(okBefore.statusCode).toBe(200);

    ctx.apiTokens.setEnabled(worker.token.id, false);
    const disabled = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(worker.plaintext),
    });
    expect(disabled.statusCode).toBe(401);

    ctx.apiTokens.setEnabled(worker.token.id, true);
    ctx.apiTokens.revoke(worker.token.id);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(worker.plaintext),
    });
    expect(revoked.statusCode).toBe(401);

    // The admin token still works throughout.
    const adminStill = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(admin.plaintext),
    });
    expect(adminStill.statusCode).toBe(200);
  });
});

describe("token lifecycle (C4)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({ NLO_API_AUTH: "true" });
  });

  it("create -> list -> use -> disable -> revoke, with the plaintext shown exactly once", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);
    const h = bearer(admin.plaintext);

    // Create through the API.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...h, "content-type": "application/json" },
      payload: JSON.stringify({ name: "svc-external", scopes: ["jobs:read", "jobs:write"] }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      token: { id: string; name: string; scopes: string[] };
      plaintext: string;
      note: string;
    };
    expect(body.plaintext).toMatch(/^nlo_svc-external_[0-9a-f]{64}$/);
    expect(body.token.id).toMatch(/^tok_[0-9a-f]{24}$/);
    expect(body.token.scopes).toEqual(["jobs:read", "jobs:write"]);
    expect(body.note).toMatch(/only once/i);

    // List: metadata only, NO plaintext anywhere.
    const list = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: h });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: unknown[] }).items;
    expect(items.length).toBe(2); // admin + svc-external
    expect(JSON.stringify(items)).not.toContain(body.plaintext);
    expect(JSON.stringify(items)).not.toContain(admin.plaintext);

    // The created token works immediately.
    const use = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(body.plaintext),
    });
    expect(use.statusCode).toBe(200);

    // Disable -> 401; re-enable -> 200.
    const off = await app.inject({
      method: "PATCH",
      url: `/api/v1/tokens/${body.token.id}`,
      headers: { ...h, "content-type": "application/json" },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(off.statusCode).toBe(200);
    const whileOff = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(body.plaintext),
    });
    expect(whileOff.statusCode).toBe(401);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/tokens/${body.token.id}`,
      headers: { ...h, "content-type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    const whileOn = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(body.plaintext),
    });
    expect(whileOn.statusCode).toBe(200);

    // Revoke -> 401, and a token_revoked audit row exists.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${body.token.id}`,
      headers: h,
    });
    expect(del.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(body.plaintext),
    });
    expect(afterRevoke.statusCode).toBe(401);
    const { items: audit } = ctx.apiTokens.auditList({ tokenId: admin.id, limit: 500 });
    expect(audit.some((i) => i.action === "token_revoked" && i.detail === body.token.id)).toBe(
      true,
    );
  });

  it("validates the create body (name required, scopes must be known)", async () => {
    const admin = createAdminToken(running!);
    const h = bearer(admin.plaintext);
    const noName = await running!.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...h, "content-type": "application/json" },
      payload: JSON.stringify({ scopes: ["jobs:read"] }),
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe("validation_error");
    const badScope = await running!.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...h, "content-type": "application/json" },
      payload: JSON.stringify({ name: "x", scopes: ["not-a-scope"] }),
    });
    expect(badScope.statusCode).toBe(400);
  });
});

describe("per-token rate limiting (C4)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({ NLO_API_AUTH: "true", NLO_API_RATE_LIMIT_MAX: "3" });
  });

  it("allows the budget, then returns 429 with retryAfterSeconds + an audit row", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);
    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/jobs",
        headers: bearer(admin.plaintext),
      });
      expect(res.statusCode).toBe(200);
    }
    const over = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(admin.plaintext),
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    expect(over.json().error.details.retryAfterSeconds).toBe(60); // default 60s window
    const { items } = ctx.apiTokens.auditList({ tokenId: admin.id, limit: 50 });
    expect(items.some((i) => i.action === "rate_limited" && i.status === 429)).toBe(true);

    // A DIFFERENT token is unaffected (per-token windows).
    const other = ctx.apiTokens.create({ name: "other", scopes: ["jobs:read"] });
    const fresh = await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(other.plaintext),
    });
    expect(fresh.statusCode).toBe(200);
  });
});

describe("idempotent job creation (C5)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("same token + key replays the ORIGINAL job (200, x-idempotent-replay)", async () => {
    const { app, ctx } = running!;
    const { plaintext } = ctx.apiTokens.create({
      name: "writer",
      scopes: ["jobs:write", "jobs:read"],
    });
    const key = `key-${randomUUID()}`;
    const h = {
      ...bearer(plaintext),
      "idempotency-key": key,
      "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: h,
      payload: multipart(["prompt=once"]),
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string };
    expect(firstBody.id).toMatch(/^j_[0-9a-f]{32}$/);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: h,
      payload: multipart(["prompt=once"]),
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { id: string }).id).toBe(firstBody.id);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");

    // Exactly one job exists for that key.
    const list = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    const ids = (list.json() as { items: { id: string }[] }).items.map((j) => j.id);
    expect(ids.filter((id) => id === firstBody.id)).toHaveLength(1);
  });

  it("the same key with a DIFFERENT token creates a new job (token-scoped)", async () => {
    const { app, ctx } = running!;
    const a = ctx.apiTokens.create({ name: "a", scopes: ["jobs:write"] });
    const b = ctx.apiTokens.create({ name: "b", scopes: ["jobs:write"] });
    const key = `shared-${randomUUID()}`;

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: {
        ...bearer(a.plaintext),
        "idempotency-key": key,
        "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
      },
      payload: multipart(["prompt=x"]),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: {
        ...bearer(b.plaintext),
        "idempotency-key": key,
        "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
      },
      payload: multipart(["prompt=x"]),
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { id: string }).id).not.toBe((first.json() as { id: string }).id);
  });

  it("rejects malformed keys with a validation error", async () => {
    const { app, ctx } = running!;
    const { plaintext } = ctx.apiTokens.create({ name: "w", scopes: ["jobs:write"] });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: {
        ...bearer(plaintext),
        "idempotency-key": "short",
        "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
      },
      payload: multipart(["prompt=x"]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("legacy /api/jobs ignores the key without a token (unchanged behavior)", async () => {
    const h = {
      "idempotency-key": `legacy-${randomUUID()}`,
      "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}`,
    };
    const first = await running!.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: h,
      payload: multipart(["prompt=legacy"]),
    });
    expect(first.statusCode).toBe(201);
    const second = await running!.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: h,
      payload: multipart(["prompt=legacy"]),
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers["x-idempotent-replay"]).toBeUndefined();
    expect((second.json() as { id: string }).id).not.toBe((first.json() as { id: string }).id);
  });
});

describe("correlation ids (C5)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("echoes a supplied x-correlation-id and generates cr_<32hex> otherwise", async () => {
    const supplied = await running!.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-correlation-id": "corr-test-123" },
    });
    expect(supplied.statusCode).toBe(200);
    expect(supplied.headers["x-correlation-id"]).toBe("corr-test-123");

    const generated = await running!.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(generated.statusCode).toBe(200);
    expect(generated.headers["x-correlation-id"]).toMatch(/^cr_[0-9a-f]{32}$/);

    // Correlation ids are on v1 responses only (legacy surface is untouched).
    const legacy = await running!.app.inject({ method: "GET", url: "/api/health" });
    expect(legacy.headers["x-correlation-id"]).toBeUndefined();
  });
});

describe("audit trail (C4)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({ NLO_API_AUTH: "true" });
  });

  it("is queryable, filters by token, and never contains token values", async () => {
    const { app, ctx } = running!;
    const admin = createAdminToken(running!);
    const worker = ctx.apiTokens.create({ name: "worker", scopes: ["jobs:read"] });

    // Generate attributable traffic for both tokens + one auth failure.
    await app.inject({ method: "GET", url: "/api/v1/jobs", headers: bearer(admin.plaintext) });
    await app.inject({ method: "GET", url: "/api/v1/provider", headers: bearer(worker.plaintext) });
    await app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer("nlo_bad_" + "f".repeat(64)),
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: bearer(admin.plaintext),
    });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { items: unknown[]; total: number };
    expect(allBody.total).toBeGreaterThanOrEqual(3);
    const actions = allBody.items.map((i) => (i as { action: string }).action);
    expect(actions).toContain("request");
    expect(actions).toContain("auth_failed");

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/audit?tokenId=${worker.token.id}`,
      headers: bearer(admin.plaintext),
    });
    expect(filtered.statusCode).toBe(200);
    const fBody = filtered.json() as { items: { tokenId: string | null }[] };
    expect(fBody.items.length).toBe(1);
    expect(fBody.items[0]!.tokenId).toBe(worker.token.id);

    // No token VALUE may ever appear in an audit payload.
    for (const payload of [allBody, fBody]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(admin.plaintext);
      expect(text).not.toContain(worker.plaintext);
    }
  });
});
