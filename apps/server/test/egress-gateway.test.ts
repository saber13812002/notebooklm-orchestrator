/**
 * NLO-P4-1B: Egress Gateway (ADR-004) — unit tests.
 *
 * The gateway is the platform service the job engine acquires egress from:
 * `acquire(ctx, policy) → EgressEndpoint` + `release`. It wraps
 * ProxyManager.selectAuto (fail-closed, self-healing, evidence) and the
 * runtime's tunnel teardown. Providers receive an endpoint descriptor
 * (loopback port + expected egress IP + evidence ref), never a tunnel
 * object or an env-var injection (the `tunnelEnv` coupling is removed).
 *
 * These are UNIT/INTEGRATION tests (mock runtime). They do NOT prove real
 * xray tunnel behavior (that is the live gate).
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EgressAcquireError, EgressGateway, type EgressEndpoint } from "../src/proxy/gateway.js";
import { addNode, makeParts, markHealthy, markUnhealthy, type TestParts } from "./helpers.js";

let parts: TestParts | undefined;

afterEach(() => {
  const p = parts;
  parts = undefined;
  p?.dispose();
});

function gw(allowDirect = false): EgressGateway {
  return new EgressGateway({
    proxyManager: parts!.proxyManager,
    proxies: parts!.proxies,
    runtime: parts!.runtime,
    allowDirect,
  });
}

function listenerIsDown(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

describe("egress gateway: acquire (tunnel-required)", () => {
  it("returns an endpoint with a live loopback port, expected egress IP and evidence ref", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    const acq = await gw().acquire({ preferredNodeId: null }, "tunnel-required");
    expect(acq.endpoint.nodeId).toBe(node.id);
    expect(acq.endpoint.localPort).toBeTypeOf("number");
    expect(acq.endpoint.localPort).toBeGreaterThan(0);
    // The staged health that made the node eligible is surfaced (evidence).
    expect(acq.endpoint.expectedEgressIp).toBe("198.51.100.7");
    expect(acq.endpoint.evidenceRef).toMatch(/^proxy_health:.*@/);
    // The tunnel listener is actually up on loopback.
    expect(await listenerIsDown("127.0.0.1", acq.endpoint.localPort!)).toBe(false);
  });

  it("fails closed when no enabled node is configured", async () => {
    parts = makeParts();
    await expect(gw().acquire({}, "tunnel-required")).rejects.toThrow(EgressAcquireError);
    await expect(gw().acquire({}, "tunnel-required")).rejects.toThrow(/no enabled proxy node/i);
  });

  it("fails closed when all nodes are unhealthy (even after self-heal)", async () => {
    parts = makeParts();
    const n1 = addNode(parts.proxies, parts.vault, "n1");
    const n2 = addNode(parts.proxies, parts.vault, "n2", 20);
    markUnhealthy(parts.proxies, n1.id, "down");
    markUnhealthy(parts.proxies, n2.id, "down");
    parts.runtime.setScenario(n1.id, "down");
    parts.runtime.setScenario(n2.id, "down");
    await expect(gw().acquire({}, "tunnel-required")).rejects.toThrow(/fail-closed/i);
  });

  it("honors the preferred node when it is eligible", async () => {
    parts = makeParts();
    const a = addNode(parts.proxies, parts.vault, "a", 10);
    const b = addNode(parts.proxies, parts.vault, "b", 20);
    markHealthy(parts.proxies, a.id);
    markHealthy(parts.proxies, b.id);
    const acq = await gw().acquire({ preferredNodeId: b.id }, "tunnel-required");
    expect(acq.endpoint.nodeId).toBe(b.id);
  });
});

describe("egress gateway: acquire (direct-allowed, auth ops)", () => {
  it("allows direct egress ONLY when no node is configured AND allowDirect is set", async () => {
    parts = makeParts();
    const acq = await gw(true).acquire({}, "direct-allowed");
    expect(acq.endpoint).toEqual({
      nodeId: "",
      localPort: null,
      expectedEgressIp: null,
      evidenceRef: null,
    });
  });

  it("fails closed with no node when allowDirect is not set", async () => {
    parts = makeParts();
    await expect(gw(false).acquire({}, "direct-allowed")).rejects.toThrow(/fail-closed/i);
  });

  it("still fails closed when nodes exist but are all unhealthy (direct is not a fallback)", async () => {
    parts = makeParts();
    const n1 = addNode(parts.proxies, parts.vault, "n1");
    markUnhealthy(parts.proxies, n1.id, "down");
    parts.runtime.setScenario(n1.id, "down");
    await expect(gw(true).acquire({}, "direct-allowed")).rejects.toThrow(/fail-closed/i);
  });
});

describe("egress gateway: release", () => {
  it("tears down the tunnel listener", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    const acq = await gw().acquire({}, "tunnel-required");
    const port = acq.endpoint.localPort!;
    expect(await listenerIsDown("127.0.0.1", port)).toBe(false);
    await gw().release(acq.endpoint);
    expect(await listenerIsDown("127.0.0.1", port)).toBe(true);
  });

  it("is idempotent and a no-op for direct endpoints", async () => {
    parts = makeParts();
    const g = gw(true);
    const direct = await g.acquire({}, "direct-allowed");
    await g.release(direct.endpoint);
    await g.release(direct.endpoint); // idempotent: no throw
  });
});

describe("egress gateway: endpointEnv (replaces the removed tunnelEnv)", () => {
  it("builds proxy env pointing ONLY at the loopback listener", () => {
    const ep: EgressEndpoint = {
      nodeId: "n1",
      localPort: 41234,
      expectedEgressIp: "198.51.100.7",
      evidenceRef: null,
    };
    const env = EgressGateway.endpointEnv(ep);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:41234");
    expect(env.https_proxy).toBe("http://127.0.0.1:41234");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(Object.keys(env)).toHaveLength(8);
  });

  it("returns empty env for a direct endpoint or null", () => {
    expect(
      EgressGateway.endpointEnv({
        nodeId: "",
        localPort: null,
        expectedEgressIp: null,
        evidenceRef: null,
      }),
    ).toEqual({});
    expect(EgressGateway.endpointEnv(null)).toEqual({});
  });
});
