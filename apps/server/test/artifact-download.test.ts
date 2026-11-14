import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { JobInput } from "@nlo/shared";
import type { AppContext } from "../src/app-context.js";
import { buildApp } from "../src/api/server.js";
import { rateLimiter } from "../src/api/v1.js";
import { dataPathsFor, makeAppContext } from "./helpers.js";

/** A small deterministic "WAV" payload (content is irrelevant to the API layer). */
const WAV = Buffer.from("RIFF00000000WAVEfmt 001001002400000048000100data0000");

const INPUT: JobInput = {
  prompt: "podcast test prompt",
  inputType: "audio",
  audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
  podcast: null,
  preferredAccountId: null,
  preferredNodeId: null,
};

let ctx: AppContext;
let app: FastifyInstance;

beforeEach(async () => {
  rateLimiter.reset();
  ctx = await makeAppContext({});
  app = await buildApp(ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

/** Register an artifact row AND write the backing file. Returns the artifact id. */
function makeArtifact(ctx: AppContext, jobId: string, name = "podcast.wav"): string {
  const storageKey = `artifacts/${name}`;
  const id = ctx.artifacts.create({
    jobId,
    filename: name,
    mediaType: "audio/wav",
    size: WAV.length,
    source: "provider",
    storageKey,
    sha256: "ab".repeat(32),
    provenance: "mock",
  });
  const file = path.join(dataPathsFor(ctx.config.dataDir).jobsDir, jobId, storageKey);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, WAV);
  return id;
}

function bearer(plaintext: string): Record<string, string> {
  return { authorization: `Bearer ${plaintext}` };
}

describe("NLO-P2: artifact download API (GET /artifacts/:artifactId/download)", () => {
  it("serves an unowned artifact on both /api and /api/v1 with verified headers and exact bytes", async () => {
    const job = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const artId = makeArtifact(ctx, job.id);
    for (const url of [`/api/artifacts/${artId}/download`, `/api/v1/artifacts/${artId}/download`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toBe("audio/wav");
      expect(res.headers["content-length"], url).toBe(String(WAV.length));
      expect(res.headers["content-disposition"], url).toBe(
        `attachment; filename="${encodeURIComponent("podcast.wav")}"`,
      );
      expect(res.body.toString(), url).toBe(WAV.toString());
    }
  });

  it("404s for an unknown artifact id with the standard envelope (no internal path leak)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/art_doesnotexist/download",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(res.body).not.toContain(ctx.config.dataDir);
  });

  it("404s when the row exists but the file has been deleted", async () => {
    const job = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const artId = makeArtifact(ctx, job.id);
    const file = path.join(
      dataPathsFor(ctx.config.dataDir).jobsDir,
      job.id,
      "artifacts",
      "podcast.wav",
    );
    rmSync(file);
    const res = await app.inject({ method: "GET", url: `/api/artifacts/${artId}/download` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.body).not.toContain(ctx.config.dataDir);
  });

  it("cross-user isolation: a token-owned artifact is restricted to the owning token or admin", async () => {
    const tokA = ctx.apiTokens.create({ name: "alice", scopes: ["jobs:write", "jobs:download"] });
    const tokB = ctx.apiTokens.create({ name: "bob", scopes: ["jobs:write", "jobs:download"] });
    const tokAdmin = ctx.apiTokens.create({ name: "root", scopes: ["admin"] });
    const job = ctx.jobs.create({
      input: INPUT,
      configSnapshot: { provider: "mock" },
      tokenId: tokA.token.id,
    });
    const artId = makeArtifact(ctx, job.id);
    const url = `/api/v1/artifacts/${artId}/download`;

    const owner = await app.inject({ method: "GET", url, headers: bearer(tokA.plaintext) });
    expect(owner.statusCode).toBe(200);
    expect(owner.body.toString()).toBe(WAV.toString());

    const other = await app.inject({ method: "GET", url, headers: bearer(tokB.plaintext) });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("forbidden");

    const anon = await app.inject({ method: "GET", url });
    expect(anon.statusCode).toBe(403);
    expect(anon.json().error.code).toBe("forbidden");

    const admin = await app.inject({ method: "GET", url, headers: bearer(tokAdmin.plaintext) });
    expect(admin.statusCode).toBe(200);
    expect(admin.body.toString()).toBe(WAV.toString());

    // Legacy surface has no token resolution: token-owned artifacts stay protected.
    const legacy = await app.inject({
      method: "GET",
      url: `/api/artifacts/${artId}/download`,
    });
    expect(legacy.statusCode).toBe(403);
    expect(legacy.json().error.code).toBe("forbidden");
  });

  it("the nested /jobs/:id/artifacts/:artifactId route enforces the same ownership + 404s on mismatch", async () => {
    const tokA = ctx.apiTokens.create({ name: "alice", scopes: ["jobs:write", "jobs:download"] });
    const tokB = ctx.apiTokens.create({ name: "bob", scopes: ["jobs:write", "jobs:download"] });
    const jobA = ctx.jobs.create({
      input: INPUT,
      configSnapshot: { provider: "mock" },
      tokenId: tokA.token.id,
    });
    const artId = makeArtifact(ctx, jobA.id);

    // Owner can use the nested route on v1.
    const owner = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobA.id}/artifacts/${artId}`,
      headers: bearer(tokA.plaintext),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.body.toString()).toBe(WAV.toString());

    // Another token gets 403; an artifact of ANOTHER job under this id gets 404.
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobA.id}/artifacts/${artId}`,
      headers: bearer(tokB.plaintext),
    });
    expect(other.statusCode).toBe(403);

    const jobB = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobB.id}/artifacts/${artId}`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("not_found");
  });

  it("the list route exposes verified metadata and the canonical downloadUrl (no ownership columns)", async () => {
    const job = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const artId = ctx.artifacts.create({
      jobId: job.id,
      filename: "podcast.wav",
      mediaType: "audio/wav",
      size: WAV.length,
      source: "provider",
      storageKey: "artifacts/podcast.wav",
      durationSeconds: 3.5,
      codec: "PCM",
      sampleRate: 24000,
      channels: 2,
      sha256: "cd".repeat(32),
      provenance: "mock",
    });
    const res = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/artifacts` });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: artId,
      filename: "podcast.wav",
      mediaType: "audio/wav",
      size: WAV.length,
      source: "provider",
      durationSeconds: 3.5,
      codec: "PCM",
      sampleRate: 24000,
      channels: 2,
      sha256: "cd".repeat(32),
      provenance: "mock",
      downloadUrl: `/api/artifacts/${artId}/download`,
    });
    expect(items[0]).toHaveProperty("createdAt");
    expect(items[0]).toHaveProperty("sourceArtifactId", null);
    // Ownership columns never leak into the public view.
    expect(items[0]).not.toHaveProperty("tokenId");
    expect(items[0]).not.toHaveProperty("jobStatus");
  });

  it("the v1 list route points downloadUrl at the v1 surface", async () => {
    const job = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const artId = makeArtifact(ctx, job.id);
    const res = await app.inject({ method: "GET", url: `/api/v1/jobs/${job.id}/artifacts` });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first).toBeDefined();
    expect(first?.downloadUrl).toBe(`/api/v1/artifacts/${artId}/download`);
  });

  it("the result route includes the artifacts array", async () => {
    const job = ctx.jobs.create({ input: INPUT, configSnapshot: { provider: "mock" } });
    const artId = makeArtifact(ctx, job.id);
    const res = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/result` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { artifacts: Record<string, unknown>[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      id: artId,
      downloadUrl: `/api/artifacts/${artId}/download`,
    });
  });
});
