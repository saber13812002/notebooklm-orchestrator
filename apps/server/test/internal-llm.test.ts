import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { createInternalLlmClient, type LlmResult } from "../src/internal-llm.js";

const VAR = "NLO_INTERNAL_API_BASE_URL";
const LEGACY_IP = "172.20.1.52";
let savedVar: string | undefined;

afterEach(() => {
  if (savedVar === undefined) delete process.env[VAR];
  else process.env[VAR] = savedVar;
});

function startMock(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          srv.closeAllConnections();
          return new Promise<void>((r) => srv.close(() => r()));
        },
      });
    });
  });
}

/**
 * Phase E (server endpoint migration addendum): integration tests for the
 * internal LLM proxy client. Level: **Unit/Integration — in-process mock
 * HTTP only, NOT live**. They prove: (1) the client targets the configured
 * base URL with correct auth semantics; (2) the legacy host 172.20.1.52 is
 * never referenced (string-level, no network); (3) clean, redacted errors
 * when the proxy is down, errors, or times out.
 */
describe("internal-llm client (in-process mock HTTP, not live)", () => {
  it("defaults to the new internal host and never references the legacy IP (no network)", () => {
    savedVar = process.env[VAR];
    delete process.env[VAR];
    const c = loadConfig({});
    expect(c.internalApiBaseUrl).toBe("http://172.30.0.133:4000");
    expect(c.internalApiBaseUrl).not.toContain(LEGACY_IP);
    const u = new URL("/v1/models", c.internalApiBaseUrl);
    expect(u.host).toBe("172.30.0.133:4000");
    expect(u.href).not.toContain(LEGACY_IP);
  });

  it("GET /v1/models sends the Bearer key and returns the parsed body", async () => {
    let auth: string | undefined;
    let pathSeen: string | undefined;
    const mock = await startMock((req, res) => {
      auth = req.headers.authorization;
      pathSeen = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    });
    const client = createInternalLlmClient(loadConfig({ NLO_INTERNAL_API_BASE_URL: mock.url }));
    const res = await client.listModels("sk-test-abc123");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      const ids = (res.data as { data: { id: string }[] }).data.map((m) => m.id);
      expect(ids).toEqual(["gpt-4o", "gpt-4o-mini"]);
    }
    expect(auth).toBe("Bearer sk-test-abc123");
    expect(pathSeen).toBe("/v1/models");
    await mock.close();
  });

  it("reports llm_unreachable with a clean message (no stack, no key) when the proxy is down", async () => {
    // Bind an ephemeral port, release it, then target it: nothing listens -> ECONNREFUSED.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));

    const client = createInternalLlmClient(
      loadConfig({ NLO_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}` }),
    );
    const KEY = "supersecret-key-xyz";
    const res = await client.request({ path: "/v1/models", apiKey: KEY });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("llm_unreachable");
      expect(res.message).toContain(`127.0.0.1:${port}`);
      expect(res.message).not.toContain("at ");
      expect(res.message).not.toContain(KEY);
      expect(res.message).not.toMatch(/Error:|stack/i);
    }
  });

  it("surfaces the upstream 401 message without leaking the key or headers", async () => {
    const KEY = "supersecret-key-xyz";
    const mock = await startMock((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      // Exact LiteLLM envelope observed 2026-11-01 (Phase B).
      res.end(
        JSON.stringify({
          error: { message: "No api key passed in", type: "invalid_request_error", code: null },
        }),
      );
    });
    const client = createInternalLlmClient(loadConfig({ NLO_INTERNAL_API_BASE_URL: mock.url }));
    const res: LlmResult<unknown> = await client.request({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: "gpt-4o", messages: [] },
      apiKey: KEY,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("llm_error");
      expect(res.status).toBe(401);
      expect(res.message).toContain("No api key passed in");
      expect(res.message).not.toContain(KEY);
      expect(res.message.toLowerCase()).not.toContain("authorization");
      expect(res.message.toLowerCase()).not.toContain("bearer");
    }
    await mock.close();
  });

  it("reports llm_timeout when the proxy accepts but never responds", async () => {
    const srv = createServer((req) => {
      // Accept the connection, never send a response.
      req.on("error", () => undefined);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const { port } = srv.address() as AddressInfo;

    const client = createInternalLlmClient(
      loadConfig({ NLO_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}` }),
    );
    const t0 = Date.now();
    const res = await client.request({ path: "/v1/models", timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("llm_timeout");
      expect(res.message).toContain("did not respond");
      expect(res.message).toContain(`127.0.0.1:${port}`);
    }
    expect(elapsed).toBeLessThan(5000);
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("rejects paths outside the /v1/... surface before any network call", async () => {
    let hits = 0;
    const mock = await startMock((req, res) => {
      hits += 1;
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    const client = createInternalLlmClient(loadConfig({ NLO_INTERNAL_API_BASE_URL: mock.url }));
    for (const p of ["/openapi.json", "/health", "/v1", "v1/models", "/v1/../../etc/passwd"]) {
      const res = await client.request({ path: p });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("llm_error");
        expect(res.message).toContain("invalid internal LLM path");
        expect(res.message).not.toContain(mock.url);
      }
    }
    expect(hits).toBe(0);
    await mock.close();
  });
});
