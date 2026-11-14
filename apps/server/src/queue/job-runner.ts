import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { backoffMs, classifyError, isRetryableError, safeName, resolveWithin } from "@nlo/shared";
import type { Job, FailureClass } from "@nlo/shared";
import type { JobsRepo } from "../domain/jobs.repo.js";
import type { AccountRow, AccountsRepo } from "../domain/accounts.repo.js";
import type { AuthSessionsRepo } from "../domain/auth-sessions.repo.js";
import type { ProxiesRepo } from "../domain/proxies.repo.js";
import { JobArchive, sha256OfFile } from "../domain/archive.js";
import { audioMimeToExt, readWavInfo, sniffAudioMime } from "../domain/artifact-validate.js";
import { ArtifactRepo } from "../domain/artifacts.repo.js";
import { JobStagesRepo } from "../domain/stages.repo.js";
import { transcodeToMp3 } from "../media/transcode.js";
import { ProviderFailure, type NotebookLMProvider } from "../providers/types.js";
import type { ProxyManager } from "../proxy/proxy-manager.js";
import type { ProxyRuntime, TunnelHandle } from "../proxy/runtime.js";
import type { SecretVault } from "../secrets/vault.js";
import type { ProviderEgress } from "../proxy/egress.js";

/**
 * JobRunner: drives a single job through the state machine, coordinating
 * account selection, proxy selection (fail-closed), provider execution,
 * retry policy, and archive writes.
 *
 * Concurrency: the queue processes at most ONE job at a time by default —
 * we do not run multiple operations concurrently against one account unless
 * the provider behavior is verified (it is not, for live).
 *
 * State machine path (enforced by @nlo/shared job-state.ts):
 *   CREATED -> VALIDATING -> QUEUED -> WAITING_FOR_ACCOUNT -> WAITING_FOR_PROXY
 *            -> RUNNING -> SUCCEEDED | FAILED | NEEDS_ATTENTION | CANCELLED
 * Retry (bounded): RUNNING -> RETRY_WAIT -> WAITING_FOR_ACCOUNT (loop
 * re-selects account + proxy and runs again).
 *
 * Archive: every status change is mirrored to execution/timeline.jsonl and
 * every attempt to execution/attempts.json + errors.json (best-effort; a
 * broken archive never breaks the state machine).
 */
export interface JobRunnerDeps {
  jobs: JobsRepo;
  accounts: AccountsRepo;
  /** Real auth-session records (the ONLY evidence of a usable credential).
   *  Optional for backward-compat with older test harnesses; when present,
   *  account eligibility requires a live, verified session — never a plain
   *  DB status flag. */
  sessions?: AuthSessionsRepo;
  proxies: ProxiesRepo;
  provider: NotebookLMProvider;
  proxyManager: ProxyManager;
  runtime: ProxyRuntime;
  vault: SecretVault;
  egress: ProviderEgress;
  jobsDir: string;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  /** NLO-P2: podcast polling budget in ms (default 25 minutes). */
  podcastDeadlineMs?: number;
  /** NLO-P2: hard cap on the stored podcast artifact size (default 200 MiB). */
  maxPodcastBytes?: number;
  /** NLO-P2: absolute path to the ffmpeg executable used for MP3 transcoding.
   *  Unset (or a path that does not exist) → the original artifact stays
   *  canonical and the job reports transcode status "not_configured". The
   *  application never installs ffmpeg itself. */
  ffmpegBin?: string;
  /** NLO-P2: target MP3 bitrate in kbps (default 56, clamped to 8..320). */
  mp3TargetKbps?: number;
  /** NLO-P2: hard timeout for a single transcode (ms, default 5 minutes). */
  transcodeTimeoutMs?: number;
  /** NLO-P2: artifact registry (the single writer for the artifacts table). */
  artifacts: ArtifactRepo;
  /** NLO-P2: per-stage persistence for the podcast pipeline. Optional so
   *  older test harnesses keep working; when absent, stage rows are simply
   *  not recorded. */
  stages?: JobStagesRepo;
  /** NLO-P2 (webhooks): publisher for job.running + terminal events.
   *  Optional so older test harnesses keep working; absent = no emission. */
  webhooks?: { publish: (jobId: string, eventType: string) => void };
}

const sleepDefault = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];

export class JobRunner {
  private active = new Map<string, AbortController>();

  constructor(private readonly d: JobRunnerDeps) {}

  queuedIds(): string[] {
    // Newly created jobs enter as CREATED; they are validated on first pick-up.
    return this.d.jobs.list({ status: ["CREATED", "QUEUED"], limit: 200 }).items.map((j) => j.id);
  }

  isActive(jobId: string): boolean {
    return this.active.has(jobId);
  }

  cancel(jobId: string): boolean {
    const c = this.active.get(jobId);
    if (!c) return false;
    c.abort();
    return true;
  }

  /**
   * Execute a job end-to-end. Only proceeds from CREATED (validate first) or
   * QUEUED. Errors are classified, then retried (bounded) or terminalized.
   */
  async run(jobId: string): Promise<Job> {
    const initial = this.d.jobs.getOrThrow(jobId);
    if (initial.status !== "CREATED" && initial.status !== "QUEUED") {
      return initial; // not our turn (e.g. already running in another worker)
    }

    const controller = new AbortController();
    this.active.set(jobId, controller);
    const archive = new JobArchive(this.d.jobsDir, jobId);

    try {
      if (initial.status === "CREATED") {
        // --- VALIDATING ---------------------------------------------------
        this.d.jobs.setStatus(jobId, "VALIDATING");
        this.logEvent(jobId, archive, "validate", "validating input");
        if (!this.validate(jobId, archive)) {
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId); // failed inside validate()
        }
        // Validation passed: the job is now QUEUED and ready to execute.
        this.d.jobs.setStatus(jobId, "QUEUED");
      }

      for (;;) {
        // --- select account (re-selected on every retry) -----------------
        // Note: after a RETRY_WAIT the status is ALREADY WAITING_FOR_ACCOUNT
        // (set by the retry path below); the state machine forbids a
        // WAITING_FOR_ACCOUNT -> WAITING_FOR_ACCOUNT self-transition, so we
        // only set it when coming from QUEUED (first attempt).
        if (this.d.jobs.getOrThrow(jobId).status !== "WAITING_FOR_ACCOUNT") {
          this.d.jobs.setStatus(jobId, "WAITING_FOR_ACCOUNT");
        }
        let account: AccountRow;
        try {
          account = this.selectAccount(this.d.jobs.getOrThrow(jobId));
        } catch {
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId); // selectAccount failed the job
        }
        this.logEvent(jobId, archive, "account_selected", `account ${account.label}`);

        // --- select proxy (fail-closed) ----------------------------------
        this.d.jobs.setStatus(jobId, "WAITING_FOR_PROXY");
        let handle: TunnelHandle | null = null;
        let nodeId: string | null = null;
        try {
          // selectAuto() validates (config + fresh healthy check) AND starts
          // the tunnel; it throws when no node can provide a real route.
          // When health is merely STALE (10-min TTL passed), it runs the real
          // staged check against the NotebookLM target first (self-heal), so
          // a previously-verified node keeps working without manual clicks.
          const sel = await this.d.proxyManager.selectAuto(
            this.d.jobs.getOrThrow(jobId).input.preferredNodeId,
          );
          nodeId = sel.node.id;
          handle = sel.handle;
          this.logEvent(
            jobId,
            archive,
            "proxy_selected",
            `node ${sel.node.config.name}; tunnel ${sel.handle.host}:${sel.handle.port} — ${sel.reason}`,
          );
          for (const r of sel.rejected) {
            this.logEvent(
              jobId,
              archive,
              "proxy_candidate_rejected",
              `node ${r.nodeId}: ${r.reason}`,
            );
          }
        } catch (err) {
          const msg = redact(String(err));
          this.d.jobs.setStatus(jobId, "FAILED", {
            errorClass: "proxy",
            errorMessage: `no approved proxy route available (fail-closed): ${msg}`,
          });
          this.logEvent(jobId, archive, "proxy_unavailable", msg);
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId);
        }

        // --- RUNNING -------------------------------------------------------
        // A cancel request arriving between the WAITING_FOR_PROXY and RUNNING
        // status writes (or during selection, when status is not RUNNING yet)
        // must not be lost: the API route set the job to CANCEL_REQUESTED
        // while the runner was in flight. Without this check the attempt would
        // start and a later cancel would no-op (no active controller) —
        // orphaning the job in CANCEL_REQUESTED forever.
        if (this.d.jobs.getOrThrow(jobId).status === "CANCEL_REQUESTED") {
          this.d.jobs.setStatus(jobId, "CANCELLED", {
            errorClass: "provider",
            errorMessage: "cancelled by user",
          });
          this.logEvent(jobId, archive, "cancelled", "cancelled before attempt started");
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId);
        }
        const job = this.d.jobs.getOrThrow(jobId);
        this.d.jobs.setStatus(jobId, "RUNNING", { accountId: account.id, nodeId });
        this.logEvent(jobId, archive, "running", `attempt ${job.attempt + 1}`);
        this.d.webhooks?.publish(jobId, "job.running");
        const credentialRef = account.authSecretRef ?? `session:${account.id}`;
        const attemptStart = new Date().toISOString();
        const attemptNo = job.attempt + 1;

        try {
          const result = await this.d.provider.runJob({
            jobId,
            accountId: account.id,
            credentialRef,
            prompt: job.input.prompt,
            audioPath: this.audioPathInArchive(
              jobId,
              job.input.audio.originalName,
              job.input.audio.size,
            ),
            audioMediaType: job.input.audio.mediaType,
            // H1 (text-to-notebook): text jobs carry the stored text source.
            textPath: this.textPathInArchive(jobId),
            textTitle: job.input.text ? (job.input.title ?? null) : null,
            notebookTitle: job.input.title ?? `nlo-${jobId.slice(0, 16)}`,
            // NLO-P2: podcast-enabled jobs report notebook operation IDs so
            // the runner can drive the audio pipeline in the same notebook.
            podcast: job.input.podcast?.enabled ?? false,
            tunnel: handle,
            egress: this.d.egress,
            signal: controller.signal,
            onProgress: (p, note) => this.d.jobs.setProgress(jobId, p, note),
          });

          // Cancel race (MUST be the first statement of the success path): the
          // user may have requested cancellation while the provider operation
          // was completing (a real worker cannot always be interrupted on the
          // service side). The state machine forbids CANCEL_REQUESTED ->
          // SUCCEEDED, and honoring the user's cancel request is the correct
          // terminal state — a late success must never silently overwrite a
          // requested cancellation. Checking before any side effects means a
          // cancelled job records no artifacts, no "ok" attempt and no
          // account success.
          if (controller.signal.aborted) {
            this.d.jobs.recordAttempt(
              jobId,
              attemptNo,
              account.id,
              nodeId,
              attemptStart,
              "cancelled",
              {
                reason: "user",
                note: "provider operation completed after the cancel request; result discarded",
              },
            );
            this.d.jobs.setStatus(jobId, "CANCELLED", {
              errorClass: "provider",
              errorMessage: "cancelled by user (provider operation completed server-side)",
            });
            this.logEvent(
              jobId,
              archive,
              "cancelled",
              "cancellation finalized; late provider result discarded",
            );
            this.finalizeArchive(jobId, archive);
            return this.d.jobs.getOrThrow(jobId);
          }

          const stored = result.artifacts.map((a, i) =>
            archive.storeArtifact(a.path, a.name, i + 1),
          );
          this.storeArtifacts(
            jobId,
            stored,
            result.artifacts,
            this.provenanceFrom(result.providerMeta.simulated),
          );

          // NLO-P2 (podcast): after the base notebook workflow succeeds,
          // generate the Audio Overview in the created notebook, poll the
          // EXTERNAL operation (resumable across restarts via the persisted
          // task id), then download, signature-validate, hash and store the
          // audio as a job artifact. A null return means this instance
          // yielded (a restart recovery re-queued the job and another
          // instance re-took it) — no further status change here.
          let podcastMeta: Record<string, unknown> | null = null;
          if (job.input.podcast?.enabled) {
            podcastMeta = await this.runPodcastPipeline({
              jobId,
              job,
              account,
              handle,
              controller,
              credentialRef,
              resultMeta: result.providerMeta,
              archive,
            });
            if (podcastMeta === null) {
              this.logEvent(
                jobId,
                archive,
                "podcast_yielded",
                "job status changed during podcast polling (restart recovery); this instance stands down",
              );
              this.finalizeArchive(jobId, archive);
              return this.d.jobs.getOrThrow(jobId);
            }
          }

          this.d.jobs.recordAttempt(jobId, attemptNo, account.id, nodeId, attemptStart, "ok", {
            provider: this.d.provider.name,
          });
          this.d.accounts.recordSuccess(account.id);
          const sim = result.providerMeta.simulated;
          // Verifiable operation IDs from the provider's own report (the
          // python worker returns the real NotebookLM notebook/source/
          // conversation IDs). Persisted to the jobs row columns so a
          // successful job is auditable at the destination service; absent
          // values stay null (never fabricated).
          const meta = result.providerMeta as Record<string, unknown>;
          const strOrNull = (v: unknown): string | null =>
            typeof v === "string" && v.length > 0 ? v : null;
          this.d.jobs.setStatus(jobId, "SUCCEEDED", {
            answerMarkdown: result.answerMarkdown,
            resultProviderMeta: podcastMeta
              ? { ...result.providerMeta, podcast: podcastMeta }
              : result.providerMeta,
            progress: 100,
            // Clear error fields carried over from a previous failed attempt
            // (setStatus preserves prior values when the patch omits them,
            // so a SUCCEEDED job must explicitly null them).
            errorClass: null,
            errorMessage: null,
            // Provenance is measured from the provider's own report, never
            // assumed: mock provider => "mock"; worker reports simulated
            // false => "real"; anything else => "unknown" (shown as such).
            resultProvenance: sim === true ? "mock" : sim === false ? "real" : "unknown",
            notebookId: strOrNull(meta.notebookId),
            notebookTitle: strOrNull(meta.notebookTitle),
            sourceId: strOrNull(meta.sourceId),
            conversationId: strOrNull(meta.conversationId),
          });
          if (result.answerMarkdown) archive.writeAnswer(result.answerMarkdown);
          this.logEvent(jobId, archive, "succeeded", "job completed");
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId);
        } catch (err) {
          const outcome = await this.handleFailure(
            jobId,
            account.id,
            attemptNo,
            nodeId,
            attemptStart,
            archive,
            err,
            controller.signal.aborted,
          );
          if (outcome === "terminal") {
            this.finalizeArchive(jobId, archive);
            return this.d.jobs.getOrThrow(jobId);
          }
          // outcome === "retry": job is in RETRY_WAIT (after backoff sleep).
          this.d.jobs.nextAttempt(jobId);
          this.d.jobs.setStatus(jobId, "WAITING_FOR_ACCOUNT");
          // The loop re-selects account + proxy and runs again.
        } finally {
          if (nodeId) await this.d.runtime.stopTunnel(nodeId).catch(() => {});
        }
      }
    } catch (err) {
      this.d.log(`runner error for ${jobId}: ${redact(String(err))}`);
      try {
        const cur = this.d.jobs.getOrThrow(jobId);
        if (!TERMINAL.includes(cur.status)) {
          this.d.jobs.setStatus(jobId, "FAILED", {
            errorClass: "unknown",
            errorMessage: redact(String(err)),
          });
        }
      } catch {
        /* already terminal */
      }
      this.finalizeArchive(jobId, archive);
      return this.d.jobs.getOrThrow(jobId);
    } finally {
      this.active.delete(jobId);
      this.emitTerminal(jobId);
    }
  }

  /**
   * NLO-P2 (webhooks): emit the terminal webhook for a job that just settled.
   * Reads the FRESH status from the DB (the last setStatus wins) so a cancel
   * that landed during a late success reports CANCELLED, not SUCCEEDED.
   * Never throws — webhook emission must not break the runner.
   */
  private emitTerminal(jobId: string): void {
    if (!this.d.webhooks) return;
    try {
      const job = this.d.jobs.get(jobId);
      if (!job) return;
      const byStatus: Record<string, string> = {
        SUCCEEDED: "job.succeeded",
        FAILED: "job.failed",
        CANCELLED: "job.cancelled",
        NEEDS_ATTENTION: "job.needs_attention",
      };
      const ev = byStatus[job.status];
      if (ev) this.d.webhooks.publish(jobId, ev);
    } catch {
      /* never break the runner over webhook emission */
    }
  }

  // ---------------------------------------------------------------------

  private validate(jobId: string, archive: JobArchive): boolean {
    const job = this.d.jobs.getOrThrow(jobId);
    // H1: a prompt is required for audio jobs; a text job with
    // summary.enabled=false legitimately has an empty prompt (notebook +
    // source are still created, no ask step is run).
    if (!job.input.text && (!job.input.prompt || !job.input.prompt.trim())) {
      this.d.jobs.setStatus(jobId, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: "prompt is empty",
      });
      this.logEvent(jobId, archive, "validation_failed", "prompt is empty");
      return false;
    }
    try {
      archive.init({
        prompt: job.input.prompt,
        originalAudioName: job.input.audio.size > 0 ? job.input.audio.originalName : null,
        audioMediaType: job.input.audio.size > 0 ? job.input.audio.mediaType : null,
        configSnapshot: job.configSnapshot,
        createdAt: job.createdAt,
        text: job.input.text
          ? {
              charCount: job.input.text.charCount,
              sizeBytes: job.input.text.sizeBytes,
              language: job.input.text.language ?? null,
            }
          : null,
      });
      return true;
    } catch (err) {
      this.d.jobs.setStatus(jobId, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: `archive init failed: ${redact(String(err))}`,
      });
      this.logEvent(
        jobId,
        archive,
        "validation_failed",
        `archive init failed: ${redact(String(err))}`,
      );
      return false;
    }
  }

  /**
   * Choose the account that will actually serve this job.
   *
   * Rules:
   *  - A requested `preferredAccountId` is HONORED STRICTLY: if it exists but
   *    is not currently eligible (e.g. its session is not verified), the job
   *    fails with a clear auth error rather than silently switching to
   *    another account — never reuse one account's session for another job.
   *  - Otherwise the default account (when eligible) is preferred, then the
   *    most-recently-successful eligible account (deterministic tie-break).
   *  - Eligibility always means enabled + not DISABLED/AUTH_REQUIRED, and —
   *    when the sessions repo is present — holding an AUTHENTICATED session
   *    verified within the TTL. A DB flag alone is never sufficient.
   */
  private selectAccount(job: Job): AccountRow {
    const eligibleIds = this.d.sessions?.eligibleAccountIds() ?? null;
    const eligible = (a: AccountRow): boolean => {
      if (!a.enabled || a.status === "DISABLED") return false;
      // With a live session registry, the verified session is the source of
      // truth: a stale AUTH_REQUIRED flag (from an old failed job) must not
      // shadow a freshly verified login.
      if (eligibleIds !== null) return eligibleIds.has(a.id);
      // No registry (mock provider): fall back to the row flag.
      if (a.status === "AUTH_REQUIRED") return false;
      return true;
    };

    if (job.input.preferredAccountId) {
      const preferred = this.d.accounts.get(job.input.preferredAccountId);
      if (preferred && eligible(preferred)) {
        return preferred;
      }
      const why = !preferred
        ? "not found"
        : !preferred.enabled || preferred.status === "DISABLED"
          ? "not enabled / disabled"
          : eligibleIds !== null
            ? "session not verified (re-authentication required)"
            : "not enabled / disabled / auth-required";
      this.d.jobs.setStatus(job.id, "FAILED", {
        errorClass: "auth",
        errorMessage: `requested account "${preferred?.label ?? job.input.preferredAccountId}" is not usable: ${why}`,
      });
      this.d.jobs.appendEvent(job.id, "no_account", `requested account not usable: ${why}`);
      throw new Error(`requested account not usable: ${why}`);
    }

    const pool = this.d.accounts.eligible().filter(eligible);
    if (pool.length === 0) {
      this.d.jobs.setStatus(job.id, "FAILED", {
        errorClass: "auth",
        errorMessage: "no eligible google account with a verified session",
      });
      this.d.jobs.appendEvent(job.id, "no_account", "no eligible account with verified session");
      throw new Error("no eligible google account with a verified session");
    }

    const sorted = [...pool].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const as = a.lastSuccessAt ?? "";
      const bs = b.lastSuccessAt ?? "";
      if (as !== bs) return as < bs ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
    const chosen = sorted[0];
    if (!chosen) throw new Error("account selection failed");
    return chosen;
  }

  /**
   * Classify a failure and drive the job to its terminal or retry state.
   * Returns "terminal" when the job reached FAILED/NEEDS_ATTENTION/CANCELLED,
   * or "retry" when it is in RETRY_WAIT (after backoff) — the run loop then
   * advances to WAITING_FOR_ACCOUNT and executes again.
   */
  private async handleFailure(
    jobId: string,
    accountId: string,
    attemptNo: number,
    nodeId: string | null,
    attemptStart: string,
    archive: JobArchive,
    err: unknown,
    wasAborted: boolean,
  ): Promise<"terminal" | "retry"> {
    const job = this.d.jobs.getOrThrow(jobId);
    let failureClass: FailureClass;
    let message: string;
    let ambiguous = false;
    let needsReauth = false;

    if (err instanceof ProviderFailure) {
      failureClass = err.info.failureClass;
      message = err.info.message;
      ambiguous = err.info.ambiguous;
      needsReauth = err.info.needsReauth;
    } else {
      failureClass = classifyError(String(err));
      message = String(err);
    }
    message = redact(message);

    try {
      if (needsReauth || failureClass === "auth") {
        this.d.accounts.recordError(accountId, message, "AUTH_REQUIRED");
      } else if (failureClass === "rate_limit") {
        this.d.accounts.recordError(accountId, message, "RATE_LIMITED");
      } else if (
        failureClass === "connectivity" ||
        failureClass === "provider" ||
        failureClass === "proxy"
      ) {
        this.d.accounts.recordError(accountId, message, "DEGRADED");
      }
    } catch {
      /* account may have been removed */
    }

    const cancelled = wasAborted || job.status === "CANCEL_REQUESTED";
    if (cancelled) {
      void this.d.provider.cancel(jobId).catch(() => {});
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "cancelled", {
        reason: "user",
      });
      // Cancellation must pass through CANCEL_REQUESTED (state machine rule).
      if (this.d.jobs.getOrThrow(jobId).status === "RUNNING") {
        this.d.jobs.setStatus(jobId, "CANCEL_REQUESTED");
      }
      this.d.jobs.setStatus(jobId, "CANCELLED", {
        errorClass: "provider",
        errorMessage: "cancelled by user",
      });
      this.logEvent(jobId, archive, "cancelled", "cancellation completed");
      return "terminal";
    }

    if (ambiguous) {
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "ambiguous", {
        failureClass,
        message,
      });
      this.d.jobs.setStatus(jobId, "NEEDS_ATTENTION", {
        errorClass: "ambiguous",
        errorMessage: message,
      });
      this.logEvent(jobId, archive, "needs_attention", `ambiguous: ${message}`);
      return "terminal";
    }

    if (!isRetryableError(failureClass) || attemptNo >= job.maxAttempts) {
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "failed", {
        failureClass,
        message,
      });
      this.d.jobs.setStatus(jobId, "FAILED", { errorClass: failureClass, errorMessage: message });
      this.logEvent(jobId, archive, "failed", `${failureClass}: ${message}`);
      return "terminal";
    }

    const delay = backoffMs(job.attempt + 1, { rng: this.d.rng });
    this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "retrying", {
      failureClass,
      message,
      nextDelayMs: delay,
    });
    this.d.jobs.setStatus(jobId, "RETRY_WAIT", { errorClass: failureClass, errorMessage: message });
    this.logEvent(
      jobId,
      archive,
      "retry_scheduled",
      `${failureClass}: retrying in ${delay}ms (attempt ${job.attempt + 1}/${job.maxAttempts})`,
    );
    await (this.d.sleep ?? sleepDefault)(delay);
    // Caller advances RETRY_WAIT -> WAITING_FOR_ACCOUNT and re-executes.
    return "retry";
  }

  /**
   * The upload route stores audio at data/jobs/<id>/input/audio-<safeName>.
   * We re-derive the same deterministic safe name here.
   */
  private audioPathInArchive(jobId: string, originalName: string, size: number): string | null {
    if (size <= 0 || !originalName) return null;
    let safe: string;
    try {
      safe = safeName(originalName);
    } catch {
      return null;
    }
    return resolveWithin(this.d.jobsDir, jobId, "input", `audio-${safe}`);
  }

  /**
   * H1: text jobs store their source at data/jobs/<id>/input/text-source.md
   * (fixed server-chosen name, written by the from-text creation route).
   */
  private textPathInArchive(jobId: string): string | null {
    const p = resolveWithin(this.d.jobsDir, jobId, "input", "text-source.md");
    return existsSync(p) ? p : null;
  }

  /**
   * NLO-P2: podcast pipeline (the audio stage of the 17-stage lifecycle).
   *
   * Stage map (persisted via progress + timeline events + operation ids):
   *   90  podcast generation submitted / resumed
   *   95  polling the external generation task
   *   98  downloading the completed artifact
   *   99  artifact signature-validated, hashed and stored
   *
   * Idempotency: the external task id is persisted to
   * jobs.operation_ids_json as soon as it is known, so a restart
   * re-submission is a RESUME (poll first, keep the prior task unless it
   * failed) and never a blind duplicate. The polling loop re-reads the
   * job status every iteration: if restart recovery moved the job out of
   * RUNNING, this instance yields (returns null) instead of settling it.
   */
  private async runPodcastPipeline(args: {
    jobId: string;
    job: Job;
    archive: JobArchive;
    account: AccountRow;
    handle: TunnelHandle;
    controller: AbortController;
    credentialRef: string;
    resultMeta: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const { jobId, job, archive, account, handle, controller, credentialRef, resultMeta } = args;
    const provider = this.d.provider;
    // Bind to the provider: these are class methods that use `this`.
    const generateAudio = provider.generateAudio?.bind(provider);
    const getAudioStatus = provider.getAudioStatus?.bind(provider);
    const downloadAudio = provider.downloadAudio?.bind(provider);
    if (!generateAudio || !getAudioStatus || !downloadAudio) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: "podcast requested but the active provider does not support audio generation",
        ambiguous: false,
        needsReauth: false,
      });
    }

    const notebookId =
      typeof resultMeta.notebookId === "string" && resultMeta.notebookId.length > 0
        ? resultMeta.notebookId
        : null;
    if (!notebookId) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message:
          "podcast requested but the base job did not report a notebook id; audio generation needs an existing notebook",
        ambiguous: false,
        needsReauth: false,
      });
    }

    const podcast = job.input.podcast;
    const setStage = (p: number, note: string): void => this.d.jobs.setProgress(jobId, p, note);

    // NLO-P2: per-stage persistence (job_stages). Each pipeline stage is
    // recorded with its attempt, deadline and external operation id. A
    // yield (restart recovery) deliberately leaves the open stage
    // in_progress: that row IS the checkpoint for the restarted process.
    const stages = this.d.stages;
    const attemptNo = job.attempt + 1;
    let openStage: string | null = null;
    const beginStage = (stage: string, deadlineMs?: number): void => {
      openStage = stage;
      stages?.begin(jobId, stage, { attempt: attemptNo, deadlineMs });
    };
    const endStage = (state: "completed" | "failed", lastError?: string): void => {
      if (!openStage) return;
      if (state === "completed") stages?.complete(jobId, openStage);
      else stages?.fail(jobId, openStage, lastError ?? "failed");
      openStage = null;
    };

    try {
      // --- stage 90: submit (or resume) the external generation -----------
      beginStage("audio_generation", this.d.podcastDeadlineMs ?? 25 * 60_000);
      const gen = await generateAudio({
        jobId,
        accountId: account.id,
        credentialRef,
        notebookId,
        sourceIds: null,
        prompt: (podcast?.instructions ?? "").trim() || (job.input.prompt ?? "").trim() || null,
        language: podcast?.language ?? job.input.language ?? null,
        audioFormat: podcast?.format ?? null,
        audioLength: podcast?.length ?? null,
        resumeTaskId: this.d.jobs.getOrThrow(jobId).operationIds?.audioTaskId ?? null,
        tunnel: handle,
        egress: this.d.egress,
        signal: controller.signal,
        onProgress: (_p, note) => setStage(90, note),
      });

      const taskId = gen.status.taskId;
      if (!taskId) {
        throw new ProviderFailure({
          failureClass: "provider",
          message:
            "audio generation did not return a task id (cannot track the external operation)",
          ambiguous: true,
          needsReauth: false,
        });
      }
      // Persist BEFORE polling: a crash any time after this line must resume,
      // not re-submit.
      this.d.jobs.patchOperationIds(jobId, { audioTaskId: taskId });
      stages?.setExternal(jobId, "audio_generation", taskId, taskId);
      this.logEvent(
        jobId,
        archive,
        gen.resumed ? "podcast_resume_kept" : "podcast_submitted",
        `${gen.resumed ? "resumed" : "submitted"} external podcast generation task ${taskId}`,
        { taskId, resumed: gen.resumed, priorStatus: gen.priorStatus },
      );

      // --- stage 95: poll the external task until terminal ------------------
      const deadline = Date.now() + (this.d.podcastDeadlineMs ?? 25 * 60_000);
      let st = gen.status;
      let polls = 0;
      for (;;) {
        if (controller.signal.aborted) {
          throw new ProviderFailure({
            failureClass: "provider",
            message: "cancelled while polling podcast generation",
            ambiguous: false,
            needsReauth: false,
          });
        }
        const cur = this.d.jobs.get(jobId);
        if (!cur || cur.status !== "RUNNING") return null; // yield (restart recovery)
        if (st.isComplete) break;
        if (st.isFailed) {
          throw new ProviderFailure({
            failureClass: "provider",
            message: `podcast generation failed: ${st.error ?? st.status ?? "unknown error"}`,
            ambiguous: false,
            needsReauth: false,
          });
        }
        polls += 1;
        if (Date.now() >= deadline) {
          throw new ProviderFailure({
            failureClass: "provider",
            message:
              "podcast generation did not complete within the polling budget; the external task may still complete server-side",
            ambiguous: true,
            needsReauth: false,
          });
        }
        await (this.d.sleep ?? sleepDefault)(
          backoffMs(polls, { baseMs: 5000, capMs: 60_000, rng: this.d.rng }),
        );
        const res = await getAudioStatus({
          jobId,
          accountId: account.id,
          credentialRef,
          notebookId,
          taskId,
          tunnel: handle,
          egress: this.d.egress,
          signal: controller.signal,
          onProgress: (_p, note) => setStage(95, note),
        });
        st = res.status;
      }
      endStage("completed");

      this.logEvent(
        jobId,
        archive,
        "podcast_completed",
        `external podcast generation task ${taskId} completed`,
        { taskId },
      );

      // --- stage 98: download into a temp name inside the job output dir --
      beginStage("artifact_download");
      const hex = randomUUID().replace(/-/g, "").slice(0, 12);
      const tmpPath = resolveWithin(this.d.jobsDir, jobId, "output", `podcast-tmp-${hex}`);
      const dl = await downloadAudio({
        jobId,
        accountId: account.id,
        credentialRef,
        notebookId,
        artifactId: taskId,
        destPath: tmpPath,
        tunnel: handle,
        egress: this.d.egress,
        signal: controller.signal,
        onProgress: (_p, note) => setStage(98, note),
      });
      if (!dl.ready || !dl.path) {
        rmSync(tmpPath, { force: true });
        throw new ProviderFailure({
          failureClass: "provider",
          message: "podcast artifact was not ready after confirmed completion",
          ambiguous: true,
          needsReauth: false,
        });
      }
      endStage("completed");

      // NLO-P2 hardening: an empty or oversized artifact is never stored.
      const downloadedSize = statSync(dl.path).size;
      if (downloadedSize === 0) {
        rmSync(tmpPath, { force: true });
        throw new ProviderFailure({
          failureClass: "invalid_input",
          message: "podcast artifact is empty (0 bytes); refusing to store",
          ambiguous: false,
          needsReauth: false,
        });
      }
      const maxPodcastBytes = this.d.maxPodcastBytes ?? 200 * 1024 * 1024;
      if (downloadedSize > maxPodcastBytes) {
        rmSync(tmpPath, { force: true });
        throw new ProviderFailure({
          failureClass: "invalid_input",
          message: `podcast artifact exceeds the size limit (${downloadedSize} > ${maxPodcastBytes} bytes)`,
          ambiguous: false,
          needsReauth: false,
        });
      }

      // --- stage 99: validate (signature), rename, hash, store -----------
      beginStage("artifact_store");
      const mime = sniffAudioMime(dl.path);
      if (!mime) {
        rmSync(tmpPath, { force: true });
        throw new ProviderFailure({
          failureClass: "invalid_input",
          message: "podcast artifact has an unrecognized audio signature",
          ambiguous: false,
          needsReauth: false,
        });
      }
      const finalName = `podcast-${hex}${audioMimeToExt(mime)}`;
      const finalPath = resolveWithin(this.d.jobsDir, jobId, "output", finalName);
      renameSync(dl.path, finalPath);
      const size = statSync(finalPath).size;
      const sha256 = sha256OfFile(finalPath);
      // NLO-P2: decode the container from the file itself (independent of
      // the sniffed signature) and persist verified metadata. A WAV that
      // does not parse is rejected, never stored as a black box.
      const wavInfo = mime === "audio/wav" ? readWavInfo(finalPath) : null;
      if (mime === "audio/wav" && !wavInfo) {
        rmSync(finalPath, { force: true });
        throw new ProviderFailure({
          failureClass: "invalid_input",
          message: "podcast WAV artifact is not parseable (missing or broken fmt/data chunk)",
          ambiguous: false,
          needsReauth: false,
        });
      }
      const artifactId = this.insertArtifactRow(
        jobId,
        finalName,
        mime,
        size,
        `output/${finalName}`,
        {
          sha256,
          provenance: this.provenanceFrom(resultMeta.simulated),
          durationSeconds: wavInfo?.durationSeconds ?? null,
          codec: wavInfo?.codec ?? null,
          sampleRate: wavInfo?.sampleRate ?? null,
          channels: wavInfo?.channels ?? null,
        },
      );
      endStage("completed");
      setStage(99, `podcast: artifact stored (${finalName})`);
      this.logEvent(
        jobId,
        archive,
        "podcast_artifact_stored",
        `podcast artifact stored as ${finalName}`,
        {
          artifactId,
          mediaType: mime,
          size,
          sha256,
        },
      );

      // NLO-P2: best-effort MP3 (56 kbps) transcode of the stored artifact.
      // The ORIGINAL artifact is always canonical: a missing ffmpeg (not
      // configured or not found on disk) and even a failed transcode are
      // non-fatal — they are recorded as a stage row + event + an honest
      // `transcode` block in the result metadata.
      const provenance = this.provenanceFrom(resultMeta.simulated);
      const sourceDuration = wavInfo?.durationSeconds ?? dl.durationSeconds ?? null;
      let transcode: Record<string, unknown>;
      const ffmpegBin = this.d.ffmpegBin;
      if (!ffmpegBin || !existsSync(ffmpegBin)) {
        const reason = ffmpegBin
          ? "ffmpeg executable not found at the configured path"
          : "ffmpeg not configured";
        this.logEvent(jobId, archive, "podcast_transcode_skipped", reason, {
          ffmpegBin: ffmpegBin ?? null,
        });
        transcode = { status: "not_configured", reason };
      } else {
        const targetKbps = this.d.mp3TargetKbps ?? 56;
        const timeoutMs = this.d.transcodeTimeoutMs ?? 5 * 60_000;
        beginStage("mp3_transcode", timeoutMs);
        const mp3Name = `podcast-${hex}.mp3`;
        const mp3Path = resolveWithin(this.d.jobsDir, jobId, "output", mp3Name);
        const res = await transcodeToMp3({
          ffmpegBin,
          inputPath: finalPath,
          outputPath: mp3Path,
          targetKbps,
          timeoutMs,
        });
        if (res.ok && res.path && res.size) {
          const mp3Sha = sha256OfFile(res.path);
          const mp3ArtifactId = this.insertArtifactRow(
            jobId,
            mp3Name,
            "audio/mpeg",
            res.size,
            `output/${mp3Name}`,
            {
              sha256: mp3Sha,
              provenance,
              durationSeconds: sourceDuration,
              codec: "mp3",
              bitrate: targetKbps,
              sourceArtifactId: artifactId,
            },
          );
          endStage("completed");
          setStage(99, `podcast: mp3 transcode stored (${mp3Name})`);
          this.logEvent(jobId, archive, "podcast_transcode_stored", mp3Name, {
            artifactId: mp3ArtifactId,
            mediaType: "audio/mpeg",
            size: res.size,
            sha256: mp3Sha,
            bitrate: targetKbps,
            sourceArtifactId: artifactId,
          });
          transcode = {
            status: "ok",
            artifactId: mp3ArtifactId,
            filename: mp3Name,
            size: res.size,
            sha256: mp3Sha,
            bitrate: targetKbps,
            sourceArtifactId: artifactId,
          };
        } else {
          rmSync(mp3Path, { force: true });
          const reason = res.reason ?? "transcode failed";
          endStage("failed", reason);
          this.logEvent(jobId, archive, "podcast_transcode_failed", reason, {
            exitCode: res.exitCode ?? null,
          });
          transcode = {
            status: "failed",
            reason,
            exitCode: res.exitCode ?? null,
          };
        }
      }

      return {
        taskId,
        resumed: gen.resumed,
        priorStatus: gen.priorStatus,
        durationSeconds: sourceDuration,
        artifactTitle: dl.artifactTitle ?? null,
        mediaType: mime,
        size,
        sha256,
        codec: wavInfo?.codec ?? null,
        sampleRate: wavInfo?.sampleRate ?? null,
        channels: wavInfo?.channels ?? null,
        provenance,
        artifactId,
        storedAs: `output/${finalName}`,
        transcode,
      };
    } catch (err) {
      endStage("failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Insert one row into the artifacts table via the ArtifactRepo
   * (server-generated id + key; metadata only when actually verified).
   */
  private insertArtifactRow(
    jobId: string,
    filename: string,
    mediaType: string,
    size: number,
    storageKey: string,
    extra: {
      sha256?: string | null;
      durationSeconds?: number | null;
      codec?: string | null;
      sampleRate?: number | null;
      channels?: number | null;
      bitrate?: number | null;
      provenance?: string | null;
      sourceArtifactId?: string | null;
    } = {},
  ): string {
    return this.d.artifacts.create({
      jobId,
      filename,
      mediaType,
      size,
      source: "provider",
      storageKey,
      sha256: extra.sha256 ?? null,
      durationSeconds: extra.durationSeconds ?? null,
      codec: extra.codec ?? null,
      sampleRate: extra.sampleRate ?? null,
      channels: extra.channels ?? null,
      bitrate: extra.bitrate ?? null,
      provenance: extra.provenance ?? null,
      sourceArtifactId: extra.sourceArtifactId ?? null,
    });
  }

  /** "mock" | "real" | "unknown" — from the provider's own `simulated`
   *  report, never assumed (null or missing => "unknown"). */
  private provenanceFrom(sim: unknown): string {
    return sim === true ? "mock" : sim === false ? "real" : "unknown";
  }

  private storeArtifacts(
    jobId: string,
    stored: { safeName: string; size: number }[],
    metas: { name: string; mediaType: string }[],
    provenance: string,
  ): void {
    for (let i = 0; i < stored.length; i++) {
      const s = stored[i];
      const m = metas[i];
      if (!s) continue;
      const file = resolveWithin(this.d.jobsDir, jobId, "output", "artifacts", s.safeName);
      let sha: string | null = null;
      try {
        sha = sha256OfFile(file);
      } catch {
        sha = null; // hashing is best-effort; the row is still recorded
      }
      this.insertArtifactRow(
        jobId,
        m?.name ?? s.safeName,
        m?.mediaType ?? "application/octet-stream",
        s.size,
        `output/artifacts/${s.safeName}`,
        { sha256: sha, provenance },
      );
    }
  }

  /** Append to both the DB event log and the archive timeline (best-effort). */
  private logEvent(
    jobId: string,
    archive: JobArchive,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.d.jobs.appendEvent(jobId, type, message, data);
    try {
      archive.appendTimelineEvent({ at: new Date().toISOString(), type, message, data });
    } catch {
      /* archive is best-effort */
    }
  }

  /** Persist attempts + errors snapshots to the archive (best-effort). */
  private finalizeArchive(jobId: string, archive: JobArchive): void {
    try {
      const attempts = this.d.jobs.attempts(jobId);
      archive.writeAttempts(attempts);
      archive.writeErrors(attempts.filter((a) => a.outcome !== "ok"));
    } catch {
      /* archive is best-effort */
    }
  }
}

/** Minimal redaction for internal logs. */
function redact(s: string): string {
  return s
    .replace(/vless:\/\/[^\s"'<>]+/gi, "vless://[REDACTED]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (m) => `${m.slice(0, 4)}…`,
    );
}
