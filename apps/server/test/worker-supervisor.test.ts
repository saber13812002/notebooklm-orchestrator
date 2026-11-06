import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerError, WorkerSupervisor } from "../src/providers/python-worker/worker.js";

/**
 * WorkerSupervisor regression tests — 1.1 (worker timeout & queue recovery).
 *
 * Uses a fake child process (test/fixtures/fake-worker.mjs, spawned with the
 * system Node) that implements the real JSON-line protocol, so these run on
 * Windows without the Python venv (which is broken locally — blocker B1).
 *
 * The critical defect fixed here: on timeout the supervisor deleted the
 * pending entry BEFORE kill(), so kill() -> failAll() could no longer reject
 * it — the request promise never settled and the single-worker queue wedged
 * forever. The tests below assert the settle-once contract: every in-flight
 * request settles exactly once, the worker is terminated, the child process
 * really dies, and no duplicate/late result is ever delivered.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-worker.mjs",
);

function makeWorker(mode: string, extra: { timeoutMs?: number; delayMs?: number } = {}) {
  const logs: string[] = [];
  const w = new WorkerSupervisor({
    pythonBin: process.execPath,
    workerPath: FIXTURE,
    correlationId: "job:job_test123",
    requestTimeoutMs: extra.timeoutMs ?? 120_000,
    startupTimeoutMs: 8_000,
    env: {
      FAKE_WORKER_MODE: mode,
      ...(extra.delayMs ? { FAKE_WORKER_DELAY_MS: String(extra.delayMs) } : {}),
    },
    log: (l) => logs.push(l),
  });
  return { w, logs };
}

function livePid(w: WorkerSupervisor): number {
  const p = w.pid;
  if (p === null) throw new Error("expected a running worker with a pid");
  return p;
}

/** Poll a condition with a deadline (child death events land on later ticks). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Await until a process (pid) is really gone (kill(pid, 0) throws). */
async function processGone(pid: number, timeoutMs = 9000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const supervisor: WorkerSupervisor[] = [];
afterEach(async () => {
  while (supervisor.length) {
    const w = supervisor.pop()!;
    try {
      await w.close();
    } catch {
      /* already dead */
    }
  }
});

function track(w: WorkerSupervisor): WorkerSupervisor {
  supervisor.push(w);
  return w;
}

describe("worker supervisor: settle-once, kill, cleanup (fake child, no venv)", () => {
  it("normal path: ping then job — result delivered exactly once, structured logs carry the correlation id", async () => {
    const { w, logs } = makeWorker("ok");
    track(w);
    const start = await w.start();
    expect(start.version).toBeNull(); // fake worker reports no version
    const r = await w.request<{ answer: string; op: string }>("job", {}, {});
    expect(r).toEqual({ answer: "ok", op: "job" });
    await w.close();

    const joined = logs.join("\n");
    expect(joined).toContain("[nlo:worker job:job_test123] spawn pid=");
    expect(joined).toContain("request sent id=1 op=ping");
    expect(joined).toContain("response ok id=1 op=ping");
    expect(joined).toContain("request sent id=2 op=job");
    expect(joined).toContain("response ok id=2 op=job");
    expect(joined).toContain("cleanup: child pipes closed");
    expect(w.running).toBe(false);
  }, 15_000);

  it("timeout: request settles with a structured ambiguous timeout error, worker killed, child gone, queue can continue", async () => {
    const { w, logs } = makeWorker("hang", { timeoutMs: 400 });
    track(w);
    await w.start();
    const pid = livePid(w);

    let settled = 0;
    const p = w.request("job", {}, { timeoutMs: 400 }).then(
      (r) => {
        settled += 1;
        return { ok: true as const, r };
      },
      (e: unknown) => {
        settled += 1;
        return { ok: false as const, e };
      },
    );
    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.e).toBeInstanceOf(WorkerError);
    const err = res.e as WorkerError;
    expect(err.code).toBe("timeout");
    expect(err.ambiguous).toBe(true);
    expect(err.message).toMatch(/timed out after 0s \(op=job\)/);
    expect(settled).toBe(1);

    // The timed-out request is NOT stuck: the worker is being terminated —
    // this is exactly what un-wedges the queue. The exit event lands on a
    // later tick after SIGTERM, so poll for `running` to clear.
    const stopped = await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (!w.running || Date.now() - t0 > 5000) {
          clearInterval(iv);
          resolve(!w.running);
        }
      }, 20);
    });
    expect(stopped).toBe(true);
    expect(await processGone(pid)).toBe(true);

    const joined = logs.join("\n");
    expect(joined).toContain("request timeout id=2 op=job after 400ms settled=true");
    expect(joined).toContain("kill requested code=timeout");
    // No duplicate/late delivery path may log a second settle for id=2.
    // (Assert each line individually: a bare /id=2/ regex would also match
    // inside `pid=2XXXX` spawn/exit/kill lines.)
    expect(joined.match(/request sent id=2 op=job\b/g)?.length ?? 0).toBe(1);
    expect(joined.match(/request timeout id=2 op=job\b/g)?.length ?? 0).toBe(1);
    await w.close();
  }, 15_000);

  it("timeout while another request is in flight: BOTH settle, worker killed once", async () => {
    const { w, logs } = makeWorker("hang", { timeoutMs: 300 });
    track(w);
    await w.start();
    const pid = livePid(w);

    const first = w.request("job", {}, { timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 50)); // let request 3 register
    const second = w.request("job_text", {}, { timeoutMs: 1500 });

    const firstRes = await first.then(
      () => "resolved" as const,
      (e: WorkerError) => ({ rejected: e as WorkerError }),
    );
    const secondRes = await second.then(
      () => "resolved" as const,
      (e: WorkerError) => ({ rejected: e as WorkerError }),
    );

    expect(firstRes).not.toBe("resolved");
    expect(secondRes).not.toBe("resolved");
    expect((firstRes as { rejected: WorkerError }).rejected.code).toBe("timeout");
    // The first timeout kills the worker; the second must settle too (it
    // rides its own deadline, since the requested-termination flag suppresses
    // the exit handler's failAll) — it must NOT be left hanging.
    expect(secondRes).toHaveProperty("rejected");
    expect(await processGone(pid)).toBe(true);
    expect(logs.some((l) => l.includes("kill requested"))).toBe(true);
    // The exit event is delivered on a later tick than kill(pid, 0) reporting
    // death — poll for the logged exit line instead of asserting immediately.
    const exitLogged = await waitFor(() =>
      logs.some((l) => l.startsWith("[nlo:worker job:job_test123] exit pid=")),
    );
    expect(exitLogged).toBe(true);
    await w.close();
  }, 15_000);

  it("late response after timeout is dropped as stale (no duplicate delivery)", async () => {
    const { w, logs } = makeWorker("late", { timeoutMs: 250, delayMs: 800 });
    track(w);
    await w.start();
    const pid = livePid(w);

    const res = await w.request("job", {}, { timeoutMs: 250 }).then(
      (r) => ({ resolved: r }) as const,
      (e: WorkerError) => ({ rejected: e }) as const,
    );
    expect(res).toHaveProperty("rejected");
    expect((res as { rejected: WorkerError }).rejected.code).toBe("timeout");

    // Wait past the fake worker's late answer (800ms) + kill window, and
    // verify no resolution sneaked in: a duplicate delivery would have been
    // logged as a response for the already-settled id, and the promise
    // cannot settle twice anyway — assert the log shows only one id=2
    // settle (the timeout).
    await new Promise((r) => setTimeout(r, 1200));
    const settles = logs.filter((l) => /response (ok|error) id=2/.test(l));
    expect(settles.length).toBe(0); // the late response arrived after kill
    expect(logs.some((l) => l.includes("request timeout id=2"))).toBe(true);
    expect(await processGone(pid)).toBe(true);
    await w.close();
  }, 15_000);

  it("crash: worker exits non-zero mid-request — request rejects (not stuck), worker marked exited", async () => {
    const { w, logs } = makeWorker("crash");
    track(w);
    const start = await w.start();
    expect(start.version).toBeNull();
    // ping succeeded (fake worker answers ping before the crash mode
    // triggers on a non-ping op). Now a job makes the child exit(3).
    const res = await w.request("job", {}, { timeoutMs: 10_000 }).then(
      (r) => ({ resolved: r }) as const,
      (e: WorkerError) => ({ rejected: e }) as const,
    );
    expect(res).toHaveProperty("rejected");
    const e = (res as { rejected: WorkerError }).rejected;
    expect(e.code).toBe("provider_unavailable");
    expect(e.message).toMatch(/exited unexpectedly \(code=3/);
    expect(w.running).toBe(false);
    expect(logs.some((l) => l.includes("exit pid=") && l.includes("code=3"))).toBe(true);
    await w.close();
  }, 15_000);

  it("subprocess exits cleanly before answering (EOF/exit 0): request rejects deterministically", async () => {
    const { w, logs } = makeWorker("early-exit");
    track(w);
    await w.start();
    const res = await w.request("job", {}, { timeoutMs: 10_000 }).then(
      () => "resolved" as const,
      (e: WorkerError) => e,
    );
    expect(res).not.toBe("resolved");
    expect((res as WorkerError).code).toBe("provider_unavailable");
    expect(logs.some((l) => l.includes("exit pid=") && l.includes("code=0"))).toBe(true);
    await w.close();
  }, 15_000);

  it("worker that ignores SIGTERM: escalation does not hang the supervisor; close() resolves deterministically", async () => {
    const { w, logs } = makeWorker("die-on-term");
    track(w);
    await w.start();

    // Trigger the kill path via a timeout with a short request deadline.
    const res = await w.request("job", {}, { timeoutMs: 300 }).then(
      () => "resolved" as const,
      (e: WorkerError) => e,
    );
    expect(res).not.toBe("resolved");
    expect((res as WorkerError).code).toBe("timeout");

    // close() must resolve within its 5s escalation window even though the
    // fake worker ignores SIGTERM (on win32 there is no SIGKILL — the
    // supervisor's close timeout is what guarantees determinism).
    const closed = await Promise.race([
      w.close().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 7_000)),
    ]);
    expect(closed).toBe(true);
    expect(w.running).toBe(false);
    expect(logs.some((l) => l.includes("close: requesting shutdown"))).toBe(true);
  }, 15_000);

  it("abort (job cancel): request settles, worker killed, then a fresh request on a new supervisor still works", async () => {
    // "hang" so the job op never answers: abort is the only settle path.
    const a = makeWorker("hang");
    track(a.w);
    await a.w.start();
    const aPid = livePid(a.w);
    const ctrl = new AbortController();
    const p = a.w.request("job", {}, { timeoutMs: 10_000, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    const res = await p.then(
      () => "resolved" as const,
      (e: WorkerError) => e,
    );
    expect(res).not.toBe("resolved");
    expect((res as WorkerError).code).toBe("timeout"); // cancel maps to timeout code
    expect(a.logs.some((l) => l.includes("request aborted id="))).toBe(true);
    expect(await processGone(aPid)).toBe(true);
    await a.w.close();

    // The queue continues: a brand-new supervisor (new worker per request)
    // must still work normally.
    const b = makeWorker("ok");
    track(b.w);
    await b.w.start();
    const r = await b.w.request<{ answer: string }>("job", {}, {});
    expect(r.answer).toBe("ok");
    await b.w.close();
  }, 15_000);

  it("structured logs: spawn/request/response/timeout/kill/exit/cleanup all carry the correlation id", async () => {
    const { w, logs } = makeWorker("hang", { timeoutMs: 300 });
    track(w);
    await w.start();
    await w.request("job", {}, { timeoutMs: 300 }).catch(() => {});
    await w.close();
    const tagged = logs.filter((l) => l.startsWith("[nlo:worker job:job_test123]"));
    const untagged = logs.filter((l) => !l.startsWith("[nlo:worker"));
    expect(untagged.length).toBe(0);
    expect(tagged.some((l) => l.includes("spawn pid="))).toBe(true);
    expect(tagged.some((l) => l.includes("request sent"))).toBe(true);
    expect(tagged.some((l) => l.includes("request timeout"))).toBe(true);
    expect(tagged.some((l) => l.includes("kill requested"))).toBe(true);
    expect(tagged.some((l) => l.includes("exit pid="))).toBe(true);
    expect(tagged.some((l) => l.includes("cleanup: child pipes closed"))).toBe(true);
  }, 15_000);

  it("close() while a request is in flight settles the pending request (no hang)", async () => {
    // "hang" so the job op is still in flight when close() runs.
    const { w } = makeWorker("hang");
    track(w);
    await w.start();
    // Attach the settle handler BEFORE close() so the rejection (delivered
    // by close() -> failAll) is never unhandled for a tick.
    const p = w.request("job", {}, { timeoutMs: 30_000 }).then(
      () => "resolved" as const,
      (e: WorkerError) => e,
    );
    await new Promise((r) => setTimeout(r, 50));
    const closed = await Promise.race([
      w.close().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 7_000)),
    ]);
    expect(closed).toBe(true);
    const res = await p;
    expect(res).not.toBe("resolved");
    expect((res as WorkerError).code).toBe("timeout"); // close settles as ambiguous "may still complete"
  }, 15_000);
});
