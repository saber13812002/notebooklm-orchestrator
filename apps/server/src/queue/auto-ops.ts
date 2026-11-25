import type { AppConfig } from "../config.js";
import type { AccountsRepo } from "../domain/accounts.repo.js";
import { InvalidAuthTransitionError, type AuthSessionsRepo } from "../domain/auth-sessions.repo.js";
import type { JobsRepo } from "../domain/jobs.repo.js";
import type { NotebookLMProvider } from "../providers/types.js";

/**
 * NLO-O1: the two operator-requested background loops (2026-11-25 mission):
 *
 *  1. AUTO-RETRY (every hour): re-queue terminal FAILED jobs so the
 *     submitted tasks keep being attempted — unlimited retries, paced by
 *     the hourly sweep — until they produce output (SUCCEEDED). CANCELLED
 *     and NEEDS_ATTENTION jobs are operator decisions and stay untouched.
 *     The queue's in-process single-worker + durable job locks keep the
 *     re-queued jobs safe across concurrent instances.
 *
 *  2. SESSION REFRESH (every hour): re-verify every enabled account's
 *     auth session against the real service (provider.getAccountStatus →
 *     Playwright `verify` through the egress tunnel) and record the result
 *     in auth_sessions (AUTHENTICATED + verified timestamp on success,
 *     AUTH_REQUIRED on failure). This is what keeps the runner's
 *     "verified within TTL" gate passing without a human clicking
 *     verify — the Google storage-state stays live as long as the
 *     service keeps accepting it; if it truly expires, the honest
 *     state flip is recorded and jobs fail with a clear auth error
 *     (never a silent stale-green).
 *
 * Both loops are opt-in via config (NLO_AUTO_RETRY / NLO_SESSION_REFRESH)
 * and never break the app: every iteration is fully guarded.
 */
export interface AutoOpsDeps {
  config: AppConfig;
  accounts: AccountsRepo;
  sessions: AuthSessionsRepo;
  jobs: JobsRepo;
  provider: NotebookLMProvider;
  log: (msg: string) => void;
}

export class AutoOps {
  private timers: NodeJS.Timeout[] = [];
  private retryBusy = false;
  private refreshBusy = false;
  private lastRetryAt: string | null = null;
  private lastRefreshAt: string | null = null;

  constructor(private readonly d: AutoOpsDeps) {}

  start(): void {
    const { config } = this.d;
    if (config.autoRetryEnabled) {
      const t = setInterval(
        () => void this.sweepAutoRetry(),
        config.autoRetryIntervalMs,
      );
      t.unref?.();
      this.timers.push(t);
      // First sweep shortly after boot (after restart recovery re-queued
      // in-flight jobs) so already-failed tasks don't wait a full hour.
      const first = setTimeout(() => void this.sweepAutoRetry(), 60_000);
      first.unref?.();
      this.timers.push(first);
      this.d.log(
        `auto-ops: auto-retry enabled (every ${Math.round(config.autoRetryIntervalMs / 60_000)} min, max ${config.autoRetryMaxPerSweep}/sweep)`,
      );
    }
    if (config.sessionRefreshEnabled && config.provider === "python-worker") {
      const t = setInterval(
        () => void this.refreshSessions(),
        config.sessionRefreshIntervalMs,
      );
      t.unref?.();
      this.timers.push(t);
      const first = setTimeout(() => void this.refreshSessions(), 30_000);
      first.unref?.();
      this.timers.push(first);
      this.d.log(
        `auto-ops: session refresh enabled (every ${Math.round(config.sessionRefreshIntervalMs / 60_000)} min)`,
      );
    } else if (config.sessionRefreshEnabled) {
      this.d.log(
        "auto-ops: session refresh configured but NLO_PROVIDER != python-worker — skipped (mock has no real sessions)",
      );
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) {
      clearTimeout(t as unknown as NodeJS.Timeout);
      clearInterval(t as unknown as NodeJS.Timeout);
    }
    this.timers = [];
  }

  /** Observability (for /api/health-style inspection + tests). */
  status(): { autoRetry: boolean; sessionRefresh: boolean; lastRetryAt: string | null; lastRefreshAt: string | null } {
    return {
      autoRetry: this.d.config.autoRetryEnabled,
      sessionRefresh: this.d.config.sessionRefreshEnabled,
      lastRetryAt: this.lastRetryAt,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  /** One sweep: re-queue up to N FAILED jobs (oldest first). */
  private async sweepAutoRetry(): Promise<void> {
    if (this.retryBusy) return;
    this.retryBusy = true;
    try {
      const ids = this.d.jobs.requeueFailed(this.d.config.autoRetryMaxPerSweep);
      for (const id of ids) {
        this.d.log(`auto-ops: re-queued FAILED job ${id} (unlimited retries until output)`);
      }
      if (ids.length > 0) {
        this.d.log(`auto-ops: sweep done — ${ids.length} job(s) re-queued`);
      }
      this.lastRetryAt = new Date().toISOString();
    } catch (err) {
      this.d.log(`auto-ops: sweep failed: ${redact(String(err))}`);
    } finally {
      this.retryBusy = false;
    }
  }

  /** One pass: re-verify every enabled account's session against the service. */
  private async refreshSessions(): Promise<void> {
    if (this.refreshBusy) return;
    this.refreshBusy = true;
    try {
      const accounts = this.d.accounts.list().filter((a) => a.enabled);
      for (const acct of accounts) {
        try {
          // Guarantee the session row exists (same as the verify route).
          this.d.sessions.ensure(acct.id, this.d.provider.name, acct.authProfile ?? "default");
          const status = await this.d.provider.getAccountStatus(
            acct.id,
            acct.authSecretRef ?? `session:${acct.id}`,
          );
          if (status.ok) {
            this.transitionToAuthed(acct.id, status.email);
            this.d.log(
              `auto-ops: session refresh OK — ${acct.id} verified (${status.email ?? "no email"})`,
            );
          } else {
            this.d.sessions.transition(acct.id, this.d.provider.name, "AUTH_REQUIRED", {
              lastError: status.detail ?? "session rejected by service",
            });
            this.d.log(
              `auto-ops: session refresh — ${acct.id} not usable: ${status.detail ?? "unknown"} (a live re-login is required)`,
            );
          }
        } catch (err) {
          this.d.log(`auto-ops: session refresh for ${acct.id} failed: ${redact(String(err))}`);
        }
      }
      this.lastRefreshAt = new Date().toISOString();
    } finally {
      this.refreshBusy = false;
    }
  }

  /**
   * Move the session to AUTHENTICATED (verified) regardless of its current
   * state: some states (e.g. SESSION_INVALID) cannot jump straight to
   * AUTHENTICATED per the state machine, so route through AUTH_REQUIRED
   * first when needed. AUTH_REQUIRED is reachable from every state.
   */
  private transitionToAuthed(accountId: string, email: string | null): void {
    const provider = this.d.provider.name;
    try {
      this.d.sessions.transition(accountId, provider, "AUTHENTICATED", {
        email,
        verified: true,
      });
    } catch (err) {
      if (err instanceof InvalidAuthTransitionError) {
        this.d.sessions.transition(accountId, provider, "AUTH_REQUIRED", {});
        this.d.sessions.transition(accountId, provider, "AUTHENTICATED", {
          email,
          verified: true,
        });
      } else {
        throw err;
      }
    }
  }
}

/** Cheap secret scrubber for log lines (mirrors the runner's redact usage). */
function redact(s: string): string {
  return s.replace(/(token|key|password|secret)(["'\s:=]+)[A-Za-z0-9._-]{6,}/gi, "$1$2****");
}
