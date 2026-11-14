import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AllowEntry } from "@nlo/shared";
import { Db } from "../src/db/db.js";
import { SecretVault } from "../src/secrets/vault.js";
import { ArtifactRepo } from "../src/domain/artifacts.repo.js";
import { JobsRepo } from "../src/domain/jobs.repo.js";
import { WebhookDeliveriesRepo, WebhookEndpointsRepo } from "../src/domain/webhooks.repo.js";
import { WebhookDispatcher } from "../src/webhooks/dispatcher.js";
import { buildApp } from "../src/api/server.js";
import { addAccount, addNode, createJob, makeAppContext, markHealthy } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * NLO-P2 (webhooks): outbox delivery + API surface.
 *
 * Stack-level: the dispatcher is driven with an injected fetch/clock/DNS —
 * deterministic, no real network. API-level: real Fastify app on a temp
 * data dir (mock provider), loopback allowed so the manual-test receiver
 * on 127.0.0.1 can be reached end-to-end.
 */

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface Stack {
  db: Db;
  vault: SecretVault;
  jobs: JobsRepo;
  artifacts: ArtifactRepo;
  endpoints: WebhookEndpointsRepo;
  deliveries: WebhookDeliveriesRepo;
  dispatcher: WebhookDispatcher;
  fetchCalls: FetchCall[];
  advance: (ms: number) => void;
  dispose: () => void;
}

function makeStack(
  opts: {
    allowLoopback?: boolean;
    allowlist?: AllowEntry[];
    maxAttempts?: number;
    baseDelayMs?: number;
    responder?: (i: number) => number;
  } = {},
): Stack {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nlo-whk-"));
  const db = Db.open(path.join(dir, "t.sqlite"));
  const vault = SecretVault.open(db, {
    keyHex: "ab".repeat(32),
    keyFile: path.join(dir, "vault.key"),
  });
  const jobs = new JobsRepo(db);
  const artifacts = new ArtifactRepo(db);
  const endpoints = new WebhookEndpointsRepo(db);
  const deliveries = new WebhookDeliveriesRepo(db);
  let nowMs = Date.now();
  const fetchCalls: FetchCall[] = [];
  const responder = opts.responder ?? (() => 200);
  const dispatcher = new WebhookDispatcher({
    endpoints,
    deliveries,
    jobs,
    artifacts,
    vault,
    allowlist: opts.allowlist ?? [],
    allowLoopback: opts.allowLoopback ?? true,
    maxAttempts: opts.maxAttempts ?? 8,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    maxDelayMs: 60_000,
    timeoutMs: 5_000,
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({
        url: String(input),
        headers: (init?.headers as unknown as Record<string, string>) ?? {},
        body: init?.body == null ? "" : String(init.body),
      });
      return Promise.resolve(new Response(null, { status: responder(fetchCalls.length - 1) }));
    },
    now: () => nowMs,
    resolveIps: (h: string) => Promise.resolve([h]),
    log: () => {},
  });
  return {
    db,
    vault,
    jobs,
    artifacts,
    endpoints,
    deliveries,
    dispatcher,
    fetchCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addEndpoint(
  st: Stack,
  o: { name: string; url?: string; secret?: string | null; events?: string[] },
): string {
  const id = st.endpoints.newId();
  const hasSecret = o.secret != null;
  if (hasSecret) st.vault.put(`webhook:${id}`, o.secret as string, "webhook_secret");
  st.endpoints.create({
    id,
    name: o.name,
    url: o.url ?? "http://127.0.0.1:9/hook",
    secretRef: hasSecret ? `webhook:${id}` : null,
    events: o.events ?? [],
  });
  return id;
}

/** Advance past the real-wall-clock enqueue stamp, then drain once. */
async function dueTick(st: Stack): Promise<number> {
  st.advance(10);
  return st.dispatcher.tick();
}

describe("WebhookDispatcher (outbox delivery, deterministic)", () => {
  const stacks: Stack[] = [];
  const mk = (opts?: Parameters<typeof makeStack>[0]): Stack => {
    const s = makeStack(opts);
    stacks.push(s);
    return s;
  };
  afterEach(() => {
    while (stacks.length > 0) stacks.pop()?.dispose();
  });

  it("publish -> tick delivers a signed POST; the HMAC recomputes over the exact body", async () => {
    const st = mk();
    const secret = "a".repeat(64);
    addEndpoint(st, { name: "ep1", secret });
    const job = createJob(st.jobs);
    expect(st.dispatcher.publish(job.id, "job.created")).toBe(1);

    expect(await dueTick(st)).toBe(1);

    const rows = st.deliveries.list({ jobId: job.id }).items;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("delivered");
    expect(row.lastStatus).toBe(200);
    expect(st.fetchCalls).toHaveLength(1);

    const call = st.fetchCalls[0]!;
    expect(call.url).toBe("http://127.0.0.1:9/hook");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-nlo-event"]).toBe("job.created");
    expect(call.headers["x-nlo-delivery-id"]).toBe(row.id);
    expect(call.headers["x-nlo-timestamp"]).toMatch(/^\d+$/);

    const sig = call.headers["x-nlo-signature"];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const [tPart, v1Part] = sig!.split(",");
    const t = Number(tPart?.slice(2));
    expect(createHmac("sha256", secret).update(`${t}.${call.body}`).digest("hex")).toBe(
      v1Part?.slice(3),
    );

    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(payload.event).toBe("job.created");
    expect(payload.jobId).toBe(job.id);
    expect(payload.status).toBe("CREATED");
    expect(payload.artifacts).toEqual([]);
    expect(typeof payload.occurredAt).toBe("string");
  });

  it("an endpoint without a secret gets NO signature header (unsigned delivery)", async () => {
    const st = mk();
    addEndpoint(st, { name: "unsigned", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);

    expect(st.fetchCalls).toHaveLength(1);
    expect(st.fetchCalls[0]!.headers["x-nlo-signature"]).toBeUndefined();
    expect(st.deliveries.list({ jobId: job.id }).items[0]!.status).toBe("delivered");
  });

  it("loopback is blocked without the opt-in, even when the host is allowlisted (fail-closed)", async () => {
    const st = mk({ allowLoopback: false, allowlist: [{ host: "127.0.0.1" }] });
    addEndpoint(st, { name: "ep", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("ssrf_blocked:private_target");
    expect(row.deadAt).not.toBeNull();
    expect(st.fetchCalls).toHaveLength(0);
  });

  it("a private target without allowPrivate on its entry is dead-lettered before any fetch", async () => {
    const st = mk({
      allowLoopback: false,
      allowlist: [{ host: "192.168.1.10", port: 80 }],
    });
    addEndpoint(st, { name: "ep", url: "http://192.168.1.10:80/h", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("ssrf_blocked:private_target");
    expect(st.fetchCalls).toHaveLength(0);
  });

  it("an allowlist entry with the wrong port is not a match (not_allowed)", async () => {
    const st = mk({ allowLoopback: false, allowlist: [{ host: "10.1.2.3", port: 443 }] });
    addEndpoint(st, { name: "ep", url: "http://10.1.2.3:8080/h", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("ssrf_blocked:not_allowed");
    expect(st.fetchCalls).toHaveLength(0);
  });

  it("5xx retries with exponential backoff until success (no early re-attempts)", async () => {
    const st = mk({ maxAttempts: 5, baseDelayMs: 1000, responder: (i) => (i < 2 ? 500 : 200) });
    addEndpoint(st, { name: "ep", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st); // attempt 1 -> 500
    let row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(st.fetchCalls).toHaveLength(1);

    await st.dispatcher.tick(); // same instant: backoff not elapsed
    expect(st.fetchCalls).toHaveLength(1);

    st.advance(1000);
    await st.dispatcher.tick(); // attempt 2 -> 500
    row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.attempts).toBe(2);
    expect(st.fetchCalls).toHaveLength(2);

    st.advance(2000);
    await st.dispatcher.tick(); // attempt 3 -> 200
    row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("delivered");
    expect(row.lastStatus).toBe(200);
    expect(st.fetchCalls).toHaveLength(3);
  });

  it("a 404 is a client rejection: dead after ONE attempt (no point retrying)", async () => {
    const st = mk({ responder: () => 404 });
    addEndpoint(st, { name: "ep", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("dead");
    expect(row.lastStatus).toBe(404);
    expect(row.lastError).toBe("http 404 (client rejected)");
    expect(row.deadAt).not.toBeNull();
    expect(st.fetchCalls).toHaveLength(1);
  });

  it("5xx with attempts exhausted -> dead letter (deadAt set, error recorded)", async () => {
    const st = mk({ maxAttempts: 3, responder: () => 503 });
    addEndpoint(st, { name: "ep", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");

    await dueTick(st);
    st.advance(1000);
    await st.dispatcher.tick();
    st.advance(2000);
    await st.dispatcher.tick();

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("dead");
    expect(row.lastStatus).toBe(503);
    expect(row.lastError).toBe("http 503 (retryable)");
    expect(row.deadAt).not.toBeNull();
    expect(st.fetchCalls).toHaveLength(3);
  });

  it("event filters: an all-events endpoint and a filtered endpoint each get their due share", async () => {
    const st = mk();
    addEndpoint(st, { name: "all", secret: null });
    addEndpoint(st, { name: "fails-only", secret: null, events: ["job.failed"] });
    const job = createJob(st.jobs);

    expect(st.dispatcher.publish(job.id, "job.succeeded")).toBe(1);
    expect(st.dispatcher.publish(job.id, "job.failed")).toBe(2);

    const rows = st.deliveries.list({ jobId: job.id }).items;
    expect(rows).toHaveLength(3);
    const events = rows.map((r) => r.eventType).sort();
    expect(events).toEqual(["job.failed", "job.failed", "job.succeeded"]);
  });

  it("pending rows survive: a fresh dispatcher on the same repos drains them (durability)", async () => {
    const st = mk();
    addEndpoint(st, { name: "ep", secret: null });
    const job = createJob(st.jobs);
    st.dispatcher.publish(job.id, "job.created");
    // No tick yet — the outbox row is pending, exactly as after a crash.

    const second = new WebhookDispatcher({
      endpoints: st.endpoints,
      deliveries: st.deliveries,
      jobs: st.jobs,
      artifacts: st.artifacts,
      vault: st.vault,
      allowlist: [],
      allowLoopback: true,
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      timeoutMs: 5000,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
      now: () => Date.now(),
      resolveIps: (h: string) => Promise.resolve([h]),
      log: () => {},
    });
    expect(await second.tick()).toBe(1);
    await second.stop();

    const row = st.deliveries.list({ jobId: job.id }).items[0]!;
    expect(row.status).toBe("delivered");
    expect(st.fetchCalls).toHaveLength(0); // the first dispatcher never fired
  });
});

describe("webhook API surface (real app, mock provider)", () => {
  let ctx: AppContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    ctx = await makeAppContext({ NLO_WEBHOOK_ALLOW_LOOPBACK: "1" });
    app = await buildApp(ctx);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await ctx.close();
  });

  it("CRUD: create (secret once) -> list/get (no secret) -> patch -> rotate -> delete (vault cleaned)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "ci", url: "https://example.com/hook" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as Record<string, unknown>;
    expect(String(body.id)).toMatch(/^whk_/);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hasSecret).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.enabled).toBe(true);
    const id = String(body.id);

    const list = await app.inject({ method: "GET", url: "/api/webhooks" });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { items: Record<string, unknown>[]; total: number };
    expect(listBody.total).toBe(1);
    expect("secret" in listBody.items[0]!).toBe(false);

    const one = await app.inject({ method: "GET", url: `/api/webhooks/${id}` });
    expect(one.statusCode).toBe(200);
    expect("secret" in one.json()).toBe(false);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/webhooks/${id}`,
      payload: { events: ["job.failed"], enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().enabled).toBe(false);
    expect(patched.json().events).toEqual(["job.failed"]);

    const rotated = await app.inject({
      method: "PATCH",
      url: `/api/webhooks/${id}`,
      payload: { secret: "f".repeat(64) },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).toBe("f".repeat(64));

    const del = await app.inject({ method: "DELETE", url: `/api/webhooks/${id}` });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/api/webhooks/${id}` });
    expect(gone.statusCode).toBe(404);
    expect(ctx.vault.has(`webhook:${id}`)).toBe(false);
  });

  it("validation: non-http(s) url and short secret -> 400; duplicate name -> 409", async () => {
    const badUrl = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "a", url: "ftp://example.com/h" },
    });
    expect(badUrl.statusCode).toBe(400);

    const shortSecret = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "b", url: "https://example.com/h", secret: "short" },
    });
    expect(shortSecret.statusCode).toBe(400);

    const first = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "dup", url: "https://example.com/h" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "dup", url: "https://other.example.com/h" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("v1 scopes: jobs:read cannot manage webhooks (403), admin can (200)", async () => {
    const reader = ctx.apiTokens.create({ name: "r", scopes: ["jobs:read"] });
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: { authorization: `Bearer ${reader.plaintext}` },
      payload: { name: "x", url: "https://example.com/h" },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = ctx.apiTokens.create({ name: "a", scopes: ["admin"] });
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: { authorization: `Bearer ${admin.plaintext}` },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("manual test delivery reaches a real local receiver, signed, and the log stays secret-free", async () => {
    const secret = "b".repeat(64);
    const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/webhooks",
        payload: { name: "local", url: `http://127.0.0.1:${port}/hook`, secret },
      });
      expect(created.statusCode).toBe(201);
      const id = String((created.json() as Record<string, unknown>).id);

      const test = await app.inject({ method: "POST", url: `/api/webhooks/${id}/test` });
      expect(test.statusCode).toBe(202);
      const { deliveryId } = test.json() as { deliveryId: string };
      expect(deliveryId).toMatch(/^dlv_/);

      const deadline = Date.now() + 5000;
      while (hits.length === 0 && Date.now() < deadline) {
        await ctx.webhooks.dispatcher.tick();
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(hits).toHaveLength(1);

      const hit = hits[0]!;
      expect(hit.headers["x-nlo-event"]).toBe("webhook.test");
      expect(hit.headers["x-nlo-delivery-id"]).toBe(deliveryId);
      const sig = String(hit.headers["x-nlo-signature"]);
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const [tPart, v1Part] = sig.split(",");
      expect(
        createHmac("sha256", secret)
          .update(`${tPart?.slice(2)}.${hit.body}`)
          .digest("hex"),
      ).toBe(v1Part?.slice(3));
      const payload = JSON.parse(hit.body) as Record<string, unknown>;
      expect(payload.event).toBe("webhook.test");
      expect(payload.note).toBe("manual test delivery");

      const log = await app.inject({ method: "GET", url: `/api/webhooks/${id}/deliveries` });
      expect(log.statusCode).toBe(200);
      const logBody = log.json() as { items: Record<string, unknown>[]; total: number };
      expect(logBody.total).toBe(1);
      expect(logBody.items[0]!.status).toBe("delivered");
      expect("payload" in logBody.items[0]!).toBe(false);
      expect("secret" in logBody.items[0]!).toBe(false);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("runner integration: job.running + job.succeeded are enqueued; SSRF-blocked rows dead-letter (no network)", async () => {
    addAccount(ctx.accounts, "acct");
    const node = addNode(ctx.proxies, ctx.vault, "node");
    markHealthy(ctx.proxies, node.id);

    // example.com is NOT in the allowlist -> deliveries must fail closed
    // (dead-lettered by the SSRF gate) without any real egress.
    const created = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "ext", url: "https://example.com/hook" },
    });
    expect(created.statusCode).toBe(201);
    const id = String((created.json() as Record<string, unknown>).id);

    const job = createJob(ctx.jobs);
    const done = await ctx.runner.run(job.id);
    expect(done.status).toBe("SUCCEEDED");

    const events = ctx.webhooks.deliveries.list({ jobId: job.id }).items.map((r) => r.eventType);
    expect(events).toContain("job.running");
    expect(events).toContain("job.succeeded");

    const deadline = Date.now() + 5000;
    while (ctx.webhooks.deliveries.list({ status: "pending" }).total > 0 && Date.now() < deadline) {
      await ctx.webhooks.dispatcher.tick();
    }
    const after = ctx.webhooks.deliveries.list({ endpointId: id }).items;
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const d of after) {
      expect(d.status).toBe("dead");
      expect(d.lastError).toMatch(/^ssrf_blocked:/);
    }
  });

  it("text job: job.created is enqueued with the real DB snapshot; cancel emits job.cancelled", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { name: "t16", url: "https://example.com/hook" },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: "/api/notebooks/from-text",
      payload: { text: "hello world" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string };
    expect(body.status).toBe("CREATED");

    const rows = ctx.webhooks.deliveries.list({ jobId: body.jobId }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe("job.created");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.jobId).toBe(body.jobId);
    expect(payload.status).toBe("CREATED");
    expect(payload.event).toBe("job.created");

    const cancel = await app.inject({ method: "POST", url: `/api/jobs/${body.jobId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe("CANCELLED");

    const rows2 = ctx.webhooks.deliveries.list({ jobId: body.jobId }).items;
    expect(rows2).toHaveLength(2);
    expect(rows2.find((r) => r.eventType === "job.cancelled")).toBeDefined();
  });
});
