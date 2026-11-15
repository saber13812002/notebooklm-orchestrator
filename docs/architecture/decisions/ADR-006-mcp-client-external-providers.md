# ADR-006: NLO as an MCP Client (external MCP servers admitted as providers)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_MCP_INTEGRATION_ARCHITECTURE.md`](../NLO_MCP_INTEGRATION_ARCHITECTURE.md) §3, [`NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../NLO_PROVIDER_CAPABILITY_CONTRACTS.md) §6
(Pair with ADR-005 — NLO as an MCP *server*.)

## Context

The mission requires NLO to **consume other MCPs** — i.e., a third-party MCP server (e.g. one of the ecosystem's NotebookLM MCP servers, or a future image/video generation MCP) should be able to become a *content engine* inside NLO without rewriting the job engine, account, or egress layers.

The design question: where does an external MCP server plug in? The options were (a) a special-cased "MCP provider" path, (b) a new provider *kind* inside the existing Provider Registry (ADR-001) with an `mcp-client` adapter, or (c) a separate integration framework.

## Decision

1. **An external MCP server is a Provider Registry entry of kind `mcp_client`** — not a special case. It gets a `ProviderDescriptor` (ADR-001) with `transport` (`stdio: { command, args, envSecretRefs }` or `http: { url, headers }`), declared `capabilities`, an `egressPolicy`, and `maxConcurrent`.
2. **The `mcp-client` adapter implements the `ContentProvider` interface** by *mapping* NLO operations to the external server's tools via a **static mapping file** (data): NLO op → external tool + parameter mapping + output parsing. The external tool's job/operation id is recorded in `job_stages.external_operation_id`, so the UNKNOWN_EXTERNAL_STATE rule (ADR-007) applies unchanged.
3. **Capability honesty by mapping, not by faith:** an external server *declaring* a tool is not a capability. An op with no mapping is `unavailable`. The conformance suites C1–C7 (capability contracts §4) must pass against the *adapter*, including one live run (C7), **before the provider is admitted**.
4. **Lifecycle ownership via the existing WorkerSupervisor pattern:** a stdio MCP child is a worker-like process — arg-array spawn, JSON-line stdio, settle-once, SIGTERM→SIGKILL 4 s, boot-time reaping. No orphan processes on restart. Secrets arrive via vault refs (`envSecretRefs`), never inline.
5. **Egress policy honored:** an MCP child that needs the internet runs behind the same fail-closed egress decision as everything else (local-only tools may declare `direct-allowed` — declared, never assumed).
6. **Provenance discipline:** artifacts from an external provider are `resultProvenance: "real"` only if the adapter verified them (size/hash per the existing artifact-validate discipline); otherwise `"unknown"` — generalizing the ecosystem's `_provenance`-envelope precedent (PleasePrompto) into NLO's own artifact record.

## Rationale
- **One registry, N transports:** the Provider Registry (ADR-001) already abstracts "a content engine behind a capability contract." An MCP server is just another engine whose *transport* happens to be MCP. Special-casing it would fork the job engine's provider path — the exact coupling ADR-001 exists to remove.
- **Static mapping over dynamic discovery:** NLO is a production service, not an agent playground. A changed external server is a **re-admission event** (re-run conformance), not a runtime surprise. This keeps the no-blind-assumption invariant intact.
- **Reuse the worker machinery:** NLO already supervises a stateful child process (the python worker) with exactly the lifecycle semantics an MCP stdio child needs. Building a second supervisor would be duplication.

## Consequences
**Positive:** any external MCP content engine is adoptable with a mapping file + conformance pass; no job-engine changes; failover/retry semantics apply uniformly (ADR-007); provenance stays honest.
**Negative / risks:** the mapping file is a *new* maintenance artifact per provider (mitigated: it is versioned data, and out-of-range `serverVersionRange` ⇒ provider flagged `degraded`, not silently broken); stdio children inherit the environment-isolation questions (PATH, vault-injected secrets only — spec'd in P4-7); MCP *server→client* push (server notifications) is not consumed in P4 (polling only).

## Alternatives considered
- **A special-cased "MCP provider" code path outside the registry:** rejected — forks the provider path, loses capability gating + conformance + failover uniformity.
- **Dynamic tool discovery at job time (auto-map `tools/list`):** rejected — a runtime surprise class; re-admission on change is the honest model for a production service.
- **A separate integration framework/daemon:** rejected — overkill; the registry + one adapter is the minimum surface.

## Evidence
- Provider Registry + `ContentProvider` + conformance: [`NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../NLO_PROVIDER_CAPABILITY_CONTRACTS.md) §2, §3, §4.
- WorkerSupervisor lifecycle to reuse: [`apps/server/src/providers/python-worker/`](../../../apps/server/src/providers/python-worker/); `test/worker-supervisor.test.ts`.
- External op id → recovery: `job_stages.external_operation_id` in [`apps/server/src/domain/stages.repo.ts`](../../../apps/server/src/domain/stages.repo.ts); ADR-007.
- Artifact verification: [`apps/server/src/domain/artifact-validate.ts`](../../../apps/server/src/domain/artifact-validate.ts).
- Ecosystem MCP server landscape (what NLO would consume): [`NLO_NOTEBOOKLM_MCP_COMPARISON.md`](../../research/NLO_NOTEBOOKLM_MCP_COMPARISON.md) §6.
