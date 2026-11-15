# ADR-005: NLO as an MCP Server (9 tools as an anti-corruption layer over existing routes)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_MCP_INTEGRATION_ARCHITECTURE.md`](../NLO_MCP_INTEGRATION_ARCHITECTURE.md) §2, research [`NLO_NOTEBOOKLM_MCP_COMPARISON.md`](../../research/NLO_NOTEBOOKLM_MCP_COMPARISON.md)
(Pair with ADR-006 — NLO as an MCP *client*.)

## Context

The mission requires NLO to expose its capabilities to **agents and third-party applications** through MCP. Research established: (1) the ecosystem's dominant non-stdio pattern is **Streamable-HTTP** (PleasePrompto/abdallah-mcp, roomi); (2) NLO's 9 proposed MCP tools (`create_job`, `get_job`, `list_jobs`, `retry_job`, `cancel_job`, `get_artifact`, `list_templates`, `list_providers`, `get_provider_health`) are **7 wrappers of existing REST routes + 1 wrapper of the new P4-4 retry endpoint + 1 genuinely new capability** (`list_templates`, P4-2); (3) NLO already has the auth (API tokens, 6 scopes, audit), the error envelope (`ApiCodes`, 13 E2E codes), idempotency, and webhooks an agent needs.

The open question: how do we add the MCP front door **without duplicating domain logic or creating a second source of truth**?

## Decision

1. **One domain, two front doors.** The MCP endpoint is a **thin anti-corruption layer** over the *same* domain services the REST routes call. A capability is `implemented_tested` on both fronts or on neither — no tool may bypass the state machine, the capability matrix, or the error envelope.
2. **Transport: Streamable-HTTP** on the **existing loopback Fastify app** under `/mcp` (POST/GET/DELETE, `Mcp-Session-Id` header). No second port, no second process. **stdio is not an NLO server mode** in P4 (NLO is a persistent stateful service, not a child process); stdio clients use the ecosystem-standard HTTP→stdio bridge (an ops note).
3. **Auth reuses API tokens** — no new mechanism: `Authorization: Bearer nlo_...` per tool with per-tool scope checks; audit rows record `via: "mcp"` + tool + correlation id; token-scoped idempotency applies to `create_job` exactly as on REST. One token per agent *is* the per-agent credential.
4. **Errors use the existing envelope** `{ error: { code, message } }` mapped into MCP tool-result errors; the 13 E2E-contract codes carry over verbatim.
5. **Long operations return a job id, not a promise:** `create_job` → `{ job: "j_<hex32>", status }`; agents poll `get_job` or subscribe to the existing webhooks. The MCP request/response model never implies sync completion.
6. **Untrusted-content rule applies to tool inputs** (ADR-002): `create_job` source/prompt content is data; tool descriptions state it. **No secrets in schemas or results** (redaction module on all health snapshots; `get_artifact` returns the body or a scoped download URL — P4-6 decision).

## Rationale
- **The hard part is the boundary, not the tools:** the research shows NLO's REST surface already covers 8 of 9 tools; the risk is a *forked* implementation drifting from REST. Making MCP an ACL over the domain services (not over the HTTP routes) is what keeps "one source of truth" true.
- **Reusing tokens** keeps Platform AuthN/Z the single auth context (ADR-001) — no MCP-specific credential store to secure, revoke, or audit.
- **Streamable-HTTP on the existing app** matches the ecosystem's own choice and NLO's loopback + reverse-proxy security posture (ADR-004 invariants).

## Consequences
**Positive:** agents get the full NLO surface (jobs, retry, artifacts, templates, providers/health) with zero new auth; capability truth is identical across REST and MCP; webhooks already provide the push channel agents need.
**Negative / risks:** Fastify becomes the host of two protocol surfaces (mitigated: `/mcp` is additive and isolated); MCP session lifetime vs long jobs is solved by polling+webhooks (server→client *notifications* over the MCP session are deferred, P4-6-later); `get_artifact` body-vs-URL is an open P4-6 decision.

## Alternatives considered
- **A separate MCP process/binary:** rejected — a second deployable + credential path for what is 9 wrappers; NLO is not a stdio service.
- **stdio-first server mode:** rejected — NLO's persistent stateful lifecycle doesn't fit a child-process transport; the bridge covers stdio clients.
- **MCP tools call REST over HTTP internally:** rejected (initially considered for maximum reuse) — an internal HTTP hop adds a failure mode and a second serialization boundary; calling the domain services directly is simpler and keeps one error envelope.

## Evidence
- REST surface + tokens + scopes + audit: [`apps/server/src/api/routes/`](../../../apps/server/src/api/routes/), [`apps/server/src/domain/api-tokens.repo.ts`](../../../apps/server/src/domain/api-tokens.repo.ts); `test/api.test.ts`.
- Error envelope + 13 codes: [`packages/shared/src/api-error.ts`](../../../packages/shared/src/api-error.ts), [`packages/shared/src/e2e-contract.ts`](../../../packages/shared/src/e2e-contract.ts).
- Webhooks (push channel): [`apps/server/src/webhooks/dispatcher.ts`](../../../apps/server/src/webhooks/dispatcher.ts); `test/webhooks.test.ts`.
- Ecosystem transport/auth patterns: [`NLO_NOTEBOOKLM_MCP_COMPARISON.md`](../../research/NLO_NOTEBOOKLM_MCP_COMPARISON.md) §2, §4, §5.
