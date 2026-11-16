/**
 * NLO-P4-1D / C6 — Egress boundary (audit map §4.4).
 *
 * F-C3 (fail-closed egress): provider traffic may only flow through an egress
 * ENDPOINT acquired from the Egress Gateway (loopback port + node identity +
 * evidence). The mock egress transport records every attempt, so this suite
 * asserts that no direct dial ever happened:
 *
 *  1. A healthy podcast job succeeds and EVERY provider egress call goes
 *     through the tunnel (zero direct dials, zero failures).
 *  2. A tunnel that dies mid-job fails the job with class `proxy`
 *     (fail-closed: the retry cannot re-acquire a route, the job terminalizes
 *     FAILED — never a silent direct fallback).
 *  3. With no proxy node at all, the job fails BEFORE any provider egress
 *     (fail-closed: refusing direct egress).
 *  4. A provider-level call with a null endpoint is rejected by the egress
 *     transport itself (DirectEgressBlockedError + a recorded no-tunnel
 *     attempt).
 *
 * Mock-level conformance: C7 (real NotebookLM over real tunnels) is the
 * manual live gate and is never run here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DirectEgressBlockedError } from "../../src/proxy/egress.js";
import type { EgressEndpoint } from "../../src/proxy/gateway.js";
import { addAccount, createJob, makeParts, type TestParts } from "../helpers.js";
import { makeConformanceParts } from "./runner.js";

const partsList: TestParts[] = [];

afterEach(() => {
  while (partsList.length) partsList.pop()!.dispose();
});

function track<T extends TestParts>(parts: T): T {
  partsList.push(parts);
  return parts;
}

/** Count job_attempts rows (the durable record of every settled attempt). */
function attemptRows(parts: TestParts, jobId: string): Record<string, unknown>[] {
  const raw = (
    parts.db as unknown as {
      raw: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } };
    }
  ).raw;
  return raw.prepare("SELECT * FROM job_attempts WHERE job_id = ?").all(jobId);
}

type EgressBody = { method: string; path: string; headers: Record<string, string>; body?: string };

describe("C6 egress boundary (notebooklm.web adapter, mock level)", () => {
  it("healthy podcast job: every provider egress call goes through the tunnel (no direct dials)", async () => {
    const parts = track(makeConformanceParts());
    const job = createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("SUCCEEDED");
    // The fused ask + the audio submission are the only provider egress calls
    // (status polling and the artifact download make no egress calls in the
    // mock provider).
    expect(parts.egress.attempts).toHaveLength(2);
    for (const a of parts.egress.attempts) {
      expect(a.viaTunnel).toBe(true);
      expect(a.ok).toBe(true);
      expect(a.tunnelNodeId).toBe(parts.nodeId);
    }
    expect(parts.egress.attempts.filter((a) => !a.viaTunnel)).toHaveLength(0);
  });

  it("tunnel death mid-job: job FAILS with class proxy (fail-closed, never a direct fallback)", async () => {
    const parts = track(makeConformanceParts());
    const job = createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });

    // Deterministic mid-job kill: the runner hands the SAME egress object to
    // the provider. Flip the node's runtime scenario to "down" right before
    // the audio submission is sent, so that one request observes a dead
    // tunnel (no timing race, no delayMs).
    const origRequest = parts.egress.request.bind(parts.egress);
    parts.egress.request = async (
      endpoint: EgressEndpoint | null,
      target: string,
      body: EgressBody,
    ) => {
      if (body.path === "/artifacts/generate_audio") {
        parts.runtime.setScenario(parts.nodeId, "down");
      }
      return origRequest(endpoint, target, body);
    };

    const done = await parts.runner.run(job.id);

    // The dead-tunnel error classifies as `proxy` (retryable): one attempt is
    // recorded as retrying...
    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("proxy");
    expect(done.errorMessage).toContain("fail-closed");
    expect(parts.accounts.get(parts.accountId)?.status).toBe("DEGRADED");

    // ...and the retry cannot re-acquire a route (tunnel start fails against
    // the dead node), so the job terminalizes on the gateway acquisition
    // failure — before a second attempt starts.
    const attempts = attemptRows(parts, job.id);
    expect(attempts).toHaveLength(1);
    expect(String(attempts[0]?.outcome)).toBe("retrying");

    // Egress evidence: the ask went through the healthy tunnel; the audio
    // submission hit the dead tunnel; no direct dial ever happened.
    expect(parts.egress.attempts[0]?.viaTunnel).toBe(true);
    expect(parts.egress.attempts[0]?.ok).toBe(true);
    const dead = parts.egress.attempts.find((a) => a.error?.includes("tunnel down"));
    expect(dead).toBeDefined();
    expect(dead?.ok).toBe(false);
    expect(dead?.viaTunnel).toBe(true);
    expect(parts.egress.attempts.filter((a) => !a.viaTunnel)).toHaveLength(0);
  });

  it("no proxy node at all: job FAILS before any provider egress (refusing direct egress)", async () => {
    const parts = track(makeParts());
    const accountId = addAccount(parts.accounts, "c6-nonode@example.com").id;
    const job = createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("proxy");
    expect(done.errorMessage).toContain("no enabled proxy node configured");
    expect(done.errorMessage).toContain("fail-closed");
    // The failure happened during gateway acquisition — before any provider
    // egress and before any attempt started.
    expect(parts.egress.attempts).toHaveLength(0);
    expect(attemptRows(parts, job.id)).toHaveLength(0);
    // The account never saw a provider error (it was selected successfully).
    expect(parts.accounts.get(accountId)?.status).toBe("ACTIVE");
  });

  it("provider-level null endpoint: egress transport rejects (DirectEgressBlockedError, no tunnel)", async () => {
    const parts = track(makeConformanceParts());
    const before = parts.egress.attempts.length;

    await expect(
      parts.provider.generateAudio({
        jobId: "j_c6null0000000000000",
        accountId: parts.accountId,
        credentialRef: `session:${parts.accountId}`,
        notebookId: "mock_nb_c6null",
        endpoint: null,
        egress: parts.egress,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow(DirectEgressBlockedError);

    const added = parts.egress.attempts.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual({
      viaTunnel: false,
      tunnelNodeId: null,
      target: "notebooklm.google.com:443",
      ok: false,
      error: "no tunnel (fail-closed)",
    });
  });
});
