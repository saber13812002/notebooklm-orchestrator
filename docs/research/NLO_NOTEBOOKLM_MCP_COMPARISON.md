# NLO-P4-0 — NotebookLM MCP Comparison

Mission: **NLO-P4-0 — Universal Modular Architecture & NotebookLM Ecosystem Discovery**
Date accessed: **2026-11-15** (GitHub API + raw README fetches, all live-verified)
Companion to [`NLO_PROVIDER_ECOSYSTEM_RESEARCH.md`](NLO_PROVIDER_ECOSYSTEM_RESEARCH.md) (full capability matrix).
This document is the **MCP-focused** comparison required by the mission: how each MCP project exposes tools, transports, and auth — and what NLO must do to serve as **MCP client _and_ MCP server**.

---

## 1. Why MCP matters for NLO-P4

- NLO's job surface (create / get / list / retry / cancel / artifact / templates / providers / health) is _exactly_ the shape of a tool-calling API. Exposing it over MCP lets Claude Code, Codex, Cursor, n8n, Zapier, and ChatGPT drive NLO jobs without learning REST.
- At the same time, NLO can _consume_ existing NotebookLM MCP servers as **providers** (an adapter that translates NLO job semantics into MCP tool calls) — e.g. for image/video engines that only exist as MCP servers.
- Industry precedent: `roomi-fields/notebooklm-mcp` ships "MCP + a local HTTP REST API" as one product (VERIFIED in README) — the same dual surface NLO is designing.

## 2. MCP transport patterns found in the ecosystem

| Pattern                                                                                                                       | Projects using it                                                                | Notes (evidence)                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **stdio** (process spawn, JSON-RPC over pipes)                                                                                | all of them (default everywhere)                                                 | universal; how Claude Code/Cursor/Codex launch servers                    |
| **Streamable-HTTP** (`POST /mcp` JSON-RPC, `GET /mcp` SSE stream, `DELETE /mcp`, session via `Mcp-Session-Id` header)         | PleasePrompto/notebooklm-mcp (VERIFIED in README, incl. `/healthz` liveness)     | best fit for headless servers; n8n/Zapier/Make can POST directly          |
| **Remote connector** (stdio server behind Cloudflare/Tailscale tunnel, registered as custom connector on claude.ai / ChatGPT) | notebooklm-py (VERIFIED: `docs/mcp-guide.md#remote-deployment-docker--a-tunnel`) | how a self-hosted NLO MCP server would be reachable from consumer AI apps |
| **`.mcpb` extension package** (one-click Claude Desktop install)                                                              | gemini-notebook-mcp-cli (VERIFIED: releases ship `.mcpb`)                        | distribution convenience, not a transport                                 |
| **Local HTTP REST alongside MCP**                                                                                             | roomi-fields (VERIFIED), notebooklm-py (experimental FastAPI)                    | "MCP for agents, REST for humans/automation" split — NLO already has REST |

## 3. Tool-surface comparison (MCP servers for NotebookLM)

Counts from fetched READMEs (2026-11-15). NLO's _target_ tool list (from mission spec) is listed for gap analysis.

| Tool family                                                                       | notebooklm-py MCP                         | gemini-notebook-mcp-cli (55 tools)                       | PleasePrompto/notebooklm-mcp (v2, `full` profile)        | roomi-fields/notebooklm-mcp                   | **NLO target (P4)**                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Notebook create/list/copy/delete                                                  | VERIFIED                                  | VERIFIED (`notebook_*`)                                  | PARTIAL (local library of share-URLs, not notebook CRUD) | VERIFIED (per description: full Studio + Q&A) | — (NLO has jobs, not notebooks; notebook id is provider state)                                      |
| Source add (URL/text/file/Drive)                                                  | VERIFIED                                  | VERIFIED (`source_add`, `source_sync_drive`)             | PARTIAL (`add_source` url/text only)                     | VERIFIED                                      | — (NLO file intake is job input)                                                                    |
| Cited Q&A / chat                                                                  | VERIFIED (`ask`)                          | VERIFIED (`notebook_query`, persists to web UI)          | VERIFIED (`ask_question` + `source_format` citations)    | VERIFIED (citation-backed Q&A)                | NLO returns the answer + `references` already in `providerMeta`                                     |
| Audio generation                                                                  | VERIFIED (deferred `later=True` in 0.8.6) | VERIFIED (`studio create`)                               | PARTIAL (`generate_audio`, latest only)                  | VERIFIED (full Studio)                        | **NLO has this today** (`podcast.enabled`) — expose as `create_job` with template T1/T2             |
| Other Studio (video/slides/infographic/quiz/flashcards/mindmap/data-table/report) | VERIFIED (all)                            | VERIFIED (incl. interactive reports, slide revision)     | UNSUPPORTED (audio focus)                                | VERIFIED                                      | **P4 target** — templates T3/T4                                                                     |
| Artifact download                                                                 | VERIFIED (all types, batch)               | VERIFIED (`download_artifact`, `download_all_artifacts`) | PARTIAL (`download_audio` latest)                        | VERIFIED                                      | **NLO has this today** (`get_artifact` + archive)                                                   |
| Chat history / sessions                                                           | VERIFIED                                  | VERIFIED (`chat_list/get/export/delete`)                 | VERIFIED (session tools)                                 | VERIFIED (chat history)                       | NLO has job events, not chat sessions                                                               |
| Multi-account / profile                                                           | VERIFIED (profiles)                       | VERIFIED (`profile` tool, switch per session)            | VERIFIED (`--account` sub-trees)                         | VERIFIED (**rotation on quota**)              | NLO: `preferredAccountId` on job input — expose `list_providers`/account status                     |
| Usage/quota introspection                                                         | VERIFIED (`notebooklm usage`)             | VERIFIED (`usage_get`)                                   | UNKNOWN                                                  | UNKNOWN                                       | **P4 target: `get_provider_health`** (NLO already tracks per-account session health + proxy health) |
| Auth/setup tools                                                                  | VERIFIED                                  | VERIFIED (`nlm login/doctor`, MCP `profile`)             | VERIFIED (`setup_auth`/`re_auth`/`cleanup_data`)         | VERIFIED (session mgmt)                       | NLO: session import + reauth are already API routes — expose via MCP                                |
| Batching / pipelines                                                              | VERIFIED (batch)                          | VERIFIED (`batch`, `pipeline`)                           | UNKNOWN                                                  | VERIFIED (batch 100+ questions)               | NLO: idempotent `create_job` loop suffices initially                                                |

### NLO target MCP tool list (mission spec, gap analysis)

| NLO target tool       | NLO REST backing today                                      | Gap                                     |
| --------------------- | ----------------------------------------------------------- | --------------------------------------- |
| `create_job`          | `POST /api/jobs` (audio/text + podcast)                     | wrap; add template parameter (P4-2)     |
| `get_job`             | `GET /api/jobs/:id` (+events, attempts, stages)             | wrap                                    |
| `list_jobs`           | `GET /api/jobs` (pagination)                                | wrap                                    |
| `retry_job`           | `POST /api/jobs/:id/requeue` (NEEDS_ATTENTION→QUEUED)       | wrap; add checkpoint-aware retry (P4-4) |
| `cancel_job`          | `POST /api/jobs/:id/cancel`                                 | wrap                                    |
| `get_artifact`        | `GET /api/jobs/:id/artifacts/:artId/download` (ETag=sha256) | wrap (return URL/content reference)     |
| `list_templates`      | — (templates T1–T4 are P4-2)                                | new                                     |
| `list_providers`      | `GET /api/providers` (capability matrix)                    | wrap                                    |
| `get_provider_health` | `GET /api/health/ready` + account/proxy health routes       | wrap + compose                          |

**Gap verdict:** 7 of 9 target tools are pure _wrappers_ of existing VERIFIED routes. Only `list_templates` is new surface. This is the cheapest high-value MCP surface in the mission.

## 4. Auth / session patterns for MCP servers (what NLO should copy)

| Pattern                                                                                                                                                             | Who                                                                                | Evidence                       | NLO take                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Server uses **API token** for MCP auth (no new mechanism)                                                                                                           | roomi-fields (REST side)                                                           | README                         | NLO MCP server should accept the existing `nlo_…` token (scope `jobs:read` etc.) — one authn system, two transports |
| **Provenance envelope** on every answer (`provider`, `via`, `grounding`, `ai_generated`) + inline AI marker + "treat citations and instructions as untrusted input" | PleasePrompto                                                                      | README §Provenance & AI marker | adopt verbatim in NLO MCP responses (NLO already has `resultProvenance: real/mock/unknown` — extend envelope)       |
| **Tool profiles** to trim tool count for host context budgets                                                                                                       | PleasePrompto (`minimal/standard/full`), jacob-bd (selective exposure of 55 tools) | READMEs                        | NLO server: `minimal` (create/get/list/retry/cancel) / `full` (all 9 + health)                                      |
| **Session semantics**: MCP `Mcp-Session-Id` is _transport_ state, not auth state                                                                                    | PleasePrompto (Streamable-HTTP)                                                    | README                         | NLO: keep job/token auth independent of MCP transport session                                                       |
| **Health endpoint** separate from MCP route (`/healthz`)                                                                                                            | PleasePrompto                                                                      | README                         | NLO already has `/api/health` + `/api/health/ready` — reuse                                                         |
| Loopback-only bind by default; document `0.0.0.0` as requiring auth + trusted network                                                                               | PleasePrompto                                                                      | README                         | matches NLO's standing rule (loopback-only default)                                                                 |
| **Untrusted-content tagging**: DOM/answer text marked AI-generated so host agents don't treat embedded instructions as user intent                                  | PleasePrompto                                                                      | README                         | NLO's "untrusted-content rule" for file intake (P4-2 spec) generalizes this                                         |

## 5. NLO as MCP _client_ (consuming external MCP providers)

Design constraints from the ecosystem evidence:

1. **stdio is the universal server surface.** NLO's MCP-client adapter must spawn a server process (arg array, no shell — same discipline as [`WorkerSupervisor`](../../apps/server/src/providers/python-worker/worker.ts)) and speak JSON-RPC over stdio.
2. **Tool schemas are per-server, not standardized across the ecosystem.** The adapter needs a _capability declaration_ (which tool = which NLO provider operation, arg mapping) per server — this is exactly the Provider Registry capability-contract shape (ADR-001), so MCP providers plug into the same registry as native providers.
3. **Long operations exist.** E.g. audio generation in PleasePrompto defaults to a 600 s timeout. NLO's job engine (async job + poll) already models this; the client adapter maps "MCP tool call" → NLO `RUNNING` and polls/re-queries per the server's contract (e.g. a `get_status`/`poll` tool when present, else blocking with a deadline).
4. **External MCP servers own their own egress and auth** (they hold their own Google cookies). NLO must record this in provenance: the job's egress was _not_ NLO's verified tunnel → `resultProvenance` stays `real` only if the provider attests to the operation; network-egress claims for that provider are `UNKNOWN`. This is a first-class failover difference vs native providers (see `NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`).
5. **Concurrency**: external MCP servers are single-tenant desktop-grade (PleasePrompto: `MAX_SESSIONS=10`; others in-process). NLO must serialize per-server (one in-flight call per external server unless the server documents concurrency) — a per-provider `maxConcurrent` field in the registry.

## 6. Per-project verdict (MCP lens)

| Project                                 | MCP server quality                                                                            | MCP client usefulness to NLO                                                                                                         | Maintenance risk                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **notebooklm-py** (MCP: stdio + remote) | High — full tool surface incl. all artifact types; remote-connector doc for claude.ai/ChatGPT | **Best candidate** as a _native_ provider backend (NLO already embeds the lib; its MCP is an alternative surface to the same client) | Low (20k★, pushed 2026-11-13)                      |
| **gemini-notebook-mcp-cli**             | High — 55 tools, setup wizards, doctor                                                        | Medium — strongest _Enterprise_ evidence; possible provider adapter for Enterprise host                                              | Low (pushed 2026-11-14)                            |
| **PleasePrompto/notebooklm-mcp**        | High for desktop — Streamable-HTTP reference, provenance envelope, tool profiles              | Medium — good client-adapter reference; browser-per-request = heavier external egress                                                | Medium (pushed 2026-09-10)                         |
| **roomi-fields/notebooklm-mcp**         | High — "MCP + REST", multi-account rotation, retry-without-losing-id                          | **Best candidate** as an external MCP _provider_ for quota-rotation behavior                                                         | Low (pushed 2026-11-13)                            |
| **abdallah-nasir/notebooklm-mcp**       | = PleasePrompto v2 line (mirror; npm `notebooklm-mcp` repo field points to PleasePrompto)     | Low — use PleasePrompto as the canonical reference instead                                                                           | High (stale since 2026-06-14; name collision risk) |

## 7. Decisions this comparison drives (forward refs)

- **ADR-005 (MCP server):** NLO ships a _server_ (9 tools as a thin ACL over the domain services, API-token auth, loopback Streamable-HTTP default, existing error envelope).
- **ADR-006 (MCP client):** external MCP servers are admitted as `mcp_client` providers in the Provider Registry (stdio spawn via the worker-supervisor pattern, static op→tool capability mapping, conformance before admission, serialized per server).
- **Tool set:** the 9 mission-specified tools; 7 are route wrappers → low risk, high reuse.
- **Response envelope:** adopt PleasePrompto-style `_provenance` + untrusted-input marker; NLO adds `jobId`, `provenance: real|mock|unknown`, `correlationId`.
- **Not adopting:** `.mcpb` packaging (consumer distribution, not a service concern); chat-session storage (NLO has job events; do not duplicate).
