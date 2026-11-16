/**
 * NLO-P4-1D / C3 — Lifecycle (audit map §4.4).
 *
 * The mock provider's job lifecycle, driven through the EXISTING job engine
 * (JobRunner + state machine + durable lock + egress + artifact storage):
 *
 *  1. A podcast job runs to SUCCEEDED and its external task id
 *     (`operationIds.audioTaskId`) is persisted BEFORE the first status poll
 *     (restart-recovery idempotency: a re-submission must be a resume).
 *  2. A cancel settles the job EXACTLY ONCE: terminal CANCELLED, the durable
 *     lock released, and a second cancel a no-op (the job no longer has an
 *     active controller, and re-running it returns the terminal job).
 *
 * F-C1 note: this suite tests the ADAPTER LIFECYCLE against the existing
 * podcast/text flows — not per-op wire calls (C2 covers operation honesty).
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderAudioStatusRequest,
  ProviderAudioStatusResult,
} from "../../src/providers/types.js";
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

function setupHappy(): TestParts & { accountId: string } {
  const parts = makeParts();
  partsList.push(parts);
  const accountId = addAccount(parts.accounts, "c3@example.com").id;
  const nodeId = addNode(parts.proxies, parts.vault, "c3-node").id;
  markHealthy(parts.proxies, nodeId);
  return { ...parts, accountId };
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

describe("C3 lifecycle (notebooklm.web adapter, mock level)", () => {
  it("podcast job reaches SUCCEEDED; audioTaskId is persisted BEFORE the first poll", async () => {
    const parts = setupHappy();
    const job = createJob(parts.jobs, "test prompt", { podcast: { enabled: true } });
    const expectedTaskId = parts.provider.mockAudioTaskId(job.id);

    // Observe the first status poll: by the time the runner polls the
    // external task, the task id must already be durable in the job row.
    let observedOnFirstPoll: unknown;
    const origStatus = parts.provider.getAudioStatus.bind(parts.provider);
    parts.provider.getAudioStatus = async (
      req: ProviderAudioStatusRequest,
    ): Promise<ProviderAudioStatusResult> => {
      const row = parts.jobs.get(job.id);
      if (observedOnFirstPoll === undefined) {
        observedOnFirstPoll = row?.operationIds?.audioTaskId ?? null;
      }
      return origStatus(req);
    };

    const done = await parts.runner.run(job.id);

    expect(done.status).toBe("SUCCEEDED");
    expect(done.resultProvenance).toBe("mock");
    expect(done.notebookId).toBe(`mock_nb_${job.id.slice(-16)}`);
    expect(done.operationIds?.audioTaskId).toBe(expectedTaskId);
    // The external id was durable at first-poll time (persisted before poll).
    expect(observedOnFirstPoll).toBe(expectedTaskId);

    // Exactly one podcast artifact row, a real stored WAV.
    const artifacts = (
      parts.db as unknown as {
        raw: { prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[] } };
      }
    ).raw
      .prepare("SELECT * FROM artifacts WHERE job_id = ?")
      .all(job.id);
    const pod = artifacts.filter((r) => String(r.filename).startsWith("podcast-"));
    expect(pod).toHaveLength(1);
    expect((pod[0] as Record<string, unknown>).media_type).toBe("audio/wav");
    expect((pod[0] as Record<string, unknown>).size).toBe(1068);
  });

  it("cancel settles exactly once: CANCELLED, lock released, second cancel is a no-op", async () => {
    const parts = setupHappy();
    const job = createJob(parts.jobs, "test prompt");

    // Hold the mock in the "ask" window so the cancel lands mid-operation.
    parts.provider.delayMs = 200;
    const runPromise = parts.runner.run(job.id); // not awaited

    await waitFor(() => parts.jobs.get(job.id)?.status === "RUNNING", 5000);
    expect(parts.lock.isHeld(job.id)).toBe(true);

    const first = parts.runner.cancel(job.id);
    expect(first).toBe(true); // an active controller existed

    const done = await runPromise;
    expect(done.status).toBe("CANCELLED");
    expect(done.errorClass).toBe("provider");
    expect(done.errorMessage).toContain("cancelled by user");

    // Exactly ONE settled attempt — the cancel settled the job once.
    const settledRows = attemptRows(parts, job.id);
    expect(settledRows).toHaveLength(1);
    // (rows is length-1 per the assertion above; `?.` keeps the failure honest
    // under noUncheckedIndexedAccess — an empty list would stringify "undefined")
    expect(String(settledRows[0]?.outcome)).toBe("cancelled");

    // The durable lock is released (no wedge for a future instance).
    expect(parts.lock.isHeld(job.id)).toBe(false);

    // Second cancel: no active controller anymore → no-op.
    expect(parts.runner.cancel(job.id)).toBe(false);

    // Re-running a terminal job returns it unchanged (status guard).
    const again = await parts.runner.run(job.id);
    expect(again.status).toBe("CANCELLED");
    expect(attemptRows(parts, job.id)).toHaveLength(1);
  });
});
