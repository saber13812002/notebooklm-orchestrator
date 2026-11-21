# ADR-001: Modular Monolith with a Capability-Contract Provider Registry

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_P4_TARGET_ARCHITECTURE.md`](../NLO_P4_TARGET_ARCHITECTURE.md), [`NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../NLO_PROVIDER_CAPABILITY_CONTRACTS.md)

This is the **top-level structural decision** for NLO-P4. It establishes the modular monolith, the bounded contexts, the shared kernel, and the **Provider Registry** as the core mechanism by which the monolith supports multiple content engines. The registry detail (capability contracts, `ContentProvider` interface, conformance suites) is specified in [`NLO_PROVIDER_CAPABILITY_CONTRACTS.md`](../NLO_PROVIDER_CAPABILITY_CONTRACTS.md); this ADR records _why_ the registry is the mechanism and _how_ the monolith is structured around it.

---

## Context

NLO today is a **single-content-engine** application: one provider (NotebookLM, reached through the Python worker `nbl_worker.py`), one transport family, one account model. The mission (NLO-P4) is to support **multiple content engines, multiple connection methods, multiple Google accounts, multiple proxies, multiple MCPs, and multiple image/video generation services — with failover**.

The structural question: how do we add that multiplicity **without rewriting the working operational system** (AGENTS.md §1)? Source audit established that NLO's strongest, live-verified assets are _in-process_: the 12-state job state machine with `canTransition` enforcement, the resume-never-resubmit podcast pipeline (`patchOperationIds` + `job_stages.external_operation_id`), and the fail-closed proxy subsystem. These are the things we must not break.

## Decision

1. **Keep a modular monolith — not microservices.** One deployable (systemd service `nlo`), in-process contexts, git-based `deploy/deploy.sh`. The queue keeps an interface so a process-boundary split is a _later, low-risk_ move, not a P4 requirement.
2. **Introduce 8 bounded contexts** with enforced module boundaries and a **shared kernel** (`packages/shared`). Contexts communicate through interfaces/events, **not** by reaching into another context's repositories.
3. **The Provider Registry is the core mechanism** for multi-engine support. Every content engine (NotebookLM, a future MCP server, an image/video generator) is an **adapter** behind a **capability contract** + **conformance tests**. The cardinal rule: **a capability a provider does not declare is `unavailable` — never guessed, never inflated.**
4. **"P4 is boundary-hardening, not a rewrite."** No existing status, transition, or recovery semantics change. New capability is added _behind_ the new boundaries.

### Bounded contexts (8)

| #   | Context                 | Owns                                                                            | Status at baseline                         |
| --- | ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | **Job Orchestration**   | state machine, queue, stages, attempts, events, idempotency                     | `IMPLEMENTED`                              |
| 2   | **Provider Management** | capability contracts, adapters, conformance                                     | `PARTIAL` (one adapter) → Registry in P4-1 |
| 3   | **Account & Session**   | Google accounts, credential kinds, verification TTL, reauth, keepalive          | `IMPLEMENTED`                              |
| 4   | **Egress & Proxy**      | node registry, runtime, staged health, fail-closed transport                    | `IMPLEMENTED`                              |
| 5   | **Content Intake**      | upload, validation, format matrix, extraction, untrusted-content rule, metadata | `IMPLEMENTED`                              |
| 6   | **Artifact Delivery**   | archive, storage meta, download, transcode, provenance                          | `IMPLEMENTED`                              |
| 7   | **Notification**        | webhooks (outbox, exactly-once, HMAC)                                           | `IMPLEMENTED`                              |
| 8   | **Platform AuthN/Z**    | API tokens, scopes, audit, session admin                                        | `IMPLEMENTED`                              |

_Folded (not separate contexts):_ **Template Management** → sub-context of Content Intake (templates are intake+prompt presets, see ADR-002); **Retry & Failover** → cross-cutting policy of Job Orchestration + Provider Mgmt (ADR-007).
_Deferred:_ **Billing/Usage** and **Observability** — out of P4 scope.

### Shared kernel (`packages/shared`)

Transport-neutral types and pure logic consumed by server, web, and tests: `job-state`, `retry`, `types` (`CapabilityLevel`, `ProviderCapability`, `FailureClass`), `input-capabilities`, `redaction`, `ssrf`, `safe-name`, `e2e-contract`, `api-error`, `text-source`, `title`, `srt`, `vless-uri`. **New** kernel additions in P4: the provider capability schema (ADR-001), the `ContentProvider` interface types, and the template schema (ADR-002).

### Provider Registry (core mechanism — detail in capability contracts doc)

- `ProviderDescriptor` + `ProviderCapability` are **data** (served via `/api/capabilities` and MCP `list_providers`), not code.
- `ContentProvider` interface: `verify / createNotebook / addSource / ask / generate / poll / fetchArtifact / cancel?`, each op returning/handling an `OpHandle` whose `externalId` feeds the UNKNOWN_EXTERNAL_STATE rule (ADR-007).
- **Conformance suites C1–C7** gate every adapter before it is admitted; C7 is a manual live gate (never in CI).

## Rationale

- **Protect the operational system (AGENTS.md §1):** the proven recovery + egress semantics live in one process; splitting them into services would move failure domains (network partitions, distributed consensus) into a system whose current SPOF is already handled by restart-recovery + `job_stages`.
- **Single-operator service:** NLO is operated by one team on one host; the cost of microservices (service discovery, versioned contracts over the wire, distributed tracing, N deploys) is not offset by the scale.
- **Boundary hardening is reversible and incremental:** enforcing module boundaries _inside_ one process is strictly easier to get right than across a network, and each context can be extracted later if a real scale/ownership trigger appears.
- **The registry is the minimal abstraction** that buys multiplicity: one new engine = one adapter + one conformance pass, with no changes to the job engine, accounts, egress, or API.

## Consequences

**Positive**

- New engines/accounts/proxies/MCPs are additive; the mission's entire scope becomes a series of bounded, testable increments (P4-1…P4-8).
- Capability honesty is enforced structurally (data + conformance), not by convention.
- Deployment, rollback, and `data/` survival are unchanged.

**Negative / risks**

- **Discipline is required:** without a second process forcing the boundary, a context _can_ reach into another's repo. Mitigation: ESLint `no-restricted-imports` / boundary lint rule (P4-1) + the four-path acceptance matrix.
- **Single process remains a SPOF** — accepted; mitigated by the existing 7-status restart recovery and the DB as the source of truth.
- The shared kernel can accrete; it must stay transport-neutral (no Fastify, no DB drivers) or the "shared" becomes a tangle.

## Non-goals (explicitly protected)

- Job state machine semantics and transition rules (only _backward-compatible_ new statuses may be added).
- Fail-closed egress (no `direct` without operator opt-out; curl-primary transport).
- Hash-only API tokens; vault-based secrets; redaction everywhere; loopback-only bind default.
- The Python worker protocol (arg-array spawn, JSON lines, settle-once) — adapters reuse it.
- `data/` layout and git-ignored runtime data; CI structure (live gate stays manual).

## Microservices exit criteria (when to reconsider)

A context may be extracted to its own process **only** when at least one is true: (a) it needs an independent deploy cadence, (b) it has a different SLA/isolation requirement (e.g. a bursty video encoder must not starve the job API), or (c) ownership splits across teams. Until then: one process, N in-process workers behind the existing queue interface (target-arch §6 concurrency path).

## Alternatives considered

- **Status quo (flat monolith):** rejected — cannot add engines/accounts cleanly; the five known coupling points (tunnelEnv injection, provider-by-construction, ad-hoc account resolution, static input formats, no MCP surface) block the mission.
- **Microservices now:** rejected — overkill for a single-operator service; adds failure domains to proven in-process logic.
- **Modular monolith + Provider Registry (chosen):** additive, reversible, protects the operational system.

## Evidence

- State machine + transitions: [`packages/shared/src/job-state.ts`](../../../packages/shared/src/job-state.ts), enforced in [`apps/server/src/domain/jobs.repo.ts`](../../../apps/server/src/domain/jobs.repo.ts).
- Resume-never-resubmit: `patchOperationIds` + `job_stages` in [`apps/server/src/providers/python-worker/python-worker-provider.ts`](../../../apps/server/src/providers/python-worker/python-worker-provider.ts); tests `test/podcast-fault-recovery.test.ts`, `test/worker-queue-recovery.test.ts`.
- Fail-closed egress: [`apps/server/src/proxy/`](../../../apps/server/src/proxy/); tests `test/fail-closed.test.ts`.
- Coupling points: [`NLO_P4_TARGET_ARCHITECTURE.md`](../NLO_P4_TARGET_ARCHITECTURE.md) §2.
