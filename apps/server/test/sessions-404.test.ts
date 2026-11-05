import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import { ApiError, ApiCodes } from "@nlo/shared";
import { Db } from "../src/db/db.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

/**
 * Session routes must answer unknown account ids with a clean 404
 * `not_found` envelope — never a 500 from a raw `Error`.
 *
 * Regression context (P0 audio recovery): an external client sent a
 * session id (`sess_...`) where an account id was expected;
 * `accounts.getOrThrow` threw a plain `Error` and the generic handler
 * mapped it to a 500 "internal_error". The guard below pins the
 * client-error mapping for every route that resolves an account by id.
 *
 * NOTE: the verify/refresh/import/logout handlers run `requireWorker()`
 * BEFORE resolving the account, so this suite builds the app with the
 * python-worker provider (no network access — construction only creates
 * the session dir).
 */

const auth: Record<string, string> = {};

let ctx: Awaited<ReturnType<typeof makeAppContext>>;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await makeAppContext({ NLO_PROVIDER: "python-worker" });
  app = await buildApp(ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe("session routes: unknown account id -> 404 not_found (never 500)", () => {
  const unknown = "sess_af33bf051ce04892"; // looks like a session id, not an account

  it("POST /api/sessions/:id/verify returns a 404 envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${unknown}/verify`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe(ApiCodes.notFound);
    expect(body.error.code).not.toBe("internal_error");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("POST /api/sessions/:id/refresh returns a 404 envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${unknown}/refresh`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe(ApiCodes.notFound);
  });

  it("POST /api/sessions/:id/import returns a 404 envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${unknown}/import`,
      headers: auth,
      payload: { base64: "eyJjb29raWVzIjpbXX0=" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe(ApiCodes.notFound);
  });

  it("DELETE /api/sessions/:id returns a 404 envelope", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${unknown}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe(ApiCodes.notFound);
  });

  it("a valid account id is still resolved (404 not leaked for real ids)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { label: "verify-target" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // The verify handler resolves the account, then returns a service result
    // object ({ok:false, detail:"no session stored..."} -> HTTP 200) instead
    // of an error. The point here: a REAL account id must never surface a
    // 404/500 from account resolution.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/verify`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok?: boolean; error?: { code?: string } };
    expect(body.error?.code).not.toBe("internal_error");
    expect(body.error?.code).not.toBe("not_found");
  });
});

describe("AccountsRepo.getOrThrow", () => {
  it("throws an ApiError(not_found, 404) for unknown ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-acct-404-"));
    const db = Db.open(path.join(dir, "test.sqlite"));
    const accounts = new AccountsRepo(db);
    try {
      let caught: unknown = null;
      try {
        accounts.getOrThrow("acc_missing");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const err = caught as ApiError;
      expect(err.code).toBe(ApiCodes.notFound);
      expect(err.httpStatus).toBe(404);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
