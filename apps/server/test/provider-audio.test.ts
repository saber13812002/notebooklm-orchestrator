/**
 * NLO-P2 provider-level tests for the Audio Overview (podcast) pipeline.
 *
 * Two providers are exercised:
 *  - MockProvider: fully offline deterministic simulation. Verifies the
 *    provider-boundary contract (egress usage, scenario failures, idempotent
 *    resume, real WAV artifact write with verified size/hash).
 *  - PythonWorkerProvider: spawned against test/fixtures/fake-audio-worker.mjs
 *    (system Node, NO Python venv), which speaks the real JSON-line worker
 *    protocol with the real audio_* result shapes. Verifies the adapter
 *    mapping (flat wire payload -> nested status), fail-closed tunnel,
 *    session auth, error-class mapping, and cancel of in-flight ops.
 *
 * These are UNIT/INTEGRATION tests. They do NOT prove real NotebookLM
 * execution (that is the live E2E gate).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { MockProvider } from "../src/providers/mock-provider.js";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import {
  ProviderFailure,
  type ProviderAudioDownloadRequest,
  type ProviderAudioGenerateRequest,
  type ProviderAudioStatusRequest,
} from "../src/providers/types.js";
import {
  DirectEgressBlockedError,
  MockProviderEgress,
  type ProviderEgress,
} from "../src/proxy/egress.js";
import type { TunnelHandle } from "../src/proxy/runtime.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-audio-worker.mjs",
);

const TUNNEL: TunnelHandle = { nodeId: "n1", host: "127.0.0.1", port: 12345 };
const JOB = "j_0123456789abcdef";
const NB = "nb_test";
const ACCT = "acct1";

/** Mock egress that records every call and always succeeds (tunnel present). */
function makeEgress(calls: { target: string; path: string }[] = []): MockProviderEgress {
  return new MockProviderEgress(
    async (_via, target, body) => {
      calls.push({ target, path: body.path });
      return { status: 200, body: "" };
    },
    () => "ok",
  );
}

function genReq(
  egress: ProviderEgress,
  o: Partial<ProviderAudioGenerateRequest> = {},
): ProviderAudioGenerateRequest {
  return {
    jobId: JOB,
    accountId: ACCT,
    credentialRef: `session:${ACCT}`,
    notebookId: NB,
    tunnel: TUNNEL,
    egress,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...o,
  };
}

function statusReq(
  egress: ProviderEgress,
  taskId: string,
  o: Partial<ProviderAudioStatusRequest> = {},
): ProviderAudioStatusRequest {
  return {
    jobId: JOB,
    accountId: ACCT,
    credentialRef: `session:${ACCT}`,
    notebookId: NB,
    taskId,
    tunnel: TUNNEL,
    egress,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...o,
  };
}

function dlReq(
  egress: ProviderEgress,
  artifactId: string,
  destPath: string,
  o: Partial<ProviderAudioDownloadRequest> = {},
): ProviderAudioDownloadRequest {
  return {
    jobId: JOB,
    accountId: ACCT,
    credentialRef: `session:${ACCT}`,
    notebookId: NB,
    artifactId,
    destPath,
    tunnel: TUNNEL,
    egress,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...o,
  };
}

/** Await a rejected promise and extract its ProviderFailure info. */
function expectFailure(p: Promise<unknown>): Promise<{
  cls: string;
  ambiguous: boolean;
  needsReauth: boolean;
  message: string;
}> {
  return p.then(
    () => {
      throw new Error("expected the operation to fail");
    },
    (e: unknown) => {
      if (!(e instanceof ProviderFailure)) throw e;
      return {
        cls: e.info.failureClass,
        ambiguous: e.info.ambiguous,
        needsReauth: e.info.needsReauth,
        message: e.info.message,
      };
    },
  );
}

describe("MockProvider audio ops (deterministic, offline)", () => {
  it("declares the three audio capabilities", () => {
    const p = new MockProvider();
    const ops = p.capabilities().map((c) => c.operation);
    expect(ops).toEqual(
      expect.arrayContaining(["generateAudio", "getAudioStatus", "downloadAudio"]),
    );
    p.dispose();
  });

  it("generateAudio: submits via the egress boundary and returns a deterministic recoverable task id", async () => {
    const p = new MockProvider();
    const calls: { target: string; path: string }[] = [];
    const res = await p.generateAudio(genReq(makeEgress(calls)));
    expect(res.resumed).toBe(false);
    expect(res.priorStatus).toBeNull();
    expect(res.email).toBe("mock-account@example.com");
    expect(res.status.taskId).toBe(p.mockAudioTaskId(JOB));
    expect(res.status.status).toBe("in_progress");
    expect(res.status.isComplete).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      target: "notebooklm.google.com:443",
      path: "/artifacts/generate_audio",
    });
    p.dispose();
  });

  it("generateAudio: fail-closed without a tunnel (no direct egress)", async () => {
    const p = new MockProvider();
    await expect(p.generateAudio(genReq(makeEgress(), { tunnel: null }))).rejects.toThrow(
      DirectEgressBlockedError,
    );
    p.dispose();
  });

  it("generateAudio: resume keeps an in-progress task and does NOT call egress again", async () => {
    const p = new MockProvider();
    const taskId = "task_keepme_1";
    p.setAudioTaskState(taskId, "in_progress");
    const egress = makeEgress();
    const res = await p.generateAudio(genReq(egress, { resumeTaskId: taskId }));
    expect(res.resumed).toBe(true);
    expect(res.priorStatus).toBe("in_progress");
    expect(res.status.taskId).toBe(taskId);
    expect(egress.attempts).toHaveLength(0);
    p.dispose();
  });

  it("generateAudio: resume after a PROVEN failure re-submits and records priorStatus", async () => {
    const p = new MockProvider();
    const calls: { target: string; path: string }[] = [];
    const failedId = p.mockAudioTaskId(JOB);
    p.setAudioTaskState(failedId, "failed");
    const res = await p.generateAudio(genReq(makeEgress(calls), { resumeTaskId: failedId }));
    expect(res.resumed).toBe(false);
    expect(res.priorStatus).toBe("failed");
    expect(res.status.taskId).toBe(failedId);
    // the stale failed state is cleared by the re-submission
    expect(res.status.status).toBe("in_progress");
    expect(calls).toHaveLength(1);
    p.dispose();
  });

  it("getAudioStatus: completes deterministically on the first poll (single-poll completion)", async () => {
    const p = new MockProvider();
    const taskId = p.mockAudioTaskId(JOB);
    const egress = makeEgress();
    const r1 = await p.getAudioStatus(statusReq(egress, taskId));
    expect(r1.status.status).toBe("completed");
    expect(r1.status.isComplete).toBe(true);
    expect(r1.status.isTerminal).toBe(true);
    expect(r1.status.metadata).toEqual({ simulated: true, durationSeconds: 1, format: "wav" });
    const r2 = await p.getAudioStatus(statusReq(egress, taskId));
    expect(r2.status.status).toBe("completed");
    p.dispose();
  });

  it("getAudioStatus: a forced in-progress task stays in progress (test hook)", async () => {
    const p = new MockProvider();
    const taskId = p.mockAudioTaskId(JOB);
    p.setAudioTaskState(taskId, "in_progress");
    const r = await p.getAudioStatus(statusReq(makeEgress(), taskId));
    expect(r.status.status).toBe("in_progress");
    expect(r.status.isComplete).toBe(false);
    expect(r.status.isTerminal).toBe(false);
    p.dispose();
  });

  it("getAudioStatus: a not-found task is terminal (unresolved for the app)", async () => {
    const p = new MockProvider();
    const taskId = "task_missing_1";
    p.setAudioTaskState(taskId, "not_found");
    const r = await p.getAudioStatus(statusReq(makeEgress(), taskId));
    expect(r.status.isNotFound).toBe(true);
    expect(r.status.isTerminal).toBe(true);
    p.dispose();
  });

  it("downloadAudio: writes a real WAV and reports verified size + sha256", async () => {
    const p = new MockProvider();
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-mock-dl-"));
    const dest = path.join(dir, "audio.wav");
    try {
      const taskId = p.mockAudioTaskId(JOB);
      p.setAudioTaskState(taskId, "completed");
      const r = await p.downloadAudio(dlReq(makeEgress(), taskId, dest));
      expect(r.ready).toBe(true);
      expect(r.path).toBe(dest);
      expect(existsSync(dest)).toBe(true);
      const file = readFileSync(dest);
      expect(file.length).toBe(1068);
      expect(file.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(r.size).toBe(file.length);
      expect(r.sha256).toBe(createHash("sha256").update(file).digest("hex"));
      expect(r.durationSeconds).toBe(1);
      expect(r.artifactStatus).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    p.dispose();
  });

  it("downloadAudio: not-finished artifact returns ready:false and writes nothing", async () => {
    const p = new MockProvider();
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-mock-dl-"));
    const dest = path.join(dir, "audio.wav");
    try {
      const taskId = p.mockAudioTaskId(JOB);
      p.setAudioTaskState(taskId, "in_progress");
      const r = await p.downloadAudio(dlReq(makeEgress(), taskId, dest));
      expect(r.ready).toBe(false);
      expect(r.artifactStatus).toBe("in_progress");
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    p.dispose();
  });

  it("downloadAudio: unknown artifact id is an error (unknown class)", async () => {
    const p = new MockProvider();
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-mock-dl-"));
    const dest = path.join(dir, "audio.wav");
    try {
      const f = await expectFailure(p.downloadAudio(dlReq(makeEgress(), "nope_1", dest)));
      expect(f.cls).toBe("unknown");
      expect(f.message).toContain("not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    p.dispose();
  });

  it("downloadAudio: relative destPath is rejected (invalid_input)", async () => {
    const p = new MockProvider();
    const f = await expectFailure(
      p.downloadAudio(dlReq(makeEgress(), p.mockAudioTaskId(JOB), "relative/audio.wav")),
    );
    expect(f.cls).toBe("invalid_input");
    p.dispose();
  });

  it("downloadAudio: oversized artifact is removed and reported as invalid_input", async () => {
    const p = new MockProvider();
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-mock-dl-"));
    const dest = path.join(dir, "audio.wav");
    try {
      const taskId = p.mockAudioTaskId(JOB);
      p.setAudioTaskState(taskId, "completed");
      const f = await expectFailure(
        p.downloadAudio(dlReq(makeEgress(), taskId, dest, { maxBytes: 100 })),
      );
      expect(f.cls).toBe("invalid_input");
      expect(f.message).toContain("exceeds size limit");
      expect(existsSync(dest)).toBe(false); // cleaned up
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    p.dispose();
  });

  it("scenario failures map to the provider error contract (auth/rate_limit/ambiguous)", async () => {
    for (const [scenario, cls, needsReauth] of [
      ["auth", "auth", true],
      ["rate_limit", "rate_limit", false],
      ["ambiguous", "ambiguous", false],
    ] as const) {
      const p = new MockProvider();
      p.setScenario(ACCT, scenario);
      const f = await expectFailure(p.generateAudio(genReq(makeEgress())));
      expect(f.cls).toBe(cls);
      expect(f.needsReauth).toBe(needsReauth);
      if (scenario === "ambiguous") expect(f.ambiguous).toBe(true);
      p.dispose();
    }
  });

  it("aborted signal: fails before any work", async () => {
    const p = new MockProvider();
    const ac = new AbortController();
    ac.abort();
    const f = await expectFailure(p.generateAudio(genReq(makeEgress(), { signal: ac.signal })));
    expect(f.cls).toBe("provider");
    expect(f.message).toContain("cancelled before start");
    p.dispose();
  });
});

describe("PythonWorkerProvider audio ops (fake worker, real protocol, no venv)", () => {
  let dir: string | null = null;

  afterEach(() => {
    delete process.env.FAKE_WORKER_MODE;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  function makeProvider(
    mode: string | undefined,
    opts: { allowDirect?: boolean; withSession?: boolean } = {},
  ): PythonWorkerProvider {
    dir = mkdtempSync(path.join(tmpdir(), "nlo-pw-audio-"));
    const sessionDir = path.join(dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    if (opts.withSession ?? true) {
      writeFileSync(path.join(sessionDir, `nlo-${ACCT}.json`), "{}");
    }
    if (mode) process.env.FAKE_WORKER_MODE = mode;
    return new PythonWorkerProvider({
      sessionDir,
      dataDir: dir,
      pythonBin: process.execPath,
      workerPath: FIXTURE,
      jobTimeoutMs: 10_000,
      allowDirect: opts.allowDirect ?? true,
      log: () => {},
    });
  }

  function pwGenReq(o: Partial<ProviderAudioGenerateRequest> = {}): ProviderAudioGenerateRequest {
    return {
      jobId: "j_pw000000000000001",
      accountId: ACCT,
      credentialRef: `session:${ACCT}`,
      notebookId: "nb_pw",
      tunnel: null,
      egress: makeEgress(),
      signal: new AbortController().signal,
      onProgress: () => {},
      ...o,
    };
  }

  function pwStatusReq(
    taskId: string,
    o: Partial<ProviderAudioStatusRequest> = {},
  ): ProviderAudioStatusRequest {
    return {
      jobId: "j_pw000000000000001",
      accountId: ACCT,
      credentialRef: `session:${ACCT}`,
      notebookId: "nb_pw",
      taskId,
      tunnel: null,
      egress: makeEgress(),
      signal: new AbortController().signal,
      onProgress: () => {},
      ...o,
    };
  }

  function pwDlReq(
    artifactId: string,
    destPath: string,
    o: Partial<ProviderAudioDownloadRequest> = {},
  ): ProviderAudioDownloadRequest {
    return {
      jobId: "j_pw000000000000001",
      accountId: ACCT,
      credentialRef: `session:${ACCT}`,
      notebookId: "nb_pw",
      artifactId,
      destPath,
      tunnel: null,
      egress: makeEgress(),
      signal: new AbortController().signal,
      onProgress: () => {},
      ...o,
    };
  }

  it("fail-closed: no tunnel and !allowDirect -> proxy failure (no worker spawned)", async () => {
    const p = makeProvider(undefined, { allowDirect: false });
    const f = await expectFailure(p.generateAudio(pwGenReq()));
    expect(f.cls).toBe("proxy");
    expect(f.message).toContain("fail-closed");
  });

  it("missing session file -> auth failure with needsReauth (before spawn)", async () => {
    const p = makeProvider(undefined, { withSession: false });
    const f = await expectFailure(p.generateAudio(pwGenReq()));
    expect(f.cls).toBe("auth");
    expect(f.needsReauth).toBe(true);
  });

  it("generateAudio (ok): maps the flat wire payload onto the nested status", async () => {
    const p = makeProvider("ok");
    const res = await p.generateAudio(pwGenReq({ prompt: "make a podcast" }));
    expect(res.email).toBe("fake@example.com");
    expect(res.notebookId).toBe("nb_pw");
    expect(res.resumed).toBe(false);
    expect(res.priorStatus).toBeNull();
    expect(res.instructionsProvided).toBe(true);
    expect(res.status.taskId).toBe("task_abc123");
    expect(res.status.status).toBe("pending");
    expect(res.status.isComplete).toBe(false);
    expect(res.status.url).toBeNull();
  });

  it("generateAudio (resumed): keeps the recorded task and reports priorStatus", async () => {
    const p = makeProvider("resumed");
    const res = await p.generateAudio(pwGenReq({ resumeTaskId: "task_prior999" }));
    expect(res.resumed).toBe(true);
    expect(res.priorStatus).toBe("in_progress");
    expect(res.status.taskId).toBe("task_prior999");
    expect(res.status.status).toBe("in_progress");
  });

  it("generateAudio (resubmit): re-submission after proven failure records priorStatus", async () => {
    const p = makeProvider("resubmit");
    const res = await p.generateAudio(pwGenReq({ resumeTaskId: "task_old" }));
    expect(res.resumed).toBe(false);
    expect(res.priorStatus).toBe("failed");
    expect(res.status.taskId).toBe("task_new777");
  });

  it("generateAudio: progress reaches 100 with a completion note", async () => {
    const p = makeProvider("ok");
    const progress: [number, string][] = [];
    const res = await p.generateAudio(pwGenReq({ onProgress: (n, s) => progress.push([n, s]) }));
    expect(progress[progress.length - 1]).toEqual([100, "audio generation submitted or resumed"]);
    expect(res.status.taskId).toBeTruthy();
  });

  it("getAudioStatus (ok): completed with metadata, task id echoed", async () => {
    const p = makeProvider("ok");
    const res = await p.getAudioStatus(pwStatusReq("task_abc123"));
    expect(res.notebookId).toBe("nb_pw");
    expect(res.status.taskId).toBe("task_abc123");
    expect(res.status.status).toBe("completed");
    expect(res.status.isComplete).toBe(true);
    expect(res.status.isTerminal).toBe(true);
    expect(res.status.metadata).toEqual({ simulated: true, durationSeconds: 60 });
  });

  it("downloadAudio (ok): ready payload -> file on disk + verified fields", async () => {
    const p = makeProvider("ok");
    const out = path.join(dir!, "dl", "podcast.bin");
    const res = await p.downloadAudio(pwDlReq("task_abc123", out));
    expect(res.ready).toBe(true);
    expect(res.path).toBe(out);
    expect(res.size).toBe(18);
    expect(res.sha256).toBe("abc123def456");
    expect(res.durationSeconds).toBe(60);
    expect(res.artifactTitle).toBe("Fake Podcast");
    expect(res.artifactStatus).toBe("completed");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("fake-audio-payload");
  });

  it("downloadAudio (not-ready): ready:false is a result, not an error", async () => {
    const p = makeProvider("not-ready");
    const out = path.join(dir!, "dl", "podcast.bin");
    const res = await p.downloadAudio(pwDlReq("task_abc123", out));
    expect(res.ready).toBe(false);
    expect(res.artifactStatus).toBe("in_progress");
    expect(existsSync(out)).toBe(false);
  });

  it("downloadAudio (not-found): worker error not_found -> unknown failure class", async () => {
    const p = makeProvider("not-found");
    const out = path.join(dir!, "dl", "podcast.bin");
    const f = await expectFailure(p.downloadAudio(pwDlReq("task_abc123", out)));
    expect(f.cls).toBe("unknown");
  });

  it("downloadAudio: non-absolute destPath -> invalid_input before any worker is spawned", async () => {
    const p = makeProvider("ok");
    const f = await expectFailure(p.downloadAudio(pwDlReq("task_abc123", "relative/podcast.bin")));
    expect(f.cls).toBe("invalid_input");
  });

  it("worker error auth -> failureClass auth + needsReauth", async () => {
    const p = makeProvider("auth");
    const f = await expectFailure(p.generateAudio(pwGenReq()));
    expect(f.cls).toBe("auth");
    expect(f.needsReauth).toBe(true);
  });

  it("worker error timeout -> failureClass provider + ambiguous (do not blindly auto-retry)", async () => {
    const p = makeProvider("timeout");
    const f = await expectFailure(p.generateAudio(pwGenReq()));
    expect(f.cls).toBe("provider");
    expect(f.ambiguous).toBe(true);
  });

  it("cancel(jobId) while a request is in flight: accepted, request settles, worker dies", async () => {
    const p = makeProvider("hang");
    const p1 = p.generateAudio(pwGenReq());
    // Attach a handler immediately: the rejection is async (worker close) and
    // an unhandled rejection would fail the whole file.
    const failed = p1.then(
      () => null,
      (e: unknown) => (e instanceof ProviderFailure ? e.info : null),
    );
    // let the worker spawn and the request go in flight
    await new Promise((r) => setTimeout(r, 300));
    const c = await p.cancel("j_pw000000000000001");
    expect(c.accepted).toBe(true);
    const info = await failed;
    expect(info).not.toBeNull();
    expect(info!.failureClass).toBe("provider");
    expect(info!.ambiguous).toBe(true);
  });

  it("cancel(jobId) with no active worker -> accepted:false", async () => {
    const p = makeProvider("ok");
    const c = await p.cancel("j_nobody_here");
    expect(c.accepted).toBe(false);
  });
});
