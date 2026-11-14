import { createHmac } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  assertAllowedDestination,
  redactSecrets,
  SsrfBlockedError,
  type AllowEntry,
} from "@nlo/shared";
import type { ArtifactRepo } from "../domain/artifacts.repo.js";
import type { JobsRepo } from "../domain/jobs.repo.js";
import {
  type WebhookDeliveryRow,
  WebhookDeliveriesRepo,
  WebhookEndpointsRepo,
} from "../domain/webhooks.repo.js";
import type { SecretVault } from "../secrets/vault.js";

/**
 * NLO-P2 (webhooks): outbox-style delivery dispatcher.
 *
 * Design (see docs/architecture/WEBHOOK_ARCHITECTURE.md):
 *  - publish(jobId, event) snapshots a payload from REAL DB rows and writes
 *    one pending delivery per matching endpoint. It NEVER throws.
 *  - tick(nowMs) drains due rows. Settlement is exactly-once: every state
 *    flip is guarded by `WHERE status = 'pending'`.
 *  - Fail-closed SSRF: every destination must match the allowlist and
 *    resolve to a public address (loopback only with explicit opt-in).
 *    SSRF failures dead-letter immediately — we never re-send a URL that
 *    the operator did not allow.
 *  - 2xx -> delivered; 408/429/5xx/network -> exponential backoff
 *    (base 2s, x2, cap 5 min); other 4xx -> dead (client rejected);
 *    attempts exhausted -> dead (dead letter).
 *  - Signing: `x-nlo-signature: t=<unix>,v1=hex(hmac-sha256(secret,
 *    t + "." + rawBody))`; plus `x-nlo-event`, `x-nlo-delivery-id` and
 *    `x-nlo-timestamp` headers. The rawBody is the stored payload_json, so
 *    retries re-send byte-identical bodies (the HMAC stays verifiable).
 */

/** Loopback hosts made eligible by the allow-loopback opt-in. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

export interface WebhookDispatcherOptions {
  endpoints: WebhookEndpointsRepo;
  deliveries: WebhookDeliveriesRepo;
  jobs: JobsRepo;
  artifacts: ArtifactRepo;
  vault: SecretVault;
  /** Explicit allowlist entries (host[:port], optional allowPrivate). */
  allowlist: AllowEntry[];
  /** Allow loopback delivery targets (local test receivers / dev). */
  allowLoopback: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests (deterministic, no real network). */
  fetchImpl?: typeof fetch;
  resolveIps?: (host: string) => Promise<string[]>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class WebhookDispatcher {
  private readonly endpoints: WebhookEndpointsRepo;
  private readonly deliveries: WebhookDeliveriesRepo;
  private readonly jobs: JobsRepo;
  private readonly artifacts: ArtifactRepo;
  private readonly vault: SecretVault;
  private readonly allowlist: AllowEntry[];
  private readonly allowLoopback: boolean;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveIps: (host: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: WebhookDispatcherOptions) {
    this.endpoints = opts.endpoints;
    this.deliveries = opts.deliveries;
    this.jobs = opts.jobs;
    this.artifacts = opts.artifacts;
    this.vault = opts.vault;
    this.allowlist = opts.allowlist;
    this.allowLoopback = opts.allowLoopback;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseDelayMs = opts.baseDelayMs ?? 2_000;
    this.maxDelayMs = opts.maxDelayMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.resolveIps = opts.resolveIps ?? this.defaultResolveIps.bind(this);
    this.log = opts.log ?? (() => {});
  }

  /**
   * Publish a job event to all matching enabled endpoints (outbox write).
   * Returns the number of deliveries enqueued. Never throws.
   */
  publish(jobId: string, eventType: string): number {
    try {
      const job = this.jobs.get(jobId);
      if (!job) return 0;
      const payload = {
        event: eventType,
        jobId: job.id,
        status: job.status,
        errorClass: job.errorClass,
        errorMessage: job.errorMessage ? redactSecrets(job.errorMessage) : null,
        notebookId: job.notebookId ?? null,
        sourceId: job.sourceId ?? null,
        resultProvenance: job.resultProvenance ?? null,
        artifacts: this.artifacts
          .listByJob(job.id)
          .map((a) => ({ id: a.id, filename: a.filename, mediaType: a.mediaType, size: a.size })),
        occurredAt: new Date(this.now()).toISOString(),
      };
      let n = 0;
      for (const ep of this.endpoints.list()) {
        if (!ep.enabled) continue;
        if (ep.events.length > 0 && !ep.events.includes(eventType)) continue;
        this.deliveries.enqueue({ endpointId: ep.id, jobId: job.id, eventType, payload });
        n++;
      }
      return n;
    } catch (err) {
      this.log(`publish(${jobId}, ${eventType}) failed: ${redactSecrets(String(err))}`);
      return 0;
    }
  }

  /**
   * Drain due deliveries once (tests drive this directly; production uses
   * start()). Returns the number of rows examined. Never throws.
   */
  async tick(nowMs: number = this.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = this.deliveries.due(new Date(nowMs).toISOString(), 20);
      for (const d of due) {
        try {
          await this.deliverOne(d);
        } catch (err) {
          this.log(`delivery ${d.id} crashed (retried later): ${redactSecrets(String(err))}`);
        }
      }
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  /** Begin periodic draining. Idempotent; the timer is unref'd. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.log(`tick error: ${redactSecrets(String(err))}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async defaultResolveIps(host: string): Promise<string[]> {
    try {
      const v4 = await dns.resolve4(host);
      if (v4.length > 0) return v4;
      return await dns.resolve6(host);
    } catch {
      return [];
    }
  }

  private effectiveAllowlist(): AllowEntry[] {
    const list = this.allowlist.map((e) => ({ ...e }));
    if (this.allowLoopback) {
      for (const host of LOOPBACK_HOSTS) {
        if (!list.some((e) => e.host.toLowerCase() === host.toLowerCase())) {
          list.push({ host, allowPrivate: true });
        }
      }
    }
    return list;
  }

  private delayFor(attempts: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(attempts - 1, 0), this.maxDelayMs);
  }

  private async deliverOne(d: WebhookDeliveryRow): Promise<void> {
    const ep = this.endpoints.get(d.endpointId);
    if (!ep) {
      this.deliveries.markDead(d.id, "endpoint removed before delivery");
      return;
    }
    if (!ep.enabled) {
      this.deliveries.markDead(d.id, "endpoint disabled before delivery");
      return;
    }

    let url: URL;
    try {
      url = new URL(ep.url);
    } catch {
      this.deliveries.markDead(d.id, "endpoint url is not a valid URL");
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      this.deliveries.markDead(d.id, `unsupported url scheme: ${url.protocol}`);
      return;
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

    // Fail-closed SSRF gate (allowlist + resolved-IP class check).
    const ips = host.includes(".") || host.includes(":") ? [host] : await this.resolveIps(host);
    if (ips.length === 0) {
      this.deliveries.markDead(d.id, `dns resolution failed for ${host}`);
      return;
    }
    try {
      assertAllowedDestination({ host, ips, port }, this.effectiveAllowlist());
    } catch (err) {
      const reason = err instanceof SsrfBlockedError ? err.reason : "blocked";
      this.deliveries.markDead(d.id, `ssrf_blocked:${reason}`);
      return;
    }

    const secret = ep.secretRef
      ? (() => {
          try {
            return this.vault.get(ep.secretRef);
          } catch {
            return null;
          }
        })()
      : null;
    if (ep.secretRef && secret === null) {
      this.deliveries.markDead(d.id, "signing secret missing or unreadable");
      return;
    }

    const rawBody = d.payloadJson;
    const t = Math.floor(this.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-nlo-event": d.eventType,
      "x-nlo-delivery-id": d.id,
      "x-nlo-timestamp": String(t),
    };
    if (secret !== null) {
      const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
      headers["x-nlo-signature"] = `t=${t},v1=${v1}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number | null = null;
    let networkError: string | null = null;
    try {
      const res = await this.fetchImpl(ep.url, {
        method: "POST",
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      status = res.status;
      if (res.ok) {
        this.deliveries.markDelivered(d.id, res.status);
        return;
      }
      // Drain/cancel the body so the socket can be released.
      void res.body?.cancel().catch(() => {});
    } catch (err) {
      networkError = redactSecrets(String(err));
    } finally {
      clearTimeout(timer);
    }

    // 4xx (except 408/429) is a client rejection: retrying will not help.
    const permanent =
      !networkError &&
      status !== null &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 429;
    const lastError =
      networkError ??
      (permanent ? `http ${status} (client rejected)` : `http ${status ?? "?"} (retryable)`);
    const attempts = d.attempts + 1;
    if (permanent || attempts >= this.maxAttempts) {
      this.deliveries.markDead(d.id, lastError, status);
      this.log(`delivery ${d.id} dead: ${lastError}`);
      return;
    }
    this.deliveries.markFailed(d.id, {
      attempts,
      lastStatus: status,
      lastError,
      nextAttemptAt: new Date(this.now() + this.delayFor(attempts)).toISOString(),
    });
  }
}
