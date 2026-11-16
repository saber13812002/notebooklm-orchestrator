import type { ProxiesRepo } from "../domain/proxies.repo.js";
import type { ProxyManager, SelectionInfo } from "./proxy-manager.js";
import type { ProxyRuntime } from "./runtime.js";

/**
 * Egress Gateway (ADR-004, NLO-P4-1B).
 *
 * The platform service the job engine acquires egress from:
 *   `acquire(ctx, policy) → EgressEndpoint` + `release`.
 *
 * It wraps ProxyManager.selectAuto (fail-closed, self-healing, staged
 * evidence) and the runtime's tunnel teardown. Providers receive an
 * ENDPOINT DESCRIPTOR — a loopback port + the expected egress IP + an
 * evidence reference — and never a tunnel object or an env-var injection
 * (the old `tunnelEnv` coupling is removed).
 *
 * Policies:
 *   - `tunnel-required` (jobs): any selection failure fails closed.
 *   - `direct-allowed` (auth ops): direct egress is permitted ONLY when NO
 *     proxy node is configured AND NLO_ALLOW_DIRECT_EGRESS is enabled
 *     (development only). If nodes exist but are unhealthy, it still fails
 *     closed — direct is not a fallback for a broken route.
 */

// P4-1D boundary seam (audit map §4.4): Job Orchestration may touch the
// proxy context only via `proxy/gateway.js` + `proxy/egress.js`. These
// type-only re-exports let orchestration import the ProxyManager /
// ProxyRuntime types from the seam instead of reaching into the proxy
// files directly. Zero runtime effect (type imports are erased).
export type { ProxyManager } from "./proxy-manager.js";
export type { ProxyRuntime } from "./runtime.js";

export type EgressPolicy = "tunnel-required" | "direct-allowed";

export interface EgressAcquireContext {
  /** Preferred proxy node (kill-switch / affinity data; default off). */
  preferredNodeId?: string | null;
}

/**
 * The egress endpoint handed to providers. `nodeId` is "" (and
 * `localPort` is null) for the direct route.
 */
export interface EgressEndpoint {
  nodeId: string;
  /** Loopback listener port of the proxy tunnel; null for direct. */
  localPort: number | null;
  /** Public IP the tunnel egresses from (staged health evidence). */
  expectedEgressIp: string | null;
  /** Reference to the staged health record that made the node eligible. */
  evidenceRef: string | null;
}

export interface EgressAcquisition {
  endpoint: EgressEndpoint;
  /** Why this node/route was chosen (job event evidence). */
  reason: string;
  /** Candidates rejected along the way (job event evidence). */
  rejected: { nodeId: string; reason: string }[];
}

export class EgressAcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressAcquireError";
  }
}

export interface EgressGatewayDeps {
  proxyManager: Pick<ProxyManager, "selectAuto">;
  proxies: Pick<ProxiesRepo, "health">;
  runtime: Pick<ProxyRuntime, "stopTunnel">;
  /** NLO_ALLOW_DIRECT_EGRESS (development only). Default: false. */
  allowDirect?: boolean;
  log?: (line: string) => void;
}

export class EgressGateway {
  private readonly allowDirect: boolean;
  private readonly logFn: (line: string) => void;
  /** Endpoints already released (idempotency guard). */
  private readonly released = new WeakSet<EgressEndpoint>();

  constructor(private readonly deps: EgressGatewayDeps) {
    this.allowDirect = deps.allowDirect ?? false;
    this.logFn = deps.log ?? (() => {});
  }

  /**
   * Acquire an egress endpoint. Starts the tunnel (via selectAuto).
   * Throws EgressAcquireError on failure — callers must fail the job
   * (fail-closed: there is no silent direct fallback for jobs).
   */
  async acquire(
    ctx: EgressAcquireContext = {},
    policy: EgressPolicy = "tunnel-required",
  ): Promise<EgressAcquisition> {
    const preferred = ctx.preferredNodeId ?? null;
    let sel: SelectionInfo;
    try {
      sel = await this.deps.proxyManager.selectAuto(preferred);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        policy === "direct-allowed" &&
        /no enabled proxy node configured/.test(msg) &&
        this.allowDirect
      ) {
        this.logFn(
          "egress: no proxy node configured — DIRECT route (NLO_ALLOW_DIRECT_EGRESS enabled, dev only)",
        );
        return {
          endpoint: { nodeId: "", localPort: null, expectedEgressIp: null, evidenceRef: null },
          reason: "direct egress (no node configured; NLO_ALLOW_DIRECT_EGRESS)",
          rejected: [],
        };
      }
      throw new EgressAcquireError(msg);
    }

    const health = this.deps.proxies.health(sel.node.id);
    const endpoint: EgressEndpoint = {
      nodeId: sel.node.id,
      localPort: sel.handle.port,
      expectedEgressIp: health?.egressIp ?? null,
      evidenceRef: health?.lastCheckedAt
        ? `proxy_health:${sel.node.id}@${health.lastCheckedAt}`
        : null,
    };
    return { endpoint, reason: sel.reason, rejected: sel.rejected };
  }

  /**
   * Release the endpoint (tear down the tunnel). Idempotent. Direct
   * endpoints (no nodeId) are a no-op.
   */
  async release(endpoint: EgressEndpoint): Promise<void> {
    if (this.released.has(endpoint)) return;
    this.released.add(endpoint);
    if (!endpoint.nodeId) return;
    await this.deps.runtime.stopTunnel(endpoint.nodeId).catch(() => {});
  }

  /**
   * Build the proxy env for a provider worker (replaces the removed
   * `tunnelEnv`). Points ONLY at the loopback tunnel listener. Both
   * runtimes bind 127.0.0.1 (runtime contract), so the host is fixed.
   * Returns {} for direct endpoints or null.
   */
  static endpointEnv(endpoint: EgressEndpoint | null): Record<string, string> {
    if (!endpoint || endpoint.localPort === null) return {};
    const proxy = `http://127.0.0.1:${endpoint.localPort}`;
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

  /**
   * Browser proxy descriptor (Playwright-style) for the login flow.
   * null for direct endpoints.
   */
  static browserProxy(endpoint: EgressEndpoint | null): { server: string } | null {
    if (!endpoint || endpoint.localPort === null) return null;
    return { server: `http://127.0.0.1:${endpoint.localPort}` };
  }
}
