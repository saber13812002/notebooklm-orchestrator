# NLO Master Execution Roadmap (v2.0) + Server Endpoint Migration Addendum

> **Purpose:** this file is the standing mission statement for the NotebookLM
> Orchestrator (NLO). Every future agent session (and human contributor) MUST
> read it first, work strictly phase-by-phase, and stop at each approval gate.
> Source: user-provided "MASTER EXECUTION ROADMAP v2.0" (2026-11-01) +
> "ADDENDUM — SERVER ENDPOINT MIGRATION".
>
> **Current position (2026-11-01):** Addendum Phases A+B complete
> ([`SERVER_ENDPOINT_MIGRATION_AUDIT.md`](reports/SERVER_ENDPOINT_MIGRATION_AUDIT.md),
> [`SERVER_ENDPOINT_CONNECTIVITY.md`](reports/SERVER_ENDPOINT_CONNECTIVITY.md));
> STOPPED, awaiting user approval for Addendum Phase C. Roadmap Phase 1
> (local/Swagger) complete; Phase 0 reconciliation complete.

---

## 1. Mission

Take NLO from its current state to a **production-ready, API-first product**:
batch Word/DOCX processing, Google Drive + ZIP input, per-file Notebooks,
prompt engine, 15 output types, artifact downloads, Drive/sharing, messaging
to Bale/Soroush/Eitaa/Telegram/Rubika, webhooks/SDK, and a complete frontend.

**Permanent engineering rules** (see [`AGENTS.md`](../AGENTS.md) for the binding
rule set):

1. **API-First:** the REST API is the source of truth; the frontend only calls
   documented `/api/*` routes; long operations are asynchronous (job IDs
   `j_<hex32>`, queryable status/events/artifacts).
2. **Approval gates** — stop and wait for explicit user approval before:
   production auth activation, DNS/proxy/firewall changes, systemd→Docker
   migration, public wiki publishing, public Drive/Notebook sharing, public
   channel sends, any data deletion, access-policy changes, **any production
   migration**.
3. **Honest status labels:** `Completed` / `Implemented` / `Unit Tested` /
   `Live Verified` / `Not Tested` / `Blocked`. **Mock is never presented as
   Live.** Reports must state which level was verified.
4. **No secrets in Git, logs, or chat.** Tokens/keys only via env/vault.
5. **No force-push; no history rewrites; no destructive changes.**
6. **Per-phase cycle:** Audit → Plan → Implement → Test → Review → Document →
   Commit → Push → (Deploy if authorized) → Verify → Report → **Stop for approval.**
7. **Dual-repo policy:** GitHub `saber13812002/notebooklm-orchestrator` is the
   public source of truth; GitLab `git.ai.ismc.ir` is a one-way internal mirror.

## 2. Master roadmap (18 phases)

| Phase | Title                                                                    | Gate                                                  |
| ----- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| 0     | Current-state reconciliation (local/GitHub/production/DNS/ports)         | ✅ done (`PHASE_0_RECONCILIATION.md`)                 |
| 1     | Local run + Swagger/OpenAPI verification                                 | ✅ done (`PHASE_1_LOCAL_SWAGGER.md`)                  |
| 2     | Production API authentication activation                                 | ⚠️ procedure ready, **not activated** (approval gate) |
| 3     | Domain/HTTPS (`nlo.ai.ismc.ir`) via edge proxy + TLS                     | open                                                  |
| 4     | GitLab CI (mirror, pipeline, secret-scan gate)                           | open                                                  |
| 5     | Docker packaging (local single-user; s52 stays systemd without approval) | open                                                  |
| 6     | Wiki.js publishing (14 customer pages)                                   | open (needs API account)                              |
| 7     | Batch architecture (multi-source jobs)                                   | open                                                  |
| 8     | Google Drive + ZIP input                                                 | open                                                  |
| 9     | Prompt engine + output catalog (15 types)                                | open — **uses the internal LLM API (addendum)**       |
| 10    | NotebookLM orchestration (real provider)                                 | open                                                  |
| 11    | Artifacts/downloads                                                      | open                                                  |
| 12    | Drive output/sharing                                                     | open (public-sharing gate)                            |
| 13    | Messaging (Bale/Soroush/Eitaa/Telegram/Rubika)                           | open (public-send gate)                               |
| 14    | Webhooks + SDK                                                           | open                                                  |
| 15    | Frontend completion                                                      | open                                                  |
| 16    | Customer docs (Wiki.js live)                                             | open (public-publish gate)                            |
| 17    | Production E2E + release                                                 | open                                                  |
| 18    | Final governance                                                         | open                                                  |

## 3. Mandatory per-phase report template

Every phase ends with a report in `docs/reports/` containing:

1. Executive Summary
2. Initial State (read-only evidence)
3. Implementation (what changed, why, file list)
4. Git (commits, SHAs, branch, push state)
5. Tests (level honestly labeled: Unit/Integration/E2E-mock vs Live)
6. Live Verification (only if performed; otherwise "Not performed")
7. Security (secrets, exposure, redaction)
8. Deployment (only if authorized; otherwise "No deployment")
9. Data Safety (DB, backups, `data/` integrity)
10. Known Limitations
11. Blockers + required accesses
12. Rollback (how to undo)
13. Next Phase proposal
14. Approval Request (explicit STOP)

## 4. Addendum — Server Endpoint Migration (s52 → 172.30.0.133)

**Context (2026-11-01):** the legacy server s52 (`172.20.1.52`) moved. New
internal endpoint: `http://172.30.0.133:4000/v1`.

**CRITICAL DISTINCTION (verified 2026-11-01):** the new address is an **API v1
endpoint of LiteLLM v1.101.0** (OpenAI-format LLM proxy). It is **NOT** NLO's
web address, SSH address, GitLab, or reverse proxy. Never substitute IPs by
numeric similarity. Proof: [`SERVER_ENDPOINT_CONNECTIVITY.md`](reports/SERVER_ENDPOINT_CONNECTIVITY.md).

### Facts established (Phase A+B)

- `172.30.0.133:4000` = **LiteLLM** (OpenAI-compatible; base URL
  `http://172.30.0.133:4000/v1`; auth `Authorization: Bearer <key>`;
  unauthenticated monitors: `/health/liveliness`, `/health/readiness`).
- GitLab (`:81`) and Wiki.js (`:8888`) **already re-homed** to `172.30.0.133`;
  all three org domains' DNS already points there.
- **NLO is not yet on the new host** (`:4870` refused; domain vhost 404).
- Old host `172.20.1.52` is unreachable (timeouts).

### Addendum phases

| Phase | Scope                                                                                                                                                                                          | State                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A     | Read-only audit of all legacy references (classify: ① change / ② historical-keep / ③ other-service-do-not-change)                                                                              | ✅ done                                                                                                                  |
| B     | Read-only connectivity + service identification of the new endpoint                                                                                                                            | ✅ done                                                                                                                  |
| C     | Centralized config: new env var `NLO_INTERNAL_API_BASE_URL` (default `http://172.30.0.133:4000`) documented as the **internal LLM proxy (OpenAI-compatible)**; config.ts + .env.example + docs | ✅ done (commit `3f796a6`, pushed 2026-11-01)                                                                            |
| D     | Documentation migration (① change-list items; phrased honestly — NLO host deployment still pending until G)                                                                                    | ✅ done (see `SERVER_ENDPOINT_MIGRATION_PHASE_D.md`)                                                                     |
| E     | Integration tests: no requests to old IP; new endpoint used; clean errors when down; secret redaction                                                                                          | ✅ done (see `SERVER_ENDPOINT_MIGRATION_PHASE_E.md`; in-process mock HTTP, not live — live `/v1/models` pending LLM key) |
| F     | Local verification (4871)                                                                                                                                                                      | ✅ done (see `SERVER_ENDPOINT_MIGRATION_PHASE_F.md`; local process + 175/175, not live)                                  |
| G1    | Endpoint live verification — read-only (company network: TCP/HTTP, service ID, auth, timings; no inference)                                                                                     | ✅ done 2026-11-02 (`PHASE_G1_ENDPOINT_LIVE_VERIFICATION.md`): LiteLLM v1.101.0 live, auth = Bearer key, TCP+unauthenticated HTTP verified; authenticated `/v1/models` pending key |
| G2    | Production readiness audit (SSH access, host facts, deploy path, backups, rollback, config compatibility, docs)                                                                                 | ✅ done 2026-11-02 (`PHASE_G2_PRODUCTION_READINESS.md`): deploy path host-agnostic + ready; SSH login + host facts = required G3 inputs                      |
| G3-A  | New production host secure access + read-only audit (SSH identity/fingerprint, host/resources, LiteLLM on 127.0.0.1:4000, legacy data discovery, deploy-file review, security) | ✅ done 2026-11-02 (`PHASE_G3A_NEW_HOST_AUDIT.md`): SSH `saber` publickey verified; NLO **already running** on host at `b5e9ad3` (loopback 4870, ready OK); legacy `data/` intact; deploy path reusable as-is; STOP before G3-B |
| G3-B  | Production deploy to baseline `50b31e7` (fast-forward `b5e9ad3` → `50b31e7` + `deploy.sh`, health, optional authenticated `/v1/models` once key provisioned)                                   | pending — **hard approval gate** (blocked on: user approval; LLM key via secret store for the authenticated check)                            |
| H     | Final consistency audit (domain/TLS kept as a separate workstream — proxy owner + authorization still open)                                                                                       | pending                                                                                                                  |

**Execution order:** Audit ← connectivity ← config ← docs ← local test ←
**user approval** ← production change.

## 5. Standing local environment notes

- Local dev server: port **4871** (`NLO_PORT=4871`), keep running.
- Stale pre-Phase-C instance on 4870 (PID 8380) — **do not kill** without approval.
- ~~14870 SSH-tunnel guidance is dead (s52 gone) — remove in Phase D.~~
  Removed in Phase D (s52-deploy.md, wiki 14) — historical reports keep the
  record verbatim.
- Docker absent on the Windows workstation.

## 6. Status of known blockers (carried into Phases 2–3)

- NotebookLM region/anti-abuse gate (`location=unsupported`) for s52 egress —
  egress situation may change on the new host; re-verify before live jobs.
- `nlo.ai.ismc.ir`: DNS now at new host, but **no NLO vhost/TLS yet** (Phase 3).
- GitLab PAT and Wiki.js API account still missing (Phases 4/6).
