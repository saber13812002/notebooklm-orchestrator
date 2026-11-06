import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db/db.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";
import { JobsRepo } from "../src/domain/jobs.repo.js";
import { ProxiesRepo } from "../src/domain/proxies.repo.js";
import { MockProviderEgress } from "../src/proxy/egress.js";
import { ProxyManager } from "../src/proxy/proxy-manager.js";
import { MockProxyRuntime } from "../src/proxy/runtime.js";
import type { NotebookLMProvider } from "../src/providers/types.js";
import {
  ProviderFailure,
  type ProviderJobRequest,
  type ProviderJobResult,
} from "../src/providers/types.js";
import { SecretVault } from "../src/secrets/vault.js";
import { JobRunner } from "../src/queue/job-runner.js";
import { Queue } from "../src/queue/queue.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "./helpers.js";

/**
 * Queue recovery regression tests — 1.1 (worker timeout & queue recovery).
 *
 * These test the RUNNER + QUEUE layer: a provider operation that times out
 * (or crashes) must terminate the job deterministically and — crucially —
 * RELEASE the single-worker queue so the next queued job runs. The wedge this
 * suite guards against: an unsettled request promise leaves `queue.busy`
 * true forever and every later job stuck in QUEUED.
 *
 * The provider is a deterministic fake (no child process): the same
 * invariants apply at this layer regardless of how the underlying provider
 * dies.
 *
 * NOTE on dequeue order: `JobsRepo.list()` orders by `created_at DESC`, so
 * the queue dequeues the MOST RECENTLY created job first (LIFO). Tests that
 * assert per-job outcomes therefore create jobs with a guaranteed-millisecond
 * gap (see `make2Jobs`) and expect the later-created job to run first.
 */

interface ScriptStep {
  kind: "ok" | "slow" | "timeout" | "crash";
}

class ScriptedProvider implements NotebookLMProvider {
  readonly name = "scripted";
  private i = 0;
  readonly calls: string[] = [];

  constructor(
    private readonly script: ScriptStep[],
    private readonly workMs = 30,
  ) {}

  capabilities() {
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
  async runJob(req: ProviderJobRequest): Promise<ProviderJobResult> {
    const step = this.script[this.i] ?? { kind: "ok" };
    this.i += 1;
    this.calls.push(req.jobId);
    await new Promise((r) => setTimeout(r, step.kind === "slow" ? this.workMs * 10 : this.workMs));
    switch (step.kind) {
      case "ok":
        return { answerMarkdown: "ok", providerMeta: { simulated: true }, artifacts: [] };
      case "slow":
        // A long-but-finite run: proves single-worker serialization without
        // any promise that never settles (which would hang queue.stop()).
        return { answerMarkdown: "slow-ok", providerMeta: { simulated: true }, artifacts: [] };
      case "timeout":
        // Mirrors PythonWorkerProvider: timeout -> provider class, ambiguous.
        throw new ProviderFailure({
          failureClass: "provider",
          message: "python-worker: python worker request timed out after 0s (op=job)",
          ambiguous: true,
          needsReauth: false,
        });
      case "crash":
        // Non-ambiguous provider error: retriable, bounded by max_attempts.
        throw new ProviderFailure({
          failureClass: "provider",
          message: "python-worker: python worker exited unexpectedly (code=3); stderr: ",
          ambiguous: false,
          needsReauth: false,
        });
    }
  }
}

function buildRunner(parts: TestParts, provider: NotebookLMProvider): JobRunner {
  const { accounts, jobs, proxies, proxyManager, runtime, vault, egress, jobsDir } = parts;
  return new JobRunner({
    jobs,
    accounts,
    proxies,
    provider,
    proxyManager,
    runtime,
    vault,
    egress,
    jobsDir,
    log: () => {},
    sleep: () => Promise.resolve(), // retries without real backoff
    rng: () => 0,
  });
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"];

async function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

let parts: TestParts;
let queue: Queue | null = null;
/** Second "process" DB connection (restart test); closed before the temp dir is removed. */
let extraDb: Db | null = null;
afterEach(async () => {
  try {
    await queue?.stop();
  } catch {
    /* ignore */
  }
  queue = null;
  try {
    extraDb?.close();
  } catch {
    /* ignore */
  }
  extraDb = null;
  parts.dispose();
});

function setup(script: ScriptStep[], workMs = 30): { provider: ScriptedProvider; nodeId: string } {
  parts = makeParts();
  const node = addNode(parts.proxies, parts.vault, "n1");
  markHealthy(parts.proxies, node.id);
  addAccount(parts.accounts, "acct");
  const provider = new ScriptedProvider(script, workMs);
  queue = new Queue(buildRunner(parts, provider), 20, () => {});
  return { provider, nodeId: node.id };
}

/**
 * Create two jobs with a guaranteed >=1ms gap in `created_at`.
 * Because `list()` orders by `created_at DESC`, the queue dequeues
 * `later` FIRST, then `earlier` — the assertion in each test relies on
 * this deterministic order.
 */
async function make2Jobs(): Promise<{
  earlier: ReturnType<typeof createJob>;
  later: ReturnType<typeof createJob>;
}> {
  const earlier = createJob(parts.jobs, "earlier");
  await new Promise((r) => setTimeout(r, 5));
  const later = createJob(parts.jobs, "later");
  return { earlier, later };
}

describe("queue recovery: a dead/timed-out job must not wedge the single-worker queue", () => {
  it("worker timeout: job ends NEEDS_ATTENTION (ambiguous, never auto-retried), queue continues to the next job", async () => {
    const { provider } = setup([{ kind: "timeout" }, { kind: "ok" }]);
    const { earlier, later } = await make2Jobs();
    queue!.start();

    const done = await waitFor(() => {
      const s1 = parts.jobs.get(earlier.id)?.status;
      const s2 = parts.jobs.get(later.id)?.status;
      return TERMINAL.includes(s1 ?? "") && TERMINAL.includes(s2 ?? "");
    });

    expect(done).toBe(true);
    // Dequeue order is LIFO (created_at DESC): `later` runs first and hits
    // the timeout step; `earlier` runs second and succeeds.
    expect(parts.jobs.get(later.id)!.status).toBe("NEEDS_ATTENTION");
    expect(parts.jobs.get(later.id)!.errorClass).toBe("ambiguous");
    // The queue CONTINUED: the next job was picked up and succeeded.
    expect(parts.jobs.get(earlier.id)!.status).toBe("SUCCEEDED");
    expect(provider.calls.length).toBe(2);
    expect(provider.calls).toEqual([later.id, earlier.id]);
  }, 15_000);

  it("worker crash (non-ambiguous provider error, attempts exhausted): job FAILED, queue continues", async () => {
    const { provider } = setup([
      { kind: "crash" },
      { kind: "crash" },
      { kind: "crash" },
      { kind: "ok" },
    ]);
    const { earlier, later } = await make2Jobs();
    queue!.start();

    const done = await waitFor(() => {
      const s1 = parts.jobs.get(earlier.id)?.status;
      const s2 = parts.jobs.get(later.id)?.status;
      return TERMINAL.includes(s1 ?? "") && TERMINAL.includes(s2 ?? "");
    });

    expect(done).toBe(true);
    // `later` runs first: three crash attempts (bounded by max_attempts=3)
    // then FAILED — the queue released and `earlier` ran to SUCCEEDED.
    expect(parts.jobs.get(later.id)!.status).toBe("FAILED");
    expect(parts.jobs.get(later.id)!.errorClass).toBe("provider");
    expect(parts.jobs.get(earlier.id)!.status).toBe("SUCCEEDED");
    // Three crash attempts for `later` + one successful run for `earlier`.
    expect(provider.calls.length).toBe(4);
    expect(provider.calls.slice(0, 3)).toEqual([later.id, later.id, later.id]);
    expect(provider.calls[3]).toBe(earlier.id);
  }, 20_000);

  it("single-worker serialization: a slow in-flight job blocks the next job (no double-run), then the queue continues", async () => {
    const { provider } = setup([{ kind: "slow" }, { kind: "ok" }], 300);
    const { earlier, later } = await make2Jobs();
    queue!.start();

    // Wait until `later` (dequeued first) is actually RUNNING.
    const running = await waitFor(() => parts.jobs.get(later.id)?.status === "RUNNING");
    expect(running).toBe(true);
    // While `later` is in flight, `earlier` must not have started: exactly
    // one job runs at a time. It is still CREATED (validation happens on
    // first pick-up) — either way it has NOT been dequeued.
    expect(["CREATED", "QUEUED"]).toContain(parts.jobs.get(earlier.id)!.status);
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0]).toBe(later.id);

    const done = await waitFor(() => {
      const s1 = parts.jobs.get(earlier.id)?.status;
      const s2 = parts.jobs.get(later.id)?.status;
      return s1 === "SUCCEEDED" && s2 === "SUCCEEDED";
    });
    expect(done).toBe(true);
    expect(provider.calls).toEqual([later.id, earlier.id]);
  }, 20_000);

  it("restart while a job is RUNNING: recoverInFlight resets it to QUEUED (with event) and a fresh queue re-runs it to completion", async () => {
    // "Process A": the job crashes in-flight. Walk the legal transitions up
    // to RUNNING, then the process dies — its queue is gone, but the durable
    // DB (and data dir) survive with the job still RUNNING.
    const { nodeId } = setup([{ kind: "ok" }]);
    const j = createJob(parts.jobs, "in-flight");
    parts.jobs.setStatus(j.id, "VALIDATING");
    parts.jobs.setStatus(j.id, "QUEUED");
    parts.jobs.setStatus(j.id, "WAITING_FOR_ACCOUNT");
    parts.jobs.setStatus(j.id, "WAITING_FOR_PROXY");
    parts.jobs.setStatus(j.id, "RUNNING");
    expect(parts.jobs.get(j.id)!.status).toBe("RUNNING");
    const dataDir = parts.dir;
    await queue!.stop(); // process A's queue dies with it (nothing in flight here)
    queue = null;

    // "Process B": a brand-new stack over the SAME durable data dir
    // (second connection, same file — exactly what a restart does).
    const db2 = Db.open(path.join(dataDir, "test.sqlite"));
    extraDb = db2;
    const jobs2 = new JobsRepo(db2);
    expect(jobs2.get(j.id)!.status).toBe("RUNNING"); // persisted across the crash

    // Boot-time recovery (same call app-context.ts makes on startup).
    const recovered = jobs2.recoverInFlight();
    expect(recovered).toEqual([j.id]);
    expect(jobs2.get(j.id)!.status).toBe("QUEUED");
    expect(jobs2.events(j.id).some((e) => e.type === "restart_recover")).toBe(true);

    // Fresh runtime/wiring for process B; proxy + account persist in the DB.
    const runtime2 = new MockProxyRuntime();
    const egress2 = new MockProviderEgress(
      async (_tunnel, target) => ({ status: 200, body: `mock upstream response for ${target}` }),
      (nodeId) => runtime2.scenario(nodeId),
    );
    const vault2 = SecretVault.open(db2, {
      keyHex: "ab".repeat(32),
      keyFile: path.join(dataDir, "vault.key"),
    });
    const proxies2 = new ProxiesRepo(db2);
    markHealthy(proxies2, nodeId); // re-assert health after the "restart"
    const proxyManager2 = new ProxyManager(
      proxies2,
      runtime2,
      ["93.184.216.34:443"],
      async () => ({ ok: true, latencyMs: 1 }),
      vault2,
      { selfHealTarget: { host: "93.184.216.34", port: 443 } },
    );
    const provider2 = new ScriptedProvider([{ kind: "ok" }], 10);
    const runner2 = new JobRunner({
      jobs: jobs2,
      accounts: new AccountsRepo(db2),
      proxies: proxies2,
      provider: provider2,
      proxyManager: proxyManager2,
      runtime: runtime2,
      vault: vault2,
      egress: egress2,
      jobsDir: path.join(dataDir, "jobs"),
      log: () => {},
      sleep: () => Promise.resolve(),
      rng: () => 0,
    });
    queue = new Queue(runner2, 20, () => {});
    queue.start();

    const done = await waitFor(() => jobs2.get(j.id)?.status === "SUCCEEDED");
    expect(done).toBe(true);
    expect(provider2.calls).toEqual([j.id]);
  }, 20_000);
});
