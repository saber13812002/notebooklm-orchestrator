import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression: worker protocol must survive NON-ASCII text in error frames.
 *
 * Root cause (2026-11-05, reproducible): `emit()` serialized protocol frames
 * with `json.dumps(..., ensure_ascii=False)`. On Windows the worker's stdout
 * is a pipe on the ANSI codepage (cp437); when a failed op's error message
 * contained characters outside that codepage (the Persian profile name
 * 'صابر' in the CLI's "browser database is locked" message from
 * `browser-import`), the write raised `UnicodeEncodeError` INSIDE the feed
 * loop's error path. The feed task died without sending the error response,
 * `main()` returned, and the interpreter crashed at finalization (exit
 * 0xC0000005) while the daemon stdin-reader thread was still blocked in
 * `readline()`. The API then reported "python worker exited unexpectedly"
 * instead of the actionable CLI error. Observed live on 2026-11-02 (account
 * 'صابر1404') and 2026-11-05 (account 'sas', Chrome profile 'صابر').
 *
 * Fix: `emit()` uses `json.dumps(obj)` (ensure_ascii=True) — pure-ASCII
 * frames; \uXXXX escapes parse identically in the TypeScript supervisor.
 *
 * Test strategy: spawn the REAL worker via WorkerSupervisor and send an
 * unknown op whose NAME is non-ASCII ('op-صابر'). The feed loop answers
 * with `{"ok": false, "error": {"code": "protocol", "message":
 * "unknown op: <op>"}}` — i.e. the non-ASCII text lands in the error frame,
 * exactly the class of text that used to kill the worker. We assert:
 *   1) the supervisor receives a proper protocol error containing the
 *      exact (decoded) non-ASCII op name — not a process death,
 *   2) the worker is still alive afterwards (a follow-up ping succeeds),
 *   3) close() exits the worker cleanly.
 *
 * Deterministic and hermetic: no Chrome, no egress, no venv packages
 * beyond the interpreter itself. Skipped when the project venv is absent
 * (e.g. CI without `worker:setup`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const workerPath = path.join(repoRoot, "apps/server/src/providers/python-worker/nbl_worker.py");

function resolveVenvPython(): string | null {
  const candidates =
    process.platform === "win32"
      ? [path.join(repoRoot, "data/venv/Scripts/python.exe")]
      : [path.join(repoRoot, "data/venv/bin/python")];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const python = resolveVenvPython();
const hasWorker = python !== null && existsSync(workerPath);

// Sanity-probe the interpreter once (guards against a broken venv).
const probe = hasWorker
  ? spawnSync(python, ["-c", "import sys; print(sys.version)"], { encoding: "utf8" })
  : null;

const NONASCII_OP = "op-صابر"; // Persian — outside cp437, exactly the failing class

describe.skipIf(!hasWorker || !probe || probe.status !== 0)(
  "python worker protocol: non-ASCII error frames (Persian text)",
  () => {
    let WorkerSupervisor: typeof import("../src/providers/python-worker/worker.js").WorkerSupervisor;

    beforeAll(async () => {
      const mod = await import("../src/providers/python-worker/worker.js");
      WorkerSupervisor = mod.WorkerSupervisor;
    });

    afterAll(() => {
      // nothing to clean up: the worker is closed inside the test
    });

    it("delivers a non-ASCII protocol error and stays alive", async () => {
      const w = new WorkerSupervisor({ pythonBin: python!, workerPath });
      try {
        await w.start();

        let err: unknown;
        try {
          await w.request(NONASCII_OP as never, {});
        } catch (e) {
          err = e;
        }

        // The op MUST be rejected — but as a PROTOCOL error response, not
        // as a process death. Pre-fix, the error frame write itself raised
        // UnicodeEncodeError and the worker exited (0xC0000005 on Windows)
        // without ever answering; the supervisor would then reject every
        // pending request with "python worker exited unexpectedly".
        expect(err).toBeInstanceOf(Error);
        const msg = String((err as Error).message);
        expect(msg).not.toContain("exited unexpectedly");
        expect(msg).not.toContain("not running");
        // The non-ASCII op name must round-trip intact through the wire.
        expect(msg).toContain(NONASCII_OP);

        // The worker must still be alive and answering: this ping is the
        // direct discriminator — before the fix the process was dead here.
        const r = await w.request("ping", {});
        expect(r.playwright).toBeTypeOf("boolean");
      } finally {
        await w.close();
      }
    }, 30_000);
  },
);
