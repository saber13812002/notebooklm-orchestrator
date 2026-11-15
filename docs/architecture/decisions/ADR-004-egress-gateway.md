# ADR-004: Egress Gateway (egress as a platform service, fail-closed preserved)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
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
