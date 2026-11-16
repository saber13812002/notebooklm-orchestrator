/**
 * Fail-closed egress transport for provider traffic.
 *
 * This is the SECURITY BOUNDARY: the provider worker may only send traffic
 * through an egress ENDPOINT acquired from the Egress Gateway (a loopback
 * port + node identity + evidence). There is no `direct` mode for jobs. If
 * the endpoint is absent or broken, the transport REJECTS the request
 * (throw) — it never silently connects to the upstream host.
 *
 * The mock transport below implements the same contract and records every
 * attempt so tests can assert that no direct dial ever happened.
 */

import type { EgressEndpoint } from "./gateway.js";
import type { TunnelHandle } from "./runtime.js";

export class DirectEgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectEgressBlockedError";
  }
}

export interface EgressAttempt {
  viaTunnel: boolean;
  tunnelNodeId: string | null;
  target: string;
  ok: boolean;
  error?: string;
}

export interface ProviderEgress {
  /**
   * Perform a request on behalf of the provider.
   * @param endpoint - the ONLY permitted route (gateway-acquired). `null` is
   *   treated as a failure (fail-closed). A direct endpoint (localPort null)
   *   is only ever produced by the gateway when NLO_ALLOW_DIRECT_EGRESS is
   *   enabled (development only).
   * @param target - upstream host:port (must be a configured destination).
   * @param body - request payload (opaque to this layer).
   */
  request(
    endpoint: EgressEndpoint | null,
    target: string,
    body: { method: string; path: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; latencyMs: number }>;

  /** Test observability: every attempt recorded. */
  attempts: EgressAttempt[];
}

/**
 * Mock egress for the mock runtime. Behavior:
 *  - endpoint present + localPort (tunnel) + "up"   -> succeeds (200), via tunnel
 *  - endpoint present + localPort (tunnel) + crash/down -> fails with connectivity error
 *  - endpoint present + localPort (tunnel) + dns_fail/timeout -> fails accordingly
 *  - endpoint present + localPort null (direct)     -> dials directly (dev only)
 *  - endpoint ABSENT                                -> ALWAYS fails (fail-closed)
 * The mock also accepts an injectable `dial` so tests can simulate an
 * arbitrary upstream.
 */
export class MockProviderEgress implements ProviderEgress {
  attempts: EgressAttempt[] = [];
  private scenarioFor: (nodeId: string) => string;

  constructor(
    private readonly dial: (
      via: TunnelHandle | null,
      target: string,
      body: { method: string; path: string; headers: Record<string, string>; body?: string },
    ) => Promise<{ status: number; body: string }>,
    scenarioFor: (nodeId: string) => string,
  ) {
    this.scenarioFor = scenarioFor;
  }

  async request(
    endpoint: EgressEndpoint | null,
    target: string,
    body: { method: string; path: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; latencyMs: number }> {
    if (!endpoint) {
      this.attempts.push({
        viaTunnel: false,
        tunnelNodeId: null,
        target,
        ok: false,
        error: "no tunnel (fail-closed)",
      });
      throw new DirectEgressBlockedError(
        "provider egress requires an approved tunnel; no tunnel available (fail-closed, refusing direct connection)",
      );
    }

    // Direct route (localPort null): only produced by the gateway when
    // NLO_ALLOW_DIRECT_EGRESS is enabled (development only).
    if (endpoint.localPort === null) {
      const started = Date.now();
      const res = await this.dial(null, target, body);
      this.attempts.push({ viaTunnel: false, tunnelNodeId: null, target, ok: true });
      return { ...res, latencyMs: Date.now() - started };
    }

    const tunnel: TunnelHandle = {
      nodeId: endpoint.nodeId,
      host: "127.0.0.1",
      port: endpoint.localPort,
    };
    const scenario = this.scenarioFor(tunnel.nodeId);
    const started = Date.now();
    try {
      if (scenario === "down" || scenario === "crash") {
        const err = `tunnel ${scenario} (node ${tunnel.nodeId})`;
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: err,
        });
        throw new Error(err);
      }
      if (scenario === "dns_fail") {
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: "dns failure via tunnel",
        });
        throw new Error("dns failure via tunnel");
      }
      if (scenario === "timeout") {
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: "upstream timeout via tunnel",
        });
        throw new Error("upstream timeout via tunnel");
      }
      const res = await this.dial(tunnel, target, body);
      this.attempts.push({ viaTunnel: true, tunnelNodeId: tunnel.nodeId, target, ok: true });
      return { ...res, latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof DirectEgressBlockedError) throw err;
      throw err;
    }
  }
}

/**
 * The real egress implementation (for the python worker) must enforce the
 * same contract: configure the child process env with proxy vars pointing at
 * the local tunnel listener ONLY (EgressGateway.endpointEnv), and fail the
 * job if the endpoint has no tunnel. That executor is implemented in the
 * provider layer.
 */
