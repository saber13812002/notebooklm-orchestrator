/**
 * NLO-P4-1D / C4 — Failure classes (audit map §4.4).
 *
 * The mock provider's five scenario classes are driven through the EXISTING
 * runner and each must map onto the declared failure-class policy:
 *
 *   auth        -> FAILED errorClass "auth"; account -> AUTH_REQUIRED;
 *                  NON-retryable: exactly ONE runJob call.
 *   rate_limit  -> FAILED "rate_limit" after all maxAttempts (default 3);
 *                  account -> RATE_LIMITED (still eligible — the row flag
 *                  only excludes AUTH_REQUIRED/DISABLED from selection).
 *   transient   -> FAILED "provider" after all maxAttempts; account -> DEGRADED.
 *   ambiguous   -> NEEDS_ATTENTION after EXACTLY ONE call (completion
 *                  unknown => NEVER auto-retryed); account stays ACTIVE.
 *
 * ("ok" is the happy path, covered by C2/C3.) Each scenario gets a fresh,
 * isolated stack so account state never leaks between cases.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderJobRequest, ProviderJobResult } from "../../src/providers/types.js";
import { createJob, type TestParts } from "../helpers.js";
import { makeConformanceParts } from "./runner.js";

const partsList: TestParts[] = [];

afterEach(() => {
  while (partsList.length) partsList.pop()!.dispose();
});

interface Ctx {
  parts: TestParts;
  accountId: string;
  calls: { n: number };
}

function setupScenario(scenario: "auth" | "rate_limit" | "transient" | "ambiguous"): Ctx {
  const parts = makeConformanceParts();
  partsList.push(parts);
  parts.provider.setScenario(parts.accountId, scenario);

  // Count provider invocations (retry policy is proven by the CALL COUNT,
  // not by the terminal status alone).
  const calls = { n: 0 };
  const orig = parts.provider.runJob.bind(parts.provider);
  parts.provider.runJob = async (req: ProviderJobRequest): Promise<ProviderJobResult> => {
    calls.n += 1;
    return orig(req);
  };
  return { parts, accountId: parts.accountId, calls };
}

describe("C4 failure classes (mock scenario matrix)", () => {
  it("auth -> FAILED 'auth', no retry, account AUTH_REQUIRED", async () => {
    const { parts, accountId, calls } = setupScenario("auth");
    const job = createJob(parts.jobs, "test prompt");
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("auth");
    expect(calls.n).toBe(1); // non-retryable: exactly one attempt
    expect(parts.accounts.get(accountId)?.status).toBe("AUTH_REQUIRED");
  });

  it("rate_limit -> FAILED 'rate_limit' after maxAttempts, account RATE_LIMITED", async () => {
    const { parts, accountId, calls } = setupScenario("rate_limit");
    const job = createJob(parts.jobs, "test prompt");
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("rate_limit");
    expect(calls.n).toBe(job.maxAttempts); // bounded retries
    expect(parts.accounts.get(accountId)?.status).toBe("RATE_LIMITED");
  });

  it("transient -> FAILED 'provider' after maxAttempts, account DEGRADED", async () => {
    const { parts, accountId, calls } = setupScenario("transient");
    const job = createJob(parts.jobs, "test prompt");
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("FAILED");
    expect(done.errorClass).toBe("provider");
    expect(calls.n).toBe(job.maxAttempts);
    expect(parts.accounts.get(accountId)?.status).toBe("DEGRADED");
  });

  it("ambiguous -> NEEDS_ATTENTION after exactly one call, account stays ACTIVE", async () => {
    const { parts, accountId, calls } = setupScenario("ambiguous");
    const job = createJob(parts.jobs, "test prompt");
    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("NEEDS_ATTENTION");
    expect(done.errorClass).toBe("ambiguous");
    expect(calls.n).toBe(1); // completion unknown: never auto-retry
    expect(parts.accounts.get(accountId)?.status).toBe("ACTIVE");
  });
});
