import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Db } from "../src/db/db.js";
import { ALL_TOKEN_SCOPES, ApiTokensRepo, sha256 } from "../src/domain/api-tokens.repo.js";
import {
  FirstAdminAlreadyBootstrappedError,
  bootstrapFirstAdmin,
} from "../src/domain/first-admin.js";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";
import { rateLimiter } from "../src/api/v1.js";

/**
 * Phase 2 — first-admin bootstrap (F2).
 *
 * UNIT: `bootstrapFirstAdmin()` against an isolated database — token format,
 *   hash-only storage, one-shot gate, rejection when an active token exists,
 *   documented recovery path (revoke all → re-run), custom name/scopes, and
 *   the attributable, secret-free audit event.
 *
 * INTEGRATION (API-level, `app.inject`): with `NLO_API_AUTH=true` and NO
 *   token in existence, the chicken-and-egg is proven (even
 *   POST /api/v1/tokens is 401 — no network path can mint the first
 *   token); the offline bootstrap unblocks the enforced API; the admin can
 *   then create further tokens through the API; revocation invalidates the
 *   token and re-opens the documented recovery path. The legacy /api
 *   surface is unaffected.
 *
 * Rate limiting itself is covered by the dedicated per-token describe in
 * openapi-v1.test.ts (C4); the limiter is reset between the enforced-mode
 * tests here for hygiene.
 */

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

describe("first-admin bootstrap — unit (domain, isolated DB)", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nlo-firstadmin-"));
    db = Db.open(path.join(dir, "test.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints a full-scope admin token on a fresh database", () => {
    const { token, plaintext } = bootstrapFirstAdmin(db);

    expect(token.name).toBe("first-admin");
    expect(token.scopes).toEqual([...ALL_TOKEN_SCOPES]);
    expect(token.enabled).toBe(true);
    expect(token.revokedAt).toBeNull();
    expect(plaintext).toMatch(/^nlo_first-admin_[0-9a-f]{64}$/);
    // The presented plaintext must authenticate (hash lookup).
    expect(new ApiTokensRepo(db).findByPlaintext(plaintext)?.id).toBe(token.id);
    expect(new ApiTokensRepo(db).resolve(plaintext)?.id).toBe(token.id);
  });

  it("stores ONLY the sha256 hash — the plaintext is in no table", () => {
    const { token, plaintext } = bootstrapFirstAdmin(db);

    const hashRow = db.raw
      .prepare("SELECT token_hash FROM api_tokens WHERE id = ?")
      .get(token.id) as { token_hash: string };
    expect(hashRow.token_hash).toBe(sha256(plaintext));
    expect(hashRow.token_hash).not.toContain(plaintext);

    for (const table of ["api_tokens", "api_audit_log"]) {
      const rows = db.raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") {
            expect(value).not.toContain(plaintext);
          }
        }
      }
    }
  });

  it("is one-shot: a second bootstrap is refused while a token is active", () => {
    const first = bootstrapFirstAdmin(db);
    expect(() => bootstrapFirstAdmin(db)).toThrowError(FirstAdminAlreadyBootstrappedError);
    // State is untouched by the refusal.
    const list = new ApiTokensRepo(db).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(first.token.id);
  });

  it("is refused when an active token was created through the normal API path", () => {
    const tokens = new ApiTokensRepo(db);
    tokens.create({ name: "via-api", scopes: ["admin"] });
    expect(() => bootstrapFirstAdmin(db)).toThrowError(FirstAdminAlreadyBootstrappedError);
    expect(tokens.list()).toHaveLength(1);
  });

  it("recovery path: revoke ALL active tokens, then bootstrap succeeds again", () => {
    const tokens = new ApiTokensRepo(db);
    const a = tokens.create({ name: "temp-a" });
    const b = tokens.create({ name: "temp-b", scopes: ["jobs:read"] });
    // One still-active token is enough to refuse...
    tokens.revoke(b.token.id);
    expect(() => bootstrapFirstAdmin(db)).toThrowError(FirstAdminAlreadyBootstrappedError);
    // ...revoke the rest, and the documented recovery works. (No
    // "first-admin" row exists in this scenario, so the name stays as-is.)
    tokens.revoke(a.token.id);
    const fresh = bootstrapFirstAdmin(db, { name: "first-admin" });
    expect(fresh.token.name).toBe("first-admin");
    expect(tokens.list()).toHaveLength(3); // 2 revoked + 1 fresh
    expect(tokens.resolve(fresh.plaintext)?.id).toBe(fresh.token.id);
  });

  it("auto-suffixes the name when the name is taken by an INACTIVE token", () => {
    const tokens = new ApiTokensRepo(db);
    // "first-admin" (default) is taken by a revoked row -> use "first-admin-2".
    const old = tokens.create({ name: "first-admin", scopes: ["admin"] });
    tokens.revoke(old.token.id);
    const fresh = bootstrapFirstAdmin(db);
    expect(fresh.token.name).toBe("first-admin-2");
  });

  it("suffix increments past already-taken inactive names", () => {
    // Fresh database (the one-shot gate forbids a second bootstrap while the
    // first result is still active).
    const dir2 = mkdtempSync(path.join(tmpdir(), "nlo-firstadmin2-"));
    const db2 = Db.open(path.join(dir2, "test.sqlite"));
    try {
      const tokens = new ApiTokensRepo(db2);
      const base = "ops-admin";
      const b0 = tokens.create({ name: base, scopes: ["jobs:read"] });
      const b2 = tokens.create({ name: `${base}-2`, scopes: ["jobs:read"] });
      tokens.revoke(b0.token.id);
      tokens.revoke(b2.token.id);
      const fresh = bootstrapFirstAdmin(db2, { name: base });
      expect(fresh.token.name).toBe(`${base}-3`);
    } finally {
      db2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("honors a custom name and scope set", () => {
    const { token } = bootstrapFirstAdmin(db, {
      name: "Ops Admin",
      scopes: ["jobs:read", "admin"],
    });
    expect(token.name).toBe("Ops Admin");
    expect(token.scopes).toEqual(["jobs:read", "admin"]);
    // slug() lowercases + replaces non-[a-z09-] — used in the plaintext.
  });

  it("writes an attributable, secret-free audit event", () => {
    const { token, plaintext } = bootstrapFirstAdmin(db);
    const { items } = new ApiTokensRepo(db).auditList({ tokenId: token.id });
    expect(items).toHaveLength(1);
    const ev = items[0];
    expect(ev?.action).toBe("first_admin_bootstrapped");
    expect(ev?.method).toBe("CLI");
    expect(ev?.path).toBe("local://bootstrap-first-admin");
    expect(ev?.status).toBe(200);
    expect(ev?.detail).toBe(token.id);
    expect(ev?.ip).toBeNull();
    // Never the plaintext, never the hash-as-value either.
    expect(JSON.stringify(items)).not.toContain(plaintext);
  });
});

describe("first-admin bootstrap — integration (enforced auth, API-level)", () => {
  let running: {
    ctx: AppContext;
    app: FastifyInstance;
    stop(): Promise<void>;
  };

  beforeEach(async () => {
    rateLimiter.reset();
    const ctx = await makeAppContext({ NLO_API_AUTH: "true" });
    const app = await buildApp(ctx);
    await app.ready();
    running = {
      ctx,
      app,
      stop: async () => {
        await app.close();
        await ctx.close();
      },
    };
  });

  afterEach(async () => {
    await running.stop();
  });

  it("proves the chicken-and-egg: with no token, NOTHING can create one", async () => {
    const res = await running.app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(res.statusCode).toBe(401);

    // Even the token-management endpoint itself is unreachable anonymously —
    // the first admin CANNOT be minted over the network.
    const create = await running.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "impossible", scopes: ["admin"] }),
    });
    expect(create.statusCode).toBe(401);
    expect(new ApiTokensRepo(running.ctx.db).list()).toHaveLength(0);
  });

  it("the offline bootstrap unblocks the enforced API end-to-end", async () => {
    const { token, plaintext } = bootstrapFirstAdmin(running.ctx.db);

    // The bootstrapped token authenticates with its full scope set...
    const jobs = await running.app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(plaintext),
    });
    expect(jobs.statusCode).toBe(200);

    // ...and can manage tokens through the ordinary admin API.
    const tokens = await running.app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: bearer(plaintext),
    });
    expect(tokens.statusCode).toBe(200);
    expect(
      (tokens.json() as { items: { id: string }[] }).items.some((t) => t.id === token.id),
    ).toBe(true);

    // A second, scoped-down token created via the API works too.
    const created = await running.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...bearer(plaintext), "content-type": "application/json" },
      payload: JSON.stringify({ name: "reader", scopes: ["jobs:read"] }),
    });
    expect(created.statusCode).toBe(201);
    const readerPlaintext = (created.json() as { plaintext: string }).plaintext;
    const readerJobs = await running.app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(readerPlaintext),
    });
    expect(readerJobs.statusCode).toBe(200);

    // Legacy surface untouched (loopback trust model preserved).
    const legacy = await running.app.inject({ method: "GET", url: "/api/health" });
    expect(legacy.statusCode).toBe(200);
  });

  it("revocation invalidates the token and re-opens the recovery path", async () => {
    const { token, plaintext } = bootstrapFirstAdmin(running.ctx.db);
    const before = await running.app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(plaintext),
    });
    expect(before.statusCode).toBe(200);

    const revoke = await running.app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${token.id}`,
      headers: bearer(plaintext),
    });
    expect(revoke.statusCode).toBe(200);

    const after = await running.app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(plaintext),
    });
    expect(after.statusCode).toBe(401);

    // All active tokens are now revoked → the documented recovery works.
    const fresh = bootstrapFirstAdmin(running.ctx.db, { name: "first-admin" });
    const recovered = await running.app.inject({
      method: "GET",
      url: "/api/v1/jobs",
      headers: bearer(fresh.plaintext),
    });
    expect(recovered.statusCode).toBe(200);
  });
});
