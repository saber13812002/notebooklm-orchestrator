import { existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import type { FailureClass } from "@nlo/shared";
import { redactSecrets } from "@nlo/shared";
import {
  CapLevel,
  ProviderFailure,
  capabilityMatrix,
  type NotebookLMProvider,
  type ProviderAccountStatus,
  type ProviderAudioDownloadRequest,
  type ProviderAudioDownloadResult,
  type ProviderAudioGenerateRequest,
  type ProviderAudioGenerateResult,
  type ProviderAudioStatus,
  type ProviderAudioStatusRequest,
  type ProviderAudioStatusResult,
  type ProviderJobRequest,
  type ProviderJobResult,
} from "../types.js";
import { WorkerError, WorkerSupervisor } from "./worker.js";
import { isAmbiguousCode, type WorkerOp } from "./protocol.js";

/**
 * PythonWorkerProvider: REAL NotebookLM access via notebooklm-py running in a
 * short-lived Python worker (JSON-line protocol over stdio).
 *
 * Honesty:
 *  - name is "python-worker" and it is never reported as mock.
 *  - A job without an approved tunnel FAILS (fail-closed) — there is no
 *    direct-egress fallback in the job path.
 *  - Capability levels below are live-untested until the live E2E passes.
 *
 * Session model:
 *  - Each account owns ONE storage-state file under `sessionDir` (0600):
 *        sessionDir/nlo-<accountId>.json
 *  - The file is produced by the `login` op (interactive Playwright) or by
 *    importing an existing storage_state.json. It is NEVER served over HTTP.
 *  - credentialRef format: "session:<accountId>".
 */
/** Minimal structural view of a proxy selection (avoids a hard dependency
 *  on the proxy layer; ProxyManager.select satisfies this). */
interface AuthTunnelSelection {
  node: { id: string; config: { name: string } };
  handle: { host: string; port: number };
}

export class PythonWorkerProvider implements NotebookLMProvider {
  readonly name = "python-worker";

  constructor(
    private readonly opts: {
      sessionDir: string;
      dataDir: string;
      pythonBin?: string;
      workerPath?: string;
      /** Browser channel for interactive login (chromium | chrome | msedge). */
      loginBrowser?: string;
      /** Per-job hard timeout (default 30 min). */
      jobTimeoutMs?: number;
      /**
       * True to allow auth ops (login/verify) WITHOUT a tunnel when NO proxy
       * node is configured at all. Jobs are ALWAYS fail-closed regardless.
       */
      allowDirect?: boolean;
      /** Selects/starts a tunnel for auth ops (login/verify) — fail-closed.
       *  selectAuto self-heals stale health checks (runs the real staged
       *  check against the NotebookLM target) before failing. */
      proxyManager?: {
        selectAuto: (preferredNodeId: string | null) => Promise<AuthTunnelSelection>;
      };
      /** Configured nodes (direct auth only when none exist). */
      proxiesRepo?: {
        countEnabled: () => number;
        listEnabled: () => { id: string }[];
        health: (nodeId: string) => { lastCheckedAt: string | null } | null;
      };
      log?: (line: string) => void;
    },
  ) {
    mkdirSync(this.opts.sessionDir, { recursive: true, mode: 0o700 });
  }

  get log() {
    return this.opts.log ?? (() => {});
  }

  sessionPathFor(accountId: string): string {
    return path.join(this.opts.sessionDir, `nlo-${accountId}.json`);
  }

  private resolveCredential(credentialRef: string, accountId: string): string {
    if (credentialRef === "session" || credentialRef === `session:${accountId}`) {
      return this.sessionPathFor(accountId);
    }
    // Explicit path refs must stay inside the session dir (no traversal).
    const p = path.resolve(credentialRef);
    const dir = path.resolve(this.opts.sessionDir);
    if (!p.startsWith(dir + path.sep)) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: `credentialRef outside session dir: ${credentialRef}`,
        needsReauth: false,
        ambiguous: false,
      });
    }
    return p;
  }

  /** Strict mapping worker error code -> app FailureClass. */
  private toFailureClass(code: string): FailureClass {
    switch (code) {
      case "auth":
        return "auth";
      case "rate_limit":
        return "rate_limit";
      case "connectivity":
        return "connectivity";
      case "invalid_input":
        return "invalid_input";
      case "ambiguous":
        return "ambiguous";
      case "timeout":
      case "provider":
      case "provider_unavailable":
      case "configuration":
        return "provider";
      default:
        return "unknown";
    }
  }

  /**
   * Auth ops (login/verify) must reach the real service. When any proxy node
   * is configured, a tunnel is REQUIRED (same fail-closed policy as jobs):
   * select() validates config + fresh health and starts the tunnel. Only when
   * NO node exists at all does direct egress proceed (an explicit, logged
   * configuration choice).
   */
  private async acquireAuthTunnel(): Promise<{
    nodeId: string;
    handle: { host: string; port: number } | null;
    browserProxy: { server: string } | null;
  }> {
    const pm = this.opts.proxyManager;
    const repo = this.opts.proxiesRepo;
    const enabled = repo?.listEnabled() ?? [];
    if (!pm || enabled.length === 0) {
      if (!this.opts.allowDirect) {
        throw new ProviderFailure({
          failureClass: "proxy",
          message:
            "no proxy route available for auth (fail-closed): configure a proxy node or set NLO_ALLOW_DIRECT_EGRESS=1",
          ambiguous: false,
          needsReauth: false,
        });
      }
      this.log(
        "auth op proceeding with DIRECT egress (no proxy node configured; NLO_ALLOW_DIRECT_EGRESS=1)",
      );
      return { nodeId: "", handle: null, browserProxy: null };
    }
    // selectAuto self-heals stale health (10-min TTL passed) by running the
    // real staged check against the NotebookLM target before failing — the
    // server keeps the user from doing anything, and there is never a
    // direct-egress fallback.
    const sel = await pm.selectAuto(null);
    this.log(
      `auth op routed through node ${sel.node.config.name} (tunnel ${sel.handle.host}:${sel.handle.port})`,
    );
    const server = `http://${sel.handle.host}:${sel.handle.port}`;
    return {
      nodeId: sel.node.id,
      handle: { host: sel.handle.host, port: sel.handle.port },
      browserProxy: { server },
    };
  }

  /** Env for a job's worker so notebooklm-py routes through the tunnel. */
  private tunnelEnv(tunnel: { host: string; port: number }): Record<string, string> {
    const proxy = `http://${tunnel.host}:${tunnel.port}`;
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
  }

  capabilities() {
    const live = CapLevel.implementedUntestedLive;
    return capabilityMatrix({
      validateConfiguration: {
        level: CapLevel.implementedTested,
        note: "worker ping + import check",
      },
      getAccountStatus: { level: live, note: "verify against real service" },
      login: { level: live, note: "interactive Playwright browser sign-in" },
      submitAudioJob: { level: live, note: "real upload + ask via notebooklm-py" },
      retrieveTextJob: {
        level: live,
        note: "real add_text + ask via notebooklm-py 0.8.5",
      },
      retrieveResult: { level: live, note: "real grounded answer" },
      retrieveArtifacts: {
        level: CapLevel.unsupported,
        note: "chat answers are text; no downloadable artifacts in this workflow",
      },
      cancelJob: {
        level: CapLevel.experimental,
        note: "kills the worker; in-flight server op may still finish",
      },
      generateAudio: {
        level: live,
        note: "real Audio Overview submit via notebooklm-py artifacts.generate_audio (NLO-P2)",
      },
      getAudioStatus: {
        level: live,
        note: "real task polling via artifacts.poll_status (NLO-P2)",
      },
      downloadAudio: {
        level: live,
        note: "real artifact download + verification via artifacts.download_audio (NLO-P2)",
      },
    });
  }

  inputCapabilities() {
    const live = CapLevel.implementedUntestedLive;
    const exp = CapLevel.experimental;
    return [
      {
        format: "text",
        level: live,
        note: "submitted via sources.add_text (verified API in notebooklm-py 0.8.5)",
      },
      {
        format: "txt",
        level: live,
        note: "submitted verbatim as a text source (sources.add_text)",
      },
      {
        format: "srt",
        level: live,
        note: "validated in the app layer, submitted verbatim as a text source",
      },
      {
        format: "docx",
        level: live,
        note: "extracted to plain text in the app layer (mammoth), submitted via sources.add_text",
      },
      {
        format: "wav",
        level: live,
        note: "live-verified real NotebookLM upload 2026-11-06",
      },
      { format: "mp3", level: exp, note: "not live-verified on the real service" },
      { format: "m4a", level: exp, note: "not live-verified on the real service" },
      { format: "ogg", level: exp, note: "not live-verified on the real service" },
      { format: "flac", level: exp, note: "not live-verified on the real service" },
    ];
  }

  async validateConfiguration(): Promise<{ ok: boolean; issues: string[] }> {
    const issues: string[] = [];
    try {
      const w = new WorkerSupervisor({
        pythonBin: this.opts.pythonBin,
        workerPath: this.opts.workerPath,
        startupTimeoutMs: 30_000,
        log: this.log,
      });
      const info = await w.start();
      if (!info.version) issues.push("notebooklm-py package not importable in worker python");
      if (info.playwright === false) {
        issues.push("playwright not installed (login op will fail until installed)");
      }
      await w.close();
      return { ok: issues.length === 0, issues };
    } catch (e) {
      issues.push(`worker start failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, issues };
    }
  }

  async getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus> {
    const sessionPath = this.resolveCredential(credentialRef, accountId);
    if (!existsSync(sessionPath)) {
      return {
        ok: false,
        email: null,
        detail: "no session stored for this account (login required)",
      };
    }
    // Verification talks to the REAL service: route through a verified tunnel
    // (fail-closed when nodes exist). The tunnel is kept alive while used.
    const tunnel = await this.acquireAuthTunnel();
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: tunnel.handle ? this.tunnelEnv(tunnel.handle) : {},
      // Through a residential proxy the round-trip to Google can be slow;
      // give verification generous headroom (5 min supervisor / 2 min per
      // inner request) rather than killing a healthy session check.
      requestTimeoutMs: 300_000,
      correlationId: `acct:${accountId}`,
      log: this.log,
    });
    try {
      await w.start();
      const r = await w.request<{ email: string; notebooks: number; checkedAt: string }>("verify", {
        sessionPath,
        timeoutSec: 120,
      });
      return {
        ok: true,
        email: r.email,
        detail: `verified against service (${r.notebooks} notebooks)`,
      };
    } catch (e) {
      const code = e instanceof WorkerError ? e.code : "provider";
      const message = e instanceof Error ? e.message : String(e);
      const cls = this.toFailureClass(code);
      if (cls === "auth") {
        return {
          ok: false,
          email: null,
          detail: `session rejected by service (re-login required): ${message.slice(0, 200)}`,
        };
      }
      throw new ProviderFailure({
        failureClass: cls,
        message,
        ambiguous: isAmbiguousCode(code),
        needsReauth: false, // auth case already returned above
      });
    } finally {
      await w.close();
    }
  }

  /** Interactive login: opens a browser; the user signs in; session saved 0600.
   *
   * The browser itself is routed through the verified tunnel (Playwright
   * `proxy` launch option) — Chromium ignores HTTP(S)_PROXY env vars — and
   * the post-login verification call uses the same tunnel. */
  async login(
    accountId: string,
    opts: { timeoutSec?: number; headless?: boolean; browser?: string } = {},
  ): Promise<{ email: string | null }> {
    const sessionPath = this.sessionPathFor(accountId);
    const tunnel = await this.acquireAuthTunnel();
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: tunnel.handle ? this.tunnelEnv(tunnel.handle) : {},
      requestTimeoutMs: (opts.timeoutSec ?? 600) * 1000 + 120_000,
      correlationId: `login:${accountId}`,
      log: this.log,
    });
    try {
      await w.start();
      const r = await w.request<{ email: string | null }>("login", {
        sessionPath,
        timeoutSec: opts.timeoutSec ?? 600,
        headless: opts.headless ?? false,
        browser: opts.browser ?? this.opts.loginBrowser ?? "chromium",
        proxy: tunnel.browserProxy,
      });
      try {
        chmodSync(sessionPath, 0o600);
      } catch {
        /* best effort */
      }
      return { email: r.email ?? null };
    } finally {
      await w.close();
    }
  }

  /**
   * Import Google cookies from an installed, non-automated browser (Chrome,
   * Firefox, …). This is the UI-friendly alternative to the Playwright login
   * that Google's bot detection rejects: the user signs in with their normal
   * browser once, and we copy the session locally through the installed
   * notebooklm-py CLI. The resulting session is verified against the REAL
   * service (through the tunnel) before this method returns.
   *
   * Routing honesty: the browser's cookie JAR is read from disk — the browser
   * itself does NOT route through our tunnel for this operation. The CLI's
   * verification step and all subsequent NotebookLM requests DO route through
   * the tunnel (HTTPS_PROXY).
   */
  async browserImport(
    accountId: string,
    opts: {
      browser: string;
      account?: string;
      timeoutSec?: number;
    },
  ): Promise<{ email: string | null }> {
    const sessionPath = this.sessionPathFor(accountId);
    const tunnel = await this.acquireAuthTunnel();
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: tunnel.handle ? this.tunnelEnv(tunnel.handle) : {},
      requestTimeoutMs: (opts.timeoutSec ?? 180) * 1000 + 120_000,
      correlationId: `browser-import:${accountId}`,
      log: this.log,
    });
    try {
      await w.start();
      w.setEventSink((data) => {
        if (typeof data.stage === "string" && data.stage === "cli_stderr") {
          // Redact: browser cookie-import stderr can contain credential-looking
          // material (cookie dump errors, storage paths, tokens).
          this.log(`worker cli: ${redactSecrets(typeof data.line === "string" ? data.line : "")}`);
        }
      });
      const r = await w.request<{ email: string | null; notebooks: number }>("browser-import", {
        sessionPath,
        browser: opts.browser,
        account: opts.account,
        timeoutSec: opts.timeoutSec ?? 180,
      });
      try {
        chmodSync(sessionPath, 0o600);
      } catch {
        /* best effort */
      }
      return { email: r.email ?? null };
    } finally {
      await w.close();
    }
  }

  async runJob(req: ProviderJobRequest): Promise<ProviderJobResult> {
    if (!req.tunnel && !this.opts.allowDirect) {
      throw new ProviderFailure({
        failureClass: "proxy",
        message:
          "no approved proxy tunnel for this job (fail-closed: direct egress is not allowed)",
        ambiguous: false,
        needsReauth: false,
      });
    }
    const sessionPath = this.resolveCredential(req.credentialRef, req.accountId);
    if (!existsSync(sessionPath)) {
      throw new ProviderFailure({
        failureClass: "auth",
        message: "account has no stored session — complete login first",
        ambiguous: false,
        needsReauth: true,
      });
    }
    // A recorded audio input whose archive file no longer exists (e.g. an
    // archive pruned between job creation and execution) must fail with a
    // clear error, not be turned into the relative path "." that the worker
    // would then reject with a confusing FileNotFoundError.
    const audioPath: string | null = req.audioPath ?? null;
    if (audioPath && !existsSync(audioPath)) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: "input audio is recorded for this job but the stored file is missing",
        ambiguous: false,
        needsReauth: false,
      });
    }
    // H1: the app passes a resolved, meaningful notebook title (user title or
    // derived from the text). Audio jobs without one keep the legacy fallback.
    const notebookTitle = req.notebookTitle?.trim() || `nlo-${req.jobId.slice(0, 16)}`;
    const isText = Boolean(req.textPath);
    const textPath: string | null = req.textPath ?? null;
    if (textPath && !existsSync(textPath)) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: "input text is recorded for this job but the stored file is missing",
        ambiguous: false,
        needsReauth: false,
      });
    }
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: req.tunnel ? this.tunnelEnv(req.tunnel) : {},
      requestTimeoutMs: this.opts.jobTimeoutMs ?? 30 * 60_000,
      correlationId: `job:${req.jobId}`,
      log: this.log,
    });

    const stageProgress: Record<string, [number, string]> = {
      opening_session: [10, "opening authenticated session"],
      selecting_notebook: [20, "selecting/creating notebook"],
      uploading_audio: [30, "uploading audio to NotebookLM"],
      upload_done: [50, "upload complete"],
      adding_text: [30, "adding text source to NotebookLM"],
      text_added: [50, "text source added"],
      waiting_for_processing: [55, "waiting for NotebookLM to process source"],
      processing_done: [75, "source processed"],
      executing_prompt: [80, "executing prompt"],
      prompt_done: [95, "prompt completed"],
    };
    w.setEventSink((data) => {
      const stage = typeof data.stage === "string" ? data.stage : "";
      const next = stageProgress[stage];
      if (next) req.onProgress(next[0], next[1]);
    });

    this.active.set(req.jobId, w);
    try {
      await w.start();
      const r = await w.request<{
        email: string;
        notebookId: string | null;
        notebookTitle: string;
        sourceId: string | null;
        uploaded: boolean;
        conversationId: string | null;
        turnNumber: number | null;
        answer: string;
        references: { sourceId: string | null; quote: string | null }[];
        checkedAt: string;
      }>(
        isText ? "job_text" : "job",
        isText
          ? {
              sessionPath,
              textPath: textPath!,
              textTitle: req.textTitle?.trim() || "",
              prompt: req.prompt,
              notebookTitle,
              waitSec: 1800,
              timeoutSec: Math.floor((this.opts.jobTimeoutMs ?? 30 * 60_000) / 1000),
            }
          : {
              sessionPath,
              audioPath: audioPath ?? "",
              audioName: audioPath ? path.basename(audioPath) : "",
              prompt: req.prompt,
              notebookTitle,
              waitSec: 1800,
              timeoutSec: Math.floor((this.opts.jobTimeoutMs ?? 30 * 60_000) / 1000),
            },
        { signal: req.signal },
      );

      // An empty prompt (summary disabled) legitimately has no answer; only a
      // non-empty prompt that came back empty is a provider failure.
      if (req.prompt.trim() !== "" && (!r.answer || r.answer.trim().length === 0)) {
        throw new ProviderFailure({
          failureClass: "provider",
          message: "provider returned an empty answer; not reporting success",
          ambiguous: true,
          needsReauth: false,
        });
      }
      req.onProgress(100, "operation completed");
      return {
        answerMarkdown: r.answer.trim() ? r.answer : null,
        providerMeta: {
          simulated: false,
          provider: this.name,
          email: r.email,
          sourceKind: isText ? "text" : "audio",
          notebookId: r.notebookId,
          notebookTitle: r.notebookTitle,
          sourceId: r.sourceId,
          uploaded: r.uploaded,
          conversationId: r.conversationId,
          turnNumber: r.turnNumber,
          references: r.references,
          checkedAt: r.checkedAt,
          route: req.tunnel
            ? { nodeId: req.tunnel.nodeId, host: req.tunnel.host, port: req.tunnel.port }
            : null,
        },
        artifacts: [],
      };
    } catch (e) {
      if (e instanceof ProviderFailure) throw e;
      const code = e instanceof WorkerError ? e.code : "unknown";
      const message = e instanceof Error ? e.message : String(e);
      const timedOut =
        e instanceof WorkerError && (e.code === "timeout" || /timed out/.test(e.message));
      const failed = timedOut ? " (operation failed: see timeout)" : "";
      throw new ProviderFailure({
        failureClass: this.toFailureClass(code),
        message: `python-worker: ${message}${failed}`,
        ambiguous: isAmbiguousCode(code),
        needsReauth: code === "auth",
      });
    } finally {
      this.active.delete(req.jobId);
      await w.close();
    }
  }

  // ------------------------------------------------------------------
  // NLO-P2: Audio Overview (podcast) pipeline.
  //
  // One short-lived worker per operation (same lifecycle discipline as
  // runJob). The external operation is tracked by its TASK ID (== artifact
  // id): the app persists it and may resume via generateAudio(resumeTaskId).
  // Re-submission only happens on proven failure (worker enforces this).
  // ------------------------------------------------------------------

  /** Map of worker progress stages (audio ops) to app progress percentages. */
  private static readonly AUDIO_STAGE_PROGRESS: Record<string, [number, string]> = {
    opening_session: [10, "opening authenticated session"],
    validating_notebook: [20, "validating notebook and sources"],
    checking_resume: [25, "checking recorded task for idempotency"],
    resume_kept: [30, "reusing existing generation task"],
    resume_failed_resubmitting: [35, "re-submitting failed generation"],
    submitting_audio: [40, "submitting Audio Overview generation"],
    audio_submitted: [60, "generation submitted — task recorded"],
    polling_audio: [30, "polling generation task"],
    locating_artifact: [20, "locating audio artifact"],
    artifact_not_ready: [40, "artifact not finished yet"],
    downloading_audio: [50, "downloading audio artifact"],
    verifying_audio: [90, "verifying downloaded audio"],
  };

  /**
   * Shared pre-flight + worker construction for the audio ops: fail-closed
   * tunnel check, credential resolution, session existence (auth/needsReauth).
   */
  private prepareAudioWorker(
    req: {
      jobId: string;
      accountId: string;
      credentialRef: string;
      tunnel: { nodeId: string; host: string; port: number } | null;
    },
    correlation: string,
  ): { sessionPath: string; w: WorkerSupervisor } {
    if (!req.tunnel && !this.opts.allowDirect) {
      throw new ProviderFailure({
        failureClass: "proxy",
        message:
          "no approved proxy tunnel for this audio operation (fail-closed: direct egress is not allowed)",
        ambiguous: false,
        needsReauth: false,
      });
    }
    const sessionPath = this.resolveCredential(req.credentialRef, req.accountId);
    if (!existsSync(sessionPath)) {
      throw new ProviderFailure({
        failureClass: "auth",
        message: "account has no stored session — complete login first",
        ambiguous: false,
        needsReauth: true,
      });
    }
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: req.tunnel ? this.tunnelEnv(req.tunnel) : {},
      requestTimeoutMs: this.opts.jobTimeoutMs ?? 30 * 60_000,
      correlationId: correlation,
      log: this.log,
    });
    return { sessionPath, w };
  }

  /**
   * Run one audio op on a fresh worker with the standard error mapping and
   * cleanup. The worker is registered in `this.active` under `req.jobId` so
   * `cancel(jobId)` covers in-flight audio operations too.
   */
  private async withAudioWorker<T>(
    req: { jobId: string; signal: AbortSignal; onProgress: (p: number, n: string) => void },
    w: WorkerSupervisor,
    op: WorkerOp,
    params: Record<string, unknown>,
    done: () => string,
  ): Promise<T> {
    w.setEventSink((data) => {
      const stage = typeof data.stage === "string" ? data.stage : "";
      const next = PythonWorkerProvider.AUDIO_STAGE_PROGRESS[stage];
      if (next) req.onProgress(next[0], next[1]);
    });
    this.active.set(req.jobId, w);
    try {
      await w.start();
      const r = await w.request<T>(op, params, { signal: req.signal });
      req.onProgress(100, done());
      return r;
    } catch (e) {
      if (e instanceof ProviderFailure) throw e;
      const code = e instanceof WorkerError ? e.code : "unknown";
      const message = e instanceof Error ? e.message : String(e);
      throw new ProviderFailure({
        failureClass: this.toFailureClass(code),
        message: `python-worker (${op}): ${message}`,
        ambiguous: isAmbiguousCode(code),
        needsReauth: code === "auth",
      });
    } finally {
      this.active.delete(req.jobId);
      await w.close();
    }
  }

  private timeoutSec(): number {
    return Math.floor((this.opts.jobTimeoutMs ?? 30 * 60_000) / 1000);
  }

  /**
   * Submit (or resume) an Audio Overview generation. Idempotency contract:
   * when `resumeTaskId` is given the worker polls it FIRST and only re-submits
   * on proven failure ("failed"); completed/in-progress/not-found tasks are
   * kept as-is. The returned `status.taskId` is the recoverable handle.
   */
  async generateAudio(req: ProviderAudioGenerateRequest): Promise<ProviderAudioGenerateResult> {
    const { sessionPath, w } = this.prepareAudioWorker(req, `audio-gen:${req.jobId}`);
    const raw = await this.withAudioWorker<Record<string, unknown>>(
      req,
      w,
      "audio_generate",
      {
        sessionPath,
        notebookId: req.notebookId,
        sourceIds: req.sourceIds ?? null,
        prompt: req.prompt ?? null,
        language: req.language ?? null,
        audioFormat: req.audioFormat ?? null,
        audioLength: req.audioLength ?? null,
        resumeTaskId: req.resumeTaskId ?? null,
        timeoutSec: this.timeoutSec(),
      },
      () => "audio generation submitted or resumed",
    );
    const status: ProviderAudioStatus = {
      taskId: typeof raw.taskId === "string" ? raw.taskId : null,
      status: typeof raw.status === "string" ? raw.status : null,
      url: typeof raw.url === "string" ? raw.url : null,
      error: typeof raw.error === "string" ? raw.error : null,
      errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
      metadata:
        raw.metadata && typeof raw.metadata === "object"
          ? (raw.metadata as Record<string, unknown>)
          : null,
      isComplete: raw.isComplete === true,
      isFailed: raw.isFailed === true,
      isTerminal: raw.isTerminal === true,
      isNotFound: raw.isNotFound === true,
      isRateLimited: raw.isRateLimited === true,
    };
    if (!status.taskId) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "worker reported no task id for the audio generation; not reporting success",
        ambiguous: true,
        needsReauth: false,
      });
    }
    return {
      email: typeof raw.email === "string" ? raw.email : null,
      notebookId: typeof raw.notebookId === "string" ? raw.notebookId : req.notebookId,
      resumed: raw.resumed === true,
      priorStatus: typeof raw.priorStatus === "string" ? raw.priorStatus : null,
      status,
      instructionsProvided: raw.instructionsProvided === true,
      checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : new Date().toISOString(),
    };
  }

  /** Poll a recorded generation task (task id == artifact id). */
  async getAudioStatus(req: ProviderAudioStatusRequest): Promise<ProviderAudioStatusResult> {
    const { sessionPath, w } = this.prepareAudioWorker(req, `audio-status:${req.jobId}`);
    const raw = await this.withAudioWorker<Record<string, unknown>>(
      req,
      w,
      "audio_status",
      {
        sessionPath,
        notebookId: req.notebookId,
        taskId: req.taskId,
        timeoutSec: this.timeoutSec(),
      },
      () => "polled",
    );
    return {
      notebookId: typeof raw.notebookId === "string" ? raw.notebookId : req.notebookId,
      status: {
        taskId: typeof raw.taskId === "string" ? raw.taskId : req.taskId,
        status: typeof raw.status === "string" ? raw.status : null,
        url: typeof raw.url === "string" ? raw.url : null,
        error: typeof raw.error === "string" ? raw.error : null,
        errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
        metadata:
          raw.metadata && typeof raw.metadata === "object"
            ? (raw.metadata as Record<string, unknown>)
            : null,
        isComplete: raw.isComplete === true,
        isFailed: raw.isFailed === true,
        isTerminal: raw.isTerminal === true,
        isNotFound: raw.isNotFound === true,
        isRateLimited: raw.isRateLimited === true,
      },
      checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : new Date().toISOString(),
    };
  }

  /**
   * Fetch a completed audio artifact to `req.destPath` (server-controlled,
   * app-generated name) and verify the transfer. `ready: false` means the
   * artifact exists but is not finished — NOT an error.
   */
  async downloadAudio(req: ProviderAudioDownloadRequest): Promise<ProviderAudioDownloadResult> {
    if (!req.destPath || !path.isAbsolute(req.destPath)) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: `destPath must be a non-empty absolute path: ${req.destPath}`,
        ambiguous: false,
        needsReauth: false,
      });
    }
    const { sessionPath, w } = this.prepareAudioWorker(req, `audio-dl:${req.jobId}`);
    const raw = await this.withAudioWorker<Record<string, unknown>>(
      req,
      w,
      "audio_download",
      {
        sessionPath,
        notebookId: req.notebookId,
        artifactId: req.artifactId,
        destPath: req.destPath,
        maxBytes: req.maxBytes ?? null,
        timeoutSec: this.timeoutSec(),
      },
      () => "audio artifact download operation completed",
    );
    if (raw.ready !== true) {
      return {
        ready: false,
        notebookId: typeof raw.notebookId === "string" ? raw.notebookId : req.notebookId,
        artifactId: req.artifactId,
        artifactStatus: typeof raw.artifactStatus === "string" ? raw.artifactStatus : undefined,
        checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : new Date().toISOString(),
      };
    }
    if (
      typeof raw.path !== "string" ||
      typeof raw.size !== "number" ||
      typeof raw.sha256 !== "string"
    ) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "worker reported a ready artifact without path/size/sha256; not reporting success",
        ambiguous: true,
        needsReauth: false,
      });
    }
    return {
      ready: true,
      notebookId: typeof raw.notebookId === "string" ? raw.notebookId : req.notebookId,
      artifactId: req.artifactId,
      path: raw.path,
      size: raw.size,
      sha256: raw.sha256,
      durationSeconds: typeof raw.durationSeconds === "number" ? raw.durationSeconds : null,
      artifactTitle: typeof raw.artifactTitle === "string" ? raw.artifactTitle : null,
      artifactStatus: typeof raw.artifactStatus === "string" ? raw.artifactStatus : "completed",
      checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : new Date().toISOString(),
    };
  }

  /**
   * Cancellation: there is one worker per job; killing it aborts the request.
   * The NOTEBOOKLM-side operation may still finish (documented limit).
   */
  private active = new Map<string, WorkerSupervisor>();
  cancel(jobId: string): Promise<{ accepted: boolean; note: string }> {
    const w = this.active.get(jobId);
    if (!w) {
      return Promise.resolve({
        accepted: false,
        note: "no active worker for this job (already finished or not started)",
      });
    }
    this.active.delete(jobId);
    return w.close().then(() => ({
      accepted: true,
      note: "worker terminated; in-flight NotebookLM operation may still complete server-side",
    }));
  }
}
