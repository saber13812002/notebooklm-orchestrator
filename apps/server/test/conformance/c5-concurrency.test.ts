/**
 * NLO-P4-1D / C5 — Concurrency (audit map §4.4).
 *
 * The provider declares `maxConcurrent: 1`. Three parallel podcast jobs are
 * submitted to the EXISTING single-worker queue and must:
 *
 *  - all reach SUCCEEDED within a hard timeout (the queue NEVER wedges),
 *  - keep per-job external ids distinct (no interleaved / aliased notebook
 *    ids: each job owns `mock_nb_<its own job id suffix>`),
 *  - never run more than one job at a time (worker active map capped at 1).
 *
 * The queue is structurally single-worker (a `busy` flag); the concurrency
 * counter below is an OBSERVABLE proof of that invariant, not a re-implementation.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "@nlo/shared";
import { JobRunner } from "../../src/queue/job-runner.js";
import { Queue } from "../../src/queue/queue.js";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  type TestParts,
} from "../helpers.js";
import { waitFor } from "./runner.js";

const partsList: TestParts[] = [];

afterEach(() => {
  while (partsList.length) partsList.pop()!.dispose();
});

describe("C5 concurrency (maxConcurrent = 1)", () => {
  it("3 parallel podcast jobs: no aliasing, no wedge, at most 1 concurrent", async () => {
    const parts = makeParts();
    partsList.push(parts);
    addAccount(parts.accounts, "c5@example.com");
    const nodeId = addNode(parts.proxies, parts.vault, "c5-node").id;
    markHealthy(parts.proxies, nodeId);

    // Real-timer sleep (like the podcast-lifecycle tests) so the external
    // operation poll loop yields to the event loop deterministically.
    const runner = new JobRunner({
      jobs: parts.jobs,
      accounts: parts.accounts,
      proxies: parts.proxies,
      provider: parts.provider,
      proxyManager: parts.proxyManager,
      gateway: parts.gateway,
      runtime: parts.runtime,
      vault: parts.vault,
      egress: parts.egress,
      jobsDir: parts.jobsDir,
      log: () => {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      rng: () => 0,
      artifacts: parts.artifacts,
      stages: parts.stages,
      locks: parts.lock,
    });

    // Observable concurrency counter around the single entry point.
    let active = 0;
    let maxActive = 0;
    const origRun = runner.run.bind(runner);
    runner.run = async (jobId: string): Promise<Job> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await origRun(jobId);
      } finally {
        active -= 1;
      }
    };

    const jobs = [0, 1, 2].map(() =>
      createJob(parts.jobs, "test prompt", { podcast: { enabled: true } }),
    );

    const queue = new Queue(runner, 25, () => {});
    queue.start();

    // Hard timeout: if the queue wedges, this fails loudly (no hang).
    const drained = await waitFor(
      () =>
        jobs.every((j) => {
          const st = parts.jobs.get(j.id)?.status;
          return (
            st === "SUCCEEDED" || st === "FAILED" || st === "CANCELLED" || st === "NEEDS_ATTENTION"
          );
        }),
      15_000,
    );
    await queue.stop();

    expect(drained, "queue wedged: not all jobs reached a terminal state").toBe(true);
    for (const j of jobs) {
      const done = parts.jobs.get(j.id);
      expect(done?.status, `job ${j.id}`).toBe("SUCCEEDED");
    }

    // No interleaved / aliased external ids: each job owns its notebook.
    for (const j of jobs) {
      const nb = parts.jobs.get(j.id)?.notebookId;
      expect(nb, `job ${j.id} notebookId`).toBe(`mock_nb_${j.id.slice(-16)}`);
    }
    expect(new Set(jobs.map((j) => parts.jobs.get(j.id)?.notebookId)).size).toBe(jobs.length);

    // The declared concurrency cap held: never more than one running job.
    expect(maxActive).toBeLessThanOrEqual(1);
    expect(maxActive).toBeGreaterThanOrEqual(1); // at least one ran
    expect(active).toBe(0); // nothing left in flight
  });
});
