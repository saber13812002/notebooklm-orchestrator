import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { JobArchive } from "../src/domain/archive.js";
import {
  makeParts,
  addAccount,
  addNode,
  createJob,
  markHealthy,
  type TestParts,
} from "./helpers.js";

/**
 * Job lifecycle tests: happy path, bounded retry, cancellation, and the
 * archive layout (manifest / prompt / timeline / attempts / errors / answer).
 */

let parts: TestParts;

afterEach(() => parts.dispose());

function setupHappy() {
  parts = makeParts();
  const acct = addAccount(parts.accounts, "acct-1");
  const node = addNode(parts.proxies, parts.vault, "n1");
  markHealthy(parts.proxies, node.id);
  return { acct, node };
}

describe("happy path", () => {
  it("runs CREATED -> ... -> SUCCEEDED and writes the full archive", async () => {
    setupHappy();
    const job = createJob(parts.jobs, "summarize the audio");
    const result = await parts.runner.run(job.id);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.progress).toBe(100);
    expect(result.answerMarkdown).toMatch(/Mock Answer/);
    expect(result.answerMarkdown).toMatch(/summarize the audio/);

    // All egress went through the tunnel.
    expect(parts.egress.attempts.length).toBeGreaterThan(0);
    expect(parts.egress.attempts.every((a) => a.viaTunnel)).toBe(true);

    // Archive layout.
    const root = path.join(parts.jobsDir, job.id);
    expect(existsSync(path.join(root, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(root, "input", "prompt.md"))).toBe(true);
    expect(readFileSync(path.join(root, "input", "prompt.md"), "utf8")).toBe("summarize the audio");
    expect(existsSync(path.join(root, "execution", "timeline.jsonl"))).toBe(true);
    expect(existsSync(path.join(root, "execution", "attempts.json"))).toBe(true);
    expect(existsSync(path.join(root, "output", "answer.md"))).toBe(true);

    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(manifest.jobId).toBe(job.id);

    const timeline = readFileSync(path.join(root, "execution", "timeline.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const types = timeline.map((e) => e.type);
    expect(types).toContain("validate");
    expect(types).toContain("account_selected");
    expect(types).toContain("proxy_selected");
    expect(types).toContain("succeeded");

    // The mock artifact is stored under a sanitized name with index prefix.
    const db = parts.db.raw.prepare("SELECT * FROM artifacts WHERE job_id = ?").all(job.id) as {
      filename: string;
      storage_key: string;
      source: string;
    }[];
    expect(db.length).toBe(1);
    const artRow = db[0]!;
    expect(artRow.source).toBe("provider");
    expect(artRow.storage_key).toMatch(/^output\/artifacts\/1-/);
    expect(existsSync(path.join(root, artRow.storage_key))).toBe(true);
  });

  it("records account success on completion", async () => {
    const { acct } = setupHappy();
    const job = createJob(parts.jobs);
    await parts.runner.run(job.id);
    expect(parts.accounts.get(acct.id)?.lastSuccessAt).not.toBeNull();
  });

  it("persists verifiable operation IDs from the provider report into the jobs row", async () => {
    // Regression: the python worker reports the REAL NotebookLM
    // notebook/source/conversation IDs in providerMeta, but the runner's
    // SUCCEEDED patch dropped them — the jobs table columns (notebook_id,
    // source_id, conversation_id) stayed NULL for every live success, so a
    // "real" result was not auditable at the destination service.
    setupHappy();
    const job = createJob(parts.jobs);
    parts.provider.runJob = async (_req) => ({
      answerMarkdown: "# Real answer",
      providerMeta: {
        provider: "python-worker",
        simulated: false,
        email: "user@example.com",
        notebookId: "nb-123",
        notebookTitle: "nlo-test",
        sourceId: "src-456",
        conversationId: "conv-789",
      },
      artifacts: [],
    });
    const result = await parts.runner.run(job.id);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.notebookId).toBe("nb-123");
    expect(result.notebookTitle).toBe("nlo-test");
    expect(result.sourceId).toBe("src-456");
    expect(result.conversationId).toBe("conv-789");
    // The persisted row (a fresh read, not the in-memory return) carries them.
    const stored = parts.db.raw
      .prepare(
        "SELECT notebook_id, notebook_title, source_id, conversation_id FROM jobs WHERE id = ?",
      )
      .get(job.id) as {
      notebook_id: string | null;
      notebook_title: string | null;
      source_id: string | null;
      conversation_id: string | null;
    };
    expect(stored.notebook_id).toBe("nb-123");
    expect(stored.notebook_title).toBe("nlo-test");
    expect(stored.source_id).toBe("src-456");
    expect(stored.conversation_id).toBe("conv-789");
  });

  it("keeps operation ID columns null when the provider reports none", async () => {
    setupHappy();
    const job = createJob(parts.jobs);
    await parts.runner.run(job.id); // plain mock provider: no IDs in meta
    const result = parts.jobs.get(job.id)!;
    expect(result.status).toBe("SUCCEEDED");
    expect(result.notebookId).toBeNull();
    expect(result.sourceId).toBeNull();
    expect(result.conversationId).toBeNull();
  });

  it("a second run on a non-QUEUED job is a no-op (idempotency)", async () => {
    setupHappy();
    const job = createJob(parts.jobs);
    await parts.runner.run(job.id);
    const again = await parts.runner.run(job.id);
    expect(again.status).toBe("SUCCEEDED");
    expect(parts.jobs.attempts(job.id).length).toBe(1);
  });
});

describe("bounded retry", () => {
  it("retries transient provider errors, then succeeds", async () => {
    setupHappy();
    // First attempt fails, subsequent attempts succeed.
    let calls = 0;
    const originalRun = parts.provider.runJob.bind(parts.provider);
    parts.provider.runJob = async (req) => {
      calls += 1;
      if (calls === 1) {
        parts.provider.setScenario(req.accountId, "transient");
        try {
          return await originalRun(req);
        } finally {
          parts.provider.setScenario(req.accountId, "ok");
        }
      }
      return originalRun(req);
    };
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toBe(2);
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.outcome).toBe("retrying");
    expect(attempts[1]?.outcome).toBe("ok");
  });

  it("fails after exhausting max_attempts with a retryable error", async () => {
    const { acct } = setupHappy();
    parts.provider.setScenario(acct.id, "transient");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("provider");
    // max_attempts=3 => 3 attempts, all recorded.
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts.length).toBe(3);
    expect(attempts.slice(0, 2).every((a) => a.outcome === "retrying")).toBe(true);
    expect(attempts[2]?.outcome).toBe("failed");
    // Account was marked DEGRADED.
    expect(parts.accounts.get(acct.id)?.status).toBe("DEGRADED");
  });

  it("does NOT auto-retry auth failures (marks account AUTH_REQUIRED)", async () => {
    const { acct } = setupHappy();
    parts.provider.setScenario(acct.id, "auth");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("auth");
    expect(parts.jobs.attempts(job.id)).toHaveLength(1);
    expect(parts.accounts.get(acct.id)?.status).toBe("AUTH_REQUIRED");
  });
});

describe("cancellation", () => {
  it("cancels a running job (RUNNING -> CANCEL_REQUESTED -> CANCELLED)", async () => {
    setupHappy();
    (parts.provider as { delayMs: number }).delayMs = 300;
    const job = createJob(parts.jobs);
    const runPromise = parts.runner.run(job.id);
    // Wait until the job is RUNNING.
    for (let i = 0; i < 100 && parts.jobs.get(job.id)!.status !== "RUNNING"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(parts.jobs.get(job.id)!.status).toBe("RUNNING");
    const ok = parts.runner.cancel(job.id);
    expect(ok).toBe(true);
    const result = await runPromise;
    expect(result.status).toBe("CANCELLED");
    const events = parts.jobs.events(job.id).map((e) => e.type);
    expect(events).toContain("cancelled");
  });

  it("a late provider success after cancel stays CANCELLED (no spurious ok-attempt, no throw)", async () => {
    // Regression: a real python worker may finish its operation AFTER the
    // cancel request arrives (server-side completion cannot always be
    // interrupted). Before the fix, the success path first recorded an "ok"
    // attempt and a provider success on the account, then called
    // setStatus(RUNNING -> SUCCEEDED) which the state machine rejects once
    // the job is CANCEL_REQUESTED — leaving a misleading "ok" attempt on a
    // cancelled job. Cancellation must win cleanly: exactly ONE attempt,
    // outcome "cancelled".
    setupHappy();
    const job = createJob(parts.jobs);
    // Simulate a worker whose operation completes normally even though the
    // abort signal fired mid-flight (server-side completion).
    parts.provider.runJob = async (_req) => {
      await new Promise((r) => setTimeout(r, 200));
      return {
        answerMarkdown: "# Late answer",
        providerMeta: { provider: "mock", simulated: true },
        artifacts: [],
      };
    };
    const runPromise = parts.runner.run(job.id);
    for (let i = 0; i < 100 && parts.jobs.get(job.id)!.status !== "RUNNING"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(parts.jobs.get(job.id)!.status).toBe("RUNNING");

    // Emulate the API cancel route on a RUNNING job: mark CANCEL_REQUESTED,
    // then abort the runner's controller.
    parts.jobs.setStatus(job.id, "CANCEL_REQUESTED");
    expect(parts.runner.cancel(job.id)).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("CANCELLED");
    const events = parts.jobs.events(job.id).map((e) => e.type);
    expect(events).toContain("cancelled");
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("cancelled");
  });

  it("a job sitting in CANCEL_REQUESTED is terminated by a failure handler (no orphan)", async () => {
    // Regression: a cancel on a RUNNING job sets CANCEL_REQUESTED and aborts
    // the runner's controller. If the abort signal does not reach the
    // in-flight provider (a real python worker stalled inside notebooklm-py
    // cannot always be interrupted server-side), the failure path used to
    // treat it as an ordinary provider error and the job sat in
    // CANCEL_REQUESTED forever — an orphan the queue never picks up and the
    // UI cannot cancel again. handleFailure must route a CANCEL_REQUESTED
    // job to CANCELLED regardless of whether the error was an abort.
    setupHappy();
    const job = createJob(parts.jobs);
    // Drive the job through the legal pre-attempt states to CANCEL_REQUESTED,
    // exactly what the API cancel route does for a RUNNING job.
    parts.jobs.setStatus(job.id, "VALIDATING");
    parts.jobs.setStatus(job.id, "QUEUED");
    parts.jobs.setStatus(job.id, "WAITING_FOR_ACCOUNT");
    parts.jobs.setStatus(job.id, "WAITING_FOR_PROXY");
    parts.jobs.setStatus(job.id, "RUNNING");
    parts.jobs.setStatus(job.id, "CANCEL_REQUESTED");

    const handler = (parts.runner as unknown as {
      handleFailure: (
        jobId: string,
        accountId: string,
        attemptNo: number,
        nodeId: string | null,
        attemptStart: string,
        archive: JobArchive,
        err: unknown,
        wasAborted: boolean,
      ) => Promise<"terminal" | "retry">;
    }).handleFailure.bind(parts.runner);

    // A NON-aborted failure (the provider was merely stalled when the cancel
    // landed) must still terminate the job as CANCELLED.
    const archive = new JobArchive(parts.jobsDir, job.id);
    const outcome = await handler(
      job.id,
      "acc-x",
      1,
      "n1",
      new Date().toISOString(),
      archive,
      new Error("worker request timed out"),
      false,
    );
    expect(outcome).toBe("terminal");
    expect(parts.jobs.get(job.id)!.status).toBe("CANCELLED");
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.outcome).toBe("cancelled");
  });

  it("run() is a no-op for jobs not in CREATED/QUEUED", async () => {
    setupHappy();
    const job = createJob(parts.jobs);
    parts.jobs.setStatus(job.id, "VALIDATING");
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("VALIDATING");
    expect(parts.jobs.attempts(job.id)).toHaveLength(0);
  });
});
