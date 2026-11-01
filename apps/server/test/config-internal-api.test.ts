import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const VAR = "NLO_INTERNAL_API_BASE_URL";
let saved: string | undefined;

afterEach(() => {
  if (saved === undefined) delete process.env[VAR];
  else process.env[VAR] = saved;
});

/**
 * Phase C (server endpoint migration addendum): the internal LLM proxy base
 * URL (NLO_INTERNAL_API_BASE_URL) — verified 2026-11-01 to be LiteLLM
 * (OpenAI-compatible) at http://172.30.0.133:4000. Config-level tests only;
 * no network calls.
 */
describe("config: internal LLM proxy base URL", () => {
  it("defaults to the verified internal endpoint (no trailing slash)", () => {
    saved = process.env[VAR];
    delete process.env[VAR];
    const c = loadConfig({});
    expect(c.internalApiBaseUrl).toBe("http://172.30.0.133:4000");
  });

  it("accepts an explicit override and normalizes trailing slashes", () => {
    const c = loadConfig({ NLO_INTERNAL_API_BASE_URL: "http://10.0.0.5:4000///" });
    expect(c.internalApiBaseUrl).toBe("http://10.0.0.5:4000");
  });

  it("accepts https URLs", () => {
    const c = loadConfig({ NLO_INTERNAL_API_BASE_URL: "https://llm.example.local:8443" });
    expect(c.internalApiBaseUrl).toBe("https://llm.example.local:8443");
  });

  it("rejects values without a scheme (fail fast)", () => {
    expect(() => loadConfig({ NLO_INTERNAL_API_BASE_URL: "172.30.0.133:4000" })).toThrow(
      /invalid NLO_INTERNAL_API_BASE_URL/,
    );
  });

  it("rejects non-http(s) schemes (e.g. file://)", () => {
    expect(() => loadConfig({ NLO_INTERNAL_API_BASE_URL: "file:///etc/passwd" })).toThrow(
      /invalid NLO_INTERNAL_API_BASE_URL/,
    );
  });
});
