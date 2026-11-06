import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "@nlo/shared";
import { WorkerInbound, isResponse, type WorkerOp, type WorkerResponseT } from "./protocol.js";

export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export interface WorkerOptions {
  /** Python interpreter (default "python3"). Must be able to import notebooklm. */
  pythonBin?: string;
  /** Path to nbl_worker.py (defaults to the one shipped next to this file). */
  workerPath?: string;
  /** Extra env for the child (proxy vars, etc.). */
  env?: Record<string, string>;
  /** Per-request timeout in ms (default 30 min — long jobs). */
  requestTimeoutMs?: number;
  /** Startup (ping) timeout in ms. */
  startupTimeoutMs?: number;
  /** Max stderr captured (bytes) before we stop buffering (still drained). */
  maxStderrBytes?: number;
  /**
   * Correlation id for structured logs (job id for jobs, account-scoped id
   * for auth ops). Prefixed to every supervisor log line so one worker's
   * lifecycle is traceable in a shared log stream.
   */
  correlationId?: string;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (r: WorkerResponseT) => void;
  reject: (e: WorkerError) => void;
  timer: NodeJS.Timeout;
}

/**
 * WorkerSupervisor: spawns one Python worker per owner (per account session is
 * NOT required — one worker can serve many requests sequentially) and
 * exchanges JSON-line requests/responses over stdio.
 *
 * Safety properties:
 *  - spawned with an argument array, NEVER a shell string
 *  - stdin/stdout line-buffered; stdout lines length-capped
 *  - stderr drained (never left to deadlock) with a capture cap
 *  - per-request deadline; on timeout the whole process group is killed
 *  - SIGTERM then SIGKILL escalation
 *  - clean shutdown on close()
 *  - every in-flight request is settled EXACTLY ONCE: timeout/abort settle
 *    their own pending entry BEFORE asking the worker to die, so kill() ->
 *    failAll() can never "lose" the timed-out entry (which would leave the
 *    promise unsettled and wedge the single-worker queue). A late response
 *    for an already-settled id is dropped as stale by onStdout(), so a
 *    timed-out job can never be delivered a duplicate/late result.
 *  - every lifecycle event is logged with the correlation id (job id for
 *    jobs, account-scoped id for auth ops): spawn, request sent, response,
 *    timeout, abort, kill, exit, cleanup
 */
export class WorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  private stderrBytes = 0;
  private stdoutBuf = "";
  private closing = false;
  private exitCode: number | null = null;
  private exitReason: "exited" | "killed" | "closed" = "closed";
  /** SIGTERM->SIGKILL escalation timer (tracked so exit/close can cancel it). */
  private escalateTimer: NodeJS.Timeout | null = null;
  /** True once the supervisor asked the worker to die (kill path). */
  private killing = false;

  readonly opts: Required<WorkerOptions>;
  readonly workerPath: string;

  constructor(opts: WorkerOptions = {}) {
    this.opts = {
      pythonBin: opts.pythonBin ?? "python3",
      workerPath:
        opts.workerPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "nbl_worker.py"),
      env: opts.env ?? {},
      requestTimeoutMs: opts.requestTimeoutMs ?? 30 * 60_000,
      startupTimeoutMs: opts.startupTimeoutMs ?? 20_000,
      maxStderrBytes: opts.maxStderrBytes ?? 64 * 1024,
      correlationId: opts.correlationId ?? "",
      log: opts.log ?? (() => {}),
    };
    this.workerPath = this.opts.workerPath;
  }

  private log(line: string): void {
    const c = this.opts.correlationId;
    this.opts.log(c ? `[nlo:worker ${c}] ${line}` : `[nlo:worker] ${line}`);
  }

  get running(): boolean {
    return this.child !== null && this.exitCode === null;
  }

  /** Child pid while running (null when not spawned / after close). For ops/tests. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawn the worker and verify with a ping. */
  async start(): Promise<{ version: string | null; playwright: boolean | null }> {
    if (this.running) return this.ping();
    if (!existsSync(this.workerPath)) {
      throw new WorkerError(`worker script not found: ${this.workerPath}`, "configuration");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Keep the worker quiet unless the app wants worker logs.
      PYTHONUNBUFFERED: "1",
      ...this.opts.env,
    };
    // Never inherit a CWD-based PYTHONPATH; the worker relies on installed pkg.
    delete env.PYTHONSTARTUP;
    const child = spawn(this.opts.pythonBin, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.log(`spawn pid=${child.pid} python=${this.opts.pythonBin}`);

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.on("error", (err) => {
      this.log(`spawn error: ${err.message}`);
      this.failAll(new WorkerError(`worker spawn error: ${err.message}`, "provider_unavailable"));
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitReason = signal ? "killed" : "exited";
      this.log(
        `exit pid=${child.pid} code=${code} signal=${signal ?? "none"} pending=${this.pending.size} stderrTail=${this.tail()}`,
      );
      this.clearEscalation();
      if (this.killing) {
        // Requested termination (kill/close path): every pending entry was
        // already settled by the kill path — nothing to settle here.
        return;
      }
      if (this.pending.size > 0) {
        // Unrequested exit (crash, stdin EOF, external kill): settle every
        // in-flight request so no promise hangs and no queue slot wedges.
        this.failAll(
          new WorkerError(
            `python worker exited unexpectedly (code=${code}, signal=${signal ?? "none"}); stderr: ${this.tail()}`,
            "provider_unavailable",
          ),
        );
      }
    });
    child.on("close", () => {
      this.log(`cleanup: child pipes closed (pending=${this.pending.size})`);
      this.clearEscalation();
      this.child = null;
      this.exitCode = null;
    });

    // Startup check with a short deadline.
    return await this.request("ping", {}, { timeoutMs: this.opts.startupTimeoutMs }).then((r) => ({
      version: (r.version as string | undefined) ?? null,
      playwright: (r.playwright as boolean | undefined) ?? null,
    }));
  }

  async ping(): Promise<{ version: string | null; playwright: boolean | null }> {
    const r = await this.request("ping", {}, { timeoutMs: this.opts.startupTimeoutMs });
    return {
      version: (r.version as string | undefined) ?? null,
      playwright: (r.playwright as boolean | undefined) ?? null,
    };
  }

  /**
   * Issue one request. `signal` allows external cancellation (job cancel).
   *
   * Settle-once contract: the pending entry is removed from `this.pending`
   * and the promise rejected BEFORE the worker is asked to die (timeout,
   * abort). `kill()` -> `failAll()` then sees no leftover for this id, so
   * the caller's promise always settles exactly once — the queue can never
   * wedge on a timed-out request.
   */
  request<T = Record<string, unknown>>(
    op: WorkerOp,
    params: Record<string, unknown>,
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (!this.running) {
      throw new WorkerError("python worker is not running", "provider_unavailable");
    }
    const child = this.child!;
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    const line = JSON.stringify({ id, op, params }) + "\n";
    // Only log protocol metadata (id/op) — never params, which may carry
    // session paths or other sensitive material.
    this.log(`request sent id=${id} op=${op} timeoutMs=${timeoutMs}`);

    return new Promise<T>((resolve, reject) => {
      // Settle `id` exactly once, no matter which path fires first
      // (response, timeout, abort, process exit, close, stdin error).
      const settle = (fn: () => void): boolean => {
        const p = this.pending.get(id);
        if (!p) return false;
        this.pending.delete(id);
        clearTimeout(p.timer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
        return true;
      };

      const timer = setTimeout(() => {
        // 1) settle the timed-out request FIRST (structured error,
        //    ambiguous=true so the runner never auto-retries an operation
        //    that may have completed server-side),
        const settled = settle(() =>
          reject(
            new WorkerError(
              `python worker request timed out after ${Math.round(timeoutMs / 1000)}s (op=${op})`,
              "timeout",
              true,
            ),
          ),
        );
        this.log(
          `request timeout id=${id} op=${op} after ${timeoutMs}ms settled=${settled} -> killing worker`,
        );
        // 2) then terminate the worker. Its (late) response, if any, will be
        //    dropped as stale by onStdout() — no duplicate delivery.
        if (settled) {
          this.kill(
            new WorkerError(
              `python worker request timed out after ${Math.round(timeoutMs / 1000)}s (op=${op})`,
              "timeout",
              true,
            ),
          );
        }
      }, timeoutMs);

      const onAbort = () => {
        const settled = settle(() =>
          reject(new WorkerError(`python worker request cancelled (op=${op})`, "timeout")),
        );
        this.log(`request aborted id=${id} op=${op} settled=${settled} -> killing worker`);
        if (settled) {
          this.kill(new WorkerError(`python worker request cancelled (op=${op})`, "timeout"));
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (r) => {
          if (!settle(() => resolve((r.result ?? {}) as T))) return; // already settled
          this.log(`response ok id=${id} op=${op}`);
        },
        reject: (e) => {
          if (!settle(() => reject(e))) return; // already settled
          this.log(`response error id=${id} op=${op} code=${e.code}`);
        },
        timer,
      });

      try {
        child.stdin.write(line, (err) => {
          if (err) {
            const settled = settle(() =>
              reject(
                new WorkerError(
                  `worker stdin write failed: ${err.message}`,
                  "provider_unavailable",
                ),
              ),
            );
            if (settled) this.log(`stdin write failed id=${id} op=${op}: ${err.message}`);
          }
        });
      } catch (err) {
        const settled = settle(() =>
          reject(
            new WorkerError(`worker stdin write failed: ${String(err)}`, "provider_unavailable"),
          ),
        );
        if (settled) this.log(`stdin write failed (sync) id=${id} op=${op}: ${String(err)}`);
      }
    });
  }

  /** Forward worker events (progress/log) to the caller while a request runs. */
  setEventSink(sink: (data: Record<string, unknown>) => void): void {
    (this as { __sink?: (d: Record<string, unknown>) => void }).__sink = sink;
  }

  private emitEvent(data: Record<string, unknown>): void {
    const sink = (this as { __sink?: (d: Record<string, unknown>) => void }).__sink;
    sink?.(data);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    // Cap the unprocessed buffer against pathological output.
    if (this.stdoutBuf.length > 8 * 1024 * 1024) {
      this.log("worker stdout buffer exceeded 8MB — killing");
      this.kill(new WorkerError("worker stdout exceeded size limit", "provider"));
      return;
    }
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.log(`worker emitted non-JSON line (dropped): ${line.slice(0, 200)}`);
        continue;
      }
      const msg = WorkerInbound.safeParse(parsed);
      if (!msg.success) {
        this.log(`worker emitted invalid message (dropped): ${line.slice(0, 200)}`);
        continue;
      }
      if (isResponse(msg.data)) {
        const pending = this.pending.get(msg.data.id);
        if (!pending) continue; // stale (already settled by timeout/abort/exit)
        // The wrapper's settle() removes the entry exactly once — do NOT
        // delete it here, or settle() would find no entry and no-op.
        if (msg.data.ok) {
          pending.resolve(msg.data);
        } else {
          const code = msg.data.error?.code ?? "unknown";
          pending.reject(
            new WorkerError(msg.data.error?.message ?? "worker error", code, code === "ambiguous"),
          );
        }
      } else {
        this.emitEvent(msg.data.data ?? {});
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    const s = chunk.toString("utf8");
    if (this.stderrBytes < this.opts.maxStderrBytes) {
      this.stderrTail += s;
      this.stderrBytes += s.length;
      if (this.stderrTail.length > this.opts.maxStderrBytes) {
        this.stderrTail = this.stderrTail.slice(-this.opts.maxStderrBytes);
      }
    }
    // Always drain (even after cap) to avoid pipe backpressure deadlock.
    // Redact: python CLI stderr can echo session paths, cookie errors, or
    // credential-looking strings — never log them raw.
    this.log(`worker stderr: ${redactSecrets(s.trim().slice(0, 300))}`);
  }

  private tail(): string {
    return redactSecrets(this.stderrTail.slice(-2000).replace(/\s+/g, " ").trim());
  }

  private failAll(err: WorkerError): void {
    // Snapshot: each p.reject() -> settle() removes its own entry and clears
    // its own timer, so iterate a copy (do NOT delete first, or settle()
    // would find no entry and the promise would never settle).
    for (const [, p] of [...this.pending]) {
      p.reject(err);
    }
  }

  private kill(err: WorkerError): void {
    this.killing = true;
    this.log(`kill requested code=${err.code} ambiguous=${String(err.ambiguous)}: ${err.message}`);
    this.failAll(err);
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.log("kill: no live child (already gone)");
      return;
    }
    const pid = child.pid;
    this.escalateTimer = setTimeout(() => {
      this.log(`kill escalation: SIGKILL pid=${pid} (worker ignored SIGTERM for 5s)`);
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else child.kill("SIGTERM");
      this.log(`kill: SIGTERM sent pid=${pid}`);
    } catch {
      // Child is already gone; the exit/close handlers clear the timer.
      this.log(`kill: child already gone pid=${pid}`);
    }
  }

  private clearEscalation(): void {
    if (this.escalateTimer) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = null;
    }
  }

  /** Graceful shutdown: end stdin (EOF) + SIGTERM, wait, SIGKILL, drain. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.log("close: no live child");
      // Settle anything still in flight (defensive; exit normally did).
      this.failAll(new WorkerError("python worker is not running", "provider_unavailable"));
      return;
    }
    const pid = child.pid;
    // Mark as requested termination: the exit handler must not double-settle.
    this.killing = true;
    this.log(`close: requesting shutdown pid=${pid}`);
    // Settle ALL in-flight requests now. The caller (e.g. provider.cancel())
    // holds these promises — never leave them hanging. Code "timeout" (with
    // the server-side completion caveat) keeps the runner's existing
    // cancel-first handling: ambiguity alone would not change anything
    // because the runner checks the abort flag before the ambiguity rule.
    this.failAll(
      new WorkerError(
        "python worker closed by owner; NotebookLM-side operation may still complete",
        "timeout",
        true,
      ),
    );
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.log(`close: escalation SIGKILL pid=${pid} after 5s`);
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      // Also close stdin: the worker treats EOF as a shutdown, so it exits
      // cleanly even on hosts where SIGTERM delivery to asyncio processes
      // is unreliable (see nbl_worker.py main()).
      try {
        child.stdin.end();
      } catch {
        /* stdin may already be closed */
      }
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.clearEscalation();
    this.child = null;
    // failAll() above already settled and cleared every pending entry.
  }
}
