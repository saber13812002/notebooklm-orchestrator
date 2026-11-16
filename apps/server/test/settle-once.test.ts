import { afterEach, describe, expect, it } from "vitest";
import { ArtifactRepo } from "../src/domain/artifacts.repo.js";
import { JobLocks, DEFAULT_LOCK_TTL_MS, lockTtlFor } from "../src/domain/jobs.lock.js";
import type {
  NotebookLMProvider,
  ProviderJobRequest,
  ProviderJobResult,
} from "../src/providers/types.js";
import { JobRunner } from "../src/queue/job-runner.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "./helpers.js";

/**
 * NLO-P4-1C — durable job execution locks (settle-once).
 *
 * The lock table `job_locks` guarantees that at most one LIVE instance
 * drives a job from CREATED/QUEUED to a terminal state:
 *   F9    — a second holder cannot acquire while a live lock is held;
 *   F-C4  — a crashed holder's stale lock is cleared by the next boot's
 *           resetAll(), so restart recovery is never wedged by a dead
 *           instance;
 *   TTL   — a stale lock becomes stealable only after it expires, so a
 *           live holder is never dislodged mid-job.
 * The runner acquires the lock before driving the job (at run() entry) and
 * releases it on every exit path (terminal settle, yield, error).
 */

const TTL = 40 * 60_000;

class OkProvider implements NotebookLMProvider {
  readonly name = "ok";
  inRunJob: (() => void) | null = null;

  capabilities() {
    return [];
  }
  inputCapabilities() {
    return [];
  }
  async validateConfiguration() {
    return { ok: true, issues: [] };
  }
  async getAccountStatus() {
    return { ok: true, email: null, detail: "n/a" };
  }
  async cancel() {
    return { accepted: true, note: "n/a" };
  }
  async runJob(_req: ProviderJobRequest): Promise<ProviderJobResult> {
    this.inRunJob?.();
    return { answerMarkdown: "ok", providerMeta: { simulated: true }, artifacts: [] };
  }
}

function buildRunner(parts: TestParts, provider: NotebookLMProvider): JobRunner {
  return new JobRunner({
    jobs: parts.jobs,
    accounts: parts.accounts,
    proxies: parts.proxies,
    provider,
    proxyManager: parts.proxyManager,
    gateway: parts.gateway,
    runtime: parts.runtime,
    vault: parts.vault,
    egress: parts.egress,
    jobsDir: parts.jobsDir,
    log: () => {},
    sleep: () => Promise.resolve(),
    rng: () => 0,
    artifacts: new ArtifactRepo(parts.db),
    stages: parts.stages,
    locks: parts.lock,
    lockTtlMs: TTL,
  });
}

let parts: TestParts;
afterEach(() => {
  parts.dispose();
});

function setup(): { jobId: string } {
  parts = makeParts();
  const node = addNode(parts.proxies, parts.vault, "n1");
  markHealthy(parts.proxies, node.id);
  addAccount(parts.accounts, "acct");
  const j = createJob(parts.jobs);
  return { jobId: j.id };
}

describe("JobLocks (unit)", () => {
  it("acquires a fresh lock and records the holder", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    expect(a.acquire(j, TTL)).toBe(true);
    expect(a.isHeld(j)).toBe(true);
    expect(a.holder(j)).toBe(a.holderId);
  });

  it("refuses a second holder while the lock is live (F9)", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    const b = new JobLocks(parts.db);
    expect(a.acquire(j, TTL)).toBe(true);
    expect(b.acquire(j, TTL)).toBe(false); // F9: second holder refused
    expect(a.holder(j)).toBe(a.holderId); // original holder untouched
    expect(b.acquire(j, TTL)).toBe(false); // still refused
  });

  it("re-acquisition by the current holder is idempotent", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    expect(a.acquire(j, TTL)).toBe(true);
    expect(a.acquire(j, TTL)).toBe(true);
    expect(a.holder(j)).toBe(a.holderId);
  });

  it("releases owner-only; a non-owner release is a no-op", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    const b = new JobLocks(parts.db);
    a.acquire(j, TTL);
    expect(b.release(j)).toBe(false); // non-owner
    expect(a.isHeld(j)).toBe(true); // still held
    expect(a.release(j)).toBe(true); // owner
    expect(a.isHeld(j)).toBe(false);
    expect(b.acquire(j, TTL)).toBe(true); // free again
  });

  it("steals an expired lock but not a live one (crash guard)", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    const b = new JobLocks(parts.db);
    a.acquire(j, TTL);
    expect(b.acquire(j, TTL)).toBe(false); // live → refused
    // Simulate time passing past the TTL (the holder crashed / clock advanced).
    parts.db.raw
      .prepare("UPDATE job_locks SET expires_at = ? WHERE job_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), j);
    expect(b.acquire(j, TTL)).toBe(true); // expired → stolen
    expect(a.acquire(j, TTL)).toBe(false); // b now holds the live lock
    expect(b.holder(j)).toBe(b.holderId);
  });

  it("resetAll clears locks from every holder (boot)", () => {
    parts = makeParts();
    const j1 = createJob(parts.jobs).id;
    const j2 = createJob(parts.jobs).id;
    const a = new JobLocks(parts.db);
    const b = new JobLocks(parts.db);
    a.acquire(j1, TTL);
    b.acquire(j2, TTL);
    const c = new JobLocks(parts.db);
    expect(c.resetAll()).toBe(2);
    expect(a.isHeld(j1)).toBe(false);
    expect(b.isHeld(j2)).toBe(false);
  });

  it("computes a TTL that outlives the longest job plus a margin", () => {
    parts = makeParts(); // pure-function test; stack exists only for afterEach hygiene
    expect(DEFAULT_LOCK_TTL_MS).toBe(40 * 60_000);
    expect(lockTtlFor(30 * 60_000)).toBe(40 * 60_000); // 30-min job + 10-min margin
    expect(lockTtlFor(10 * 60_000)).toBe(40 * 60_000); // floored at 30 min
    expect(lockTtlFor(45 * 60_000)).toBe(55 * 60_000); // longer jobs honored
  });
});

describe("F-C4: crash → boot resetAll → re-acquire", () => {
  it("a crashed holder's stale lock is cleared by the next boot, and the job is re-acquirable", () => {
    parts = makeParts();
    const j = createJob(parts.jobs).id;
    const dead = new JobLocks(parts.db); // "process A"
    expect(dead.acquire(j, TTL)).toBe(true);
    // Process A dies without releasing. Process B boots (its own instance).
    const boot = new JobLocks(parts.db);
    expect(boot.resetAll()).toBe(1);
    expect(dead.isHeld(j)).toBe(false);
    expect(boot.acquire(j, TTL)).toBe(true);
  });
});

describe("runner integration (settle-once)", () => {
  it("holds the lock while executing and releases it after a terminal settle", async () => {
    const { jobId } = setup();
    const provider = new OkProvider();
    provider.inRunJob = () => {
      // While the provider operation runs, this instance holds the lock.
      expect(parts.lock.isHeld(jobId)).toBe(true);
      expect(parts.lock.holder(jobId)).toBe(parts.lock.holderId);
    };
    const runner = buildRunner(parts, provider);
    const done = await runner.run(jobId);
    expect(done.status).toBe("SUCCEEDED");
    expect(parts.lock.isHeld(jobId)).toBe(false); // released on settle
  });

  it("stands down while another instance holds a live lock (settle-once)", async () => {
    const { jobId } = setup();
    const other = new JobLocks(parts.db); // a live second instance
    expect(other.acquire(jobId, TTL)).toBe(true);
    const runner = buildRunner(parts, new OkProvider());
    const job = await runner.run(jobId);
    // The job is untouched: still not started, the other instance's lock intact.
    expect(["CREATED", "QUEUED"]).toContain(job.status);
    expect(other.isHeld(jobId)).toBe(true);
    expect(parts.lock.holder(jobId)).toBe(other.holderId);
  });

  it("does not wedge on a stale lock after a boot resetAll (crash recovery)", async () => {
    const { jobId } = setup();
    const dead = new JobLocks(parts.db);
    dead.acquire(jobId, TTL); // crashed instance left its lock behind
    expect(parts.lock.resetAll()).toBe(1); // next boot clears it
    const runner = buildRunner(parts, new OkProvider());
    const done = await runner.run(jobId);
    expect(done.status).toBe("SUCCEEDED");
    expect(parts.lock.isHeld(jobId)).toBe(false);
  });
});
