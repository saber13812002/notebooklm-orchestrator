# ADR-004: Egress Gateway (egress as a platform service, fail-closed preserved)

**Status:** `IMPLEMENTED` (core, NLO-P4-1B, 2026-11-16) — proposed NLO-P4-0 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`](../NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md) §4, research [`NLO_PROXY_EGRESS_RESEARCH.md`](../../research/NLO_PROXY_EGRESS_RESEARCH.md)

## Context

The proxy subsystem is NLO's strongest differentiator: a fail-closed node registry, xray per-tunnel runtime, staged A–E health (a Google 403 bot-check *is* a working route), 10-min health TTL, SSRF `assertSafe` pre-dial, curl-primary transport, and per-job-attributed tunnels. The audit found exactly **one structural coupling**: egress is **injected into the python worker as env** (`tunnelEnv`) — the egress decision is buried *inside* provider invocation, and switching nodes requires a worker-level restart. This blocks the mission's mid-job node failover (ADR-007) and multi-provider egress policies.

The ecosystem survey confirms **no other project has any proxy support** — this subsystem must be preserved, not re-derived.

## Decision

1. **Egress becomes a platform service — the Egress Gateway** — inside the Egress & Proxy context: `acquire(jobCtx, policy) → EgressEndpoint { localPort, expectedEgressIp, nodeId, evidenceRef }`, plus `release` and `health`. The Job Engine acquires at admission (`WAITING_FOR_PROXY` → ready); the provider adapter receives an **endpoint descriptor** (loopback port + expected egress IP), never a tunnel object. **The `tunnelEnv` coupling is removed** (coupling point #1 of the audit).
2. **Per-provider egress policy** (data on the `ProviderDescriptor`, ADR-001): `must-tunnel` (default for NotebookLM) / `tunnel-preferred` / `direct-allowed`. **Fail-closed semantics are preserved verbatim**: no `direct` mode unless there are *no* nodes *and* `NLO_ALLOW_DIRECT_EGRESS` is explicitly set; the staged health, 10-min TTL, SSRF pre-dial, and curl-primary transport all stay.
3. **Node selection policy (5 steps, deterministic, logged):** explicit `preferredNodeId` → account↔node **affinity** → health (fresh, non-degraded) → priority → rotation with a **per-node concurrency cap** (`proxy_nodes.max_concurrent_tunnels`, default 1 — one xray process per tunnel is the current reality; the gateway queues acquisitions).
4. **Account↔node affinity** is a *data* association (a kill-switch, default off): used to keep a stable egress IP per account (hypothesis: Google may be sensitive to egress-IP churn — `NOT_TESTED`, must be proven live before it is relied on). It is a routing hint, never a correctness requirement.
5. **Mid-job node switch** is now expressible: on a `proxy`/`connectivity` failure, the engine may re-acquire a *different* node — **only while the in-flight op has no recorded external id**; once an external id exists, ADR-007's UNKNOWN_EXTERNAL_STATE rule governs (poll, never blind-resubmit).

## Rationale
- **Preserve the differentiator, fix the seam:** every fail-closed behavior is kept; only the *handoff* changes (tunnel object in env → endpoint descriptor in the Ctx). This is the minimum change that unblocks node failover and per-provider policies.
- **Gateway = acquire/release with evidence:** every acquisition returns an `evidenceRef` (the staged-health evidence that made the node eligible), so "which IP served this job, and why was that node chosen" is always auditable — the property the research doc identifies as NLO's unique posture in the ecosystem.
- **Affinity as a kill-switch:** because IP-churn sensitivity is a hypothesis, affinity is opt-in data, not a semantic — it can be turned off per account without a deploy.

## Consequences
**Positive:** mid-job node failover becomes possible; per-provider egress policy is expressible; the worker decouples from the tunnel lifecycle; node choice is auditable.
**Negative / risks:** the gateway adds an acquisition step to admission (bounded — it is the existing health check, now structured); the per-node concurrency cap means many simultaneous jobs queue (honest: today NLO runs one tunnel at a time anyway); affinity correctness is `NOT_TESTED` (live gate required before relying on it).

## Alternatives considered
- **Keep `tunnelEnv` injection, add a "restart worker on node switch" flag:** rejected — mid-job failover with an external id would still require resubmit-on-restart, breaking the no-blind-resubmit invariant.
- **Move egress into the worker (worker picks the node):** rejected — inverts control; the engine must own admission + failover decisions, and the worker is an implementation detail of one provider.
- **A separate egress sidecar process:** rejected (ADR-001) — overkill; the gateway is in-process and the process-boundary split is a later option if needed.

## Evidence
- Fail-closed + staged health + curl-primary: [`apps/server/src/proxy/`](../../../apps/server/src/proxy/); `test/fail-closed.test.ts`; MockProxyRuntime's 6 scenarios in `test/`.
- Coupling point (tunnelEnv): [`NLO_P4_TARGET_ARCHITECTURE.md`](../NLO_P4_TARGET_ARCHITECTURE.md) §2.
- Ecosystem "no proxy anywhere": [`NLO_PROXY_EGRESS_RESEARCH.md`](../../research/NLO_PROXY_EGRESS_RESEARCH.md) §3.
- SSRF guard: [`packages/shared/src/ssrf.ts`](../../../packages/shared/src/ssrf.ts) + `test/ssrf.test.ts`.

## Implementation (NLO-P4-1B, 2026-11-16 — implemented + unit/integration tested)

Shipped in this commit (core of the decision):

- **`apps/server/src/proxy/gateway.ts`** — `EgressGateway` with `acquire(ctx, policy)` / `release(endpoint)`.
  - `acquire` returns `EgressAcquisition { endpoint, reason, rejected }`; `EgressEndpoint { nodeId, localPort, expectedEgressIp, evidenceRef }` is the **provider-facing descriptor** — providers never see a `TunnelHandle` again.
  - Policies: `tunnel-required` (any `selectAuto` failure ⇒ `EgressAcquireError`, original message preserved) and `direct-allowed` (direct only on `no enabled proxy node configured` AND `allowDirect` — the fail-closed `NLO_ALLOW_DIRECT_EGRESS` semantics, verbatim).
  - `evidenceRef` = `proxy_health:<nodeId>@<lastCheckedAt>` from the `ProxiesRepo.health` row; `expectedEgressIp` from the same row.
  - `release` is idempotent (`WeakSet`) and delegates to `runtime.stopTunnel(nodeId)`.
  - Static `endpointEnv(endpoint)` (the 8 proxy env vars, `127.0.0.1` host) and `browserProxy(endpoint)` are the ONLY places the worker gets egress configuration.
- **`tunnelEnv` coupling removed:** `PythonWorkerProvider` now takes `egressGateway?: EgressGateway`; auth ops acquire with `direct-allowed` (and do **not** release — the tunnel outlives the request, matching the previous per-session lifecycle); `runJob`/`prepareAudio` use the runner-supplied endpoint.
- **Provider request types:** all four request types in [`providers/types.ts`](../../../apps/server/src/providers/types.ts) carry `endpoint: EgressEndpoint | null` + `egress: ProviderEgress`; `null` ⇒ fail-closed `DirectEgressBlockedError` in the provider egress adapter.
- **Job runner:** acquires once per job at start (before RUNNING), logs `proxy_selected` with the `acq.reason`, releases in `finally`. Fail-closed message preserved: `no approved proxy route available (fail-closed): …`.
- **Wiring:** `AppContext.gateway` (single instance) feeds both the python worker and the job runner; `test/helpers.ts` builds one over the mock runtime (`allowDirect: false`).

Tests (mock level — **Live NOT verified**):

- `test/egress-gateway.test.ts` — 11 tests: acquire under both policies, health evidence mapping, release idempotency + no-op for direct endpoints, `endpointEnv` shape.
- `test/fail-closed.test.ts` — new `describe("egress gateway (P4-1B)")`: gateway-level fail-closed with no nodes, runner job FAILED without a node (0 egress attempts), healthy-node acquisition + SUCCEEDED job with all attempts `viaTunnel`, unhealthy-node rejection, release closes the loopback listener (verified by connect → `ECONNREFUSED`).
- Full server suite: 26 files / 312 tests green; shared suite: 128 green. Typecheck + lint clean.

Still **planned** (not implemented, honest status):

- Account↔node **affinity** (decision 4) — not implemented; the affinity data model does not exist yet.
- **Per-node concurrency cap / acquisition queue** (decision 3, `max_concurrent_tunnels`) — not implemented; selection is the existing `selectAuto` (health-first).
- **Mid-job re-acquisition on proxy failure** (decision 5) — not implemented; a proxy failure still fails the job attempt (retry policy may re-run on another node, which *does* re-acquire).
- Provider-side egress policy **data on `ProviderDescriptor`** — the policy is currently chosen by the caller (`tunnel-required` for jobs, `direct-allowed` for auth); the per-descriptor field lands with the conformance suite (P4-1D, C6).
