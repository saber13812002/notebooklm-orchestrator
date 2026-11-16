import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { NOTEBOOKLM_LIVE_OP_MAP } from "@nlo/shared";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import { rateLimiter } from "../src/api/v1.js";
import type { AppContext } from "../src/app-context.js";

/**
 * NLO-P4-1A: `GET /api/v1/capabilities` — the registry-backed, honest
 * capability endpoint (P4 target architecture).
 *
 * Contract:
 *  - Envelope `{ version: "1", providers: [descriptor...], activeId }`;
 *  - the mock app registers exactly one provider, `notebooklm.web`
 *    (the real provider is NOT registered until it is live-verified);
 *  - HONESTY INVARIANT: every descriptor level must be derivable from the
 *    live provider's capability matrix — the API never inflates a level;
 *  - scope: `providers:read` (admin implies it); under NLO_API_AUTH=true the
 *    route behaves like every other v1 route (401 no token, 403 wrong scope,
 *    200 with the right scope).
 */

interface RunningApp {
  ctx: AppContext;
  app: FastifyInstance;
  stop(): Promise<void>;
}

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

function createAdminToken(running: RunningApp): string {
  return running.ctx.apiTokens.create({ name: "admin", scopes: ["admin"] }).plaintext;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

let running: RunningApp | null = null;
afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

describe("GET /api/v1/capabilities (auth off — mock provider)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({});
  });

  it("returns 200 with the registry envelope {version, providers, activeId}", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe("1");
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers).toHaveLength(1);
    expect(body.activeId).toBe(body.providers[0].id);
  });

  it("registers notebooklm.web as the single (mock) provider", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    const d = res.json().providers[0];
    expect(d.id).toBe("notebooklm.web");
    expect(d.kind).toBe("native");
    expect(d.egressPolicy).toBe("tunnel");
    expect(d.maxConcurrent).toBe(1);
    expect(d.status).toBe("active");
    expect(d.version).toBe("nlo-mock/1.0");
  });

  it("declares exactly the canonical 31 contract operations", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    const d = res.json().providers[0];
    expect(d.capabilities).toHaveLength(31);
    const ids = new Set(d.capabilities.map((c: { operation: string }) => c.operation));
    expect(ids.size).toBe(31);
    for (const op of [
      "notebook.create",
      "chat.ask",
      "generate.audio.deep_dive",
      "artifact.download",
      "usage.introspect",
      "session.verify",
    ]) {
      expect(ids.has(op)).toBe(true);
    }
  });

  it("HONESTY INVARIANT: every implemented level is copied verbatim from the backing live op (no inflation)", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    const d = res.json().providers[0];
    const live = new Map(running!.ctx.provider.capabilities().map((c) => [c.operation, c.level]));
    for (const cap of d.capabilities) {
      const backingOps = NOTEBOOKLM_LIVE_OP_MAP[cap.operation as string] ?? [];
      const backingLevels = backingOps.map((o) => live.get(o)).filter(Boolean) as string[];
      if (backingLevels.length === 0) {
        // Not backed by a live op => must be unsupported (never invented).
        expect(cap.level, `${cap.operation} has no backing live op`).toBe("unsupported");
        continue;
      }
      // The descriptor level must equal the first declared backing op's level
      // verbatim (the derivation rule) — and therefore be a level the live
      // provider actually declares.
      expect(cap.level, `${cap.operation}=${cap.level} (backing: ${backingOps.join(",")})`).toBe(
        backingLevels[0],
      );
    }
  });

  it("F-C1: the four fused operations advertise the single-job fusion", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    const d = res.json().providers[0];
    for (const op of ["notebook.create", "source.add.text", "source.add.file", "chat.ask"]) {
      const cap = d.capabilities.find((c: { operation: string }) => c.operation === op);
      expect(cap, op).toBeTruthy();
      expect(cap.note, op).toMatch(/F-C1 fusion/);
    }
  });
});

describe("GET /api/v1/capabilities (NLO_API_AUTH=true — scope enforcement)", () => {
  beforeEach(async () => {
    rateLimiter.reset();
    running = await startApp({ NLO_API_AUTH: "true" });
  });

  it("401 without a token", async () => {
    const res = await running!.app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("403 for a token WITHOUT providers:read (jobs:read is not enough)", async () => {
    const token = running!.ctx.apiTokens.create({
      name: "reader",
      scopes: ["jobs:read"],
    }).plaintext;
    const res = await running!.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(res.json().error.message).toContain("providers:read");
  });

  it("200 for a token WITH providers:read", async () => {
    const token = running!.ctx.apiTokens.create({
      name: "provider-reader",
      scopes: ["providers:read"],
    }).plaintext;
    const res = await running!.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers[0].id).toBe("notebooklm.web");
  });

  it("200 for an admin token (admin implies providers:read)", async () => {
    const res = await running!.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: bearer(createAdminToken(running!)),
    });
    expect(res.statusCode).toBe(200);
  });

  it("providers:read is a creatable scope via POST /api/v1/tokens", async () => {
    const admin = bearer(createAdminToken(running!));
    const created = await running!.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: admin,
      payload: {
        name: "all-scopes",
        scopes: [
          "jobs:read",
          "jobs:write",
          "jobs:cancel",
          "jobs:download",
          "meta:read",
          "providers:read",
          "admin",
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const allScopes = created.json().plaintext;

    const res = await running!.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: bearer(allScopes),
    });
    expect(res.statusCode).toBe(200);
  });
});
