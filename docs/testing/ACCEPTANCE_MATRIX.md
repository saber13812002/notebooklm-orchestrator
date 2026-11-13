# Four-Path Acceptance Matrix (NLO-P1)

Labels: **PASS** (evidence in this phase) · **BLOCKED** (environment/precondition missing) ·
**NOT TESTED** · **NOT IMPLEMENTED** (capability absent — reported, never faked).

| Capability          | Human UI (`apps/web`)                                                                  | REST API (`/api/v1`)                                                         | MCP                                     | External E2E agent (`nlo-e2e`)                  |
| ------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| Create text job     | implemented (`from-text` form exists; see §UI gaps) — NOT TESTED (no running instance) | `POST /notebooks/from-text` — contract present; live NOT TESTED              | NOT IMPLEMENTED (no MCP server in repo) | implemented: `--scenario text`                  |
| Upload audio        | implemented (upload control) — NOT TESTED                                              | `POST /jobs` (multipart) — live NOT TESTED                                   | NOT IMPLEMENTED                         | implemented: `--scenario audio` (`--field`)     |
| Job id / status     | implemented (job list/detail) — NOT TESTED                                             | `GET /jobs/{id}` — live NOT TESTED                                           | NOT IMPLEMENTED                         | implemented: polling + status history           |
| Stage visibility    | UI shows status/progress — NOT TESTED                                                  | `/events`, `/attempts` — live NOT TESTED                                     | NOT IMPLEMENTED                         | implemented: `events_timeline`, `attempts_read` |
| Error understanding | UI error banner — NOT TESTED                                                           | error envelope `{error:{code,message}}` (`packages/shared/src/api-error.ts`) | NOT IMPLEMENTED                         | 12 stable `E2E_*` codes                         |
| Result              | UI result view — NOT TESTED                                                            | `GET /jobs/{id}/result`                                                      | NOT IMPLEMENTED                         | `result_received` stage                         |
| Artifact download   | UI download link — NOT TESTED                                                          | `GET /jobs/{id}/artifacts/{artifactId}`                                      | NOT IMPLEMENTED                         | digest + MIME + size checks                     |
| Recovery            | UI requeue button (where enabled) — NOT TESTED                                         | `POST /jobs/{id}/requeue`, `/cancel`                                         | NOT IMPLEMENTED                         | BLOCKED-by-policy (no auto-retry; see runbook)  |
| OpenAPI             | —                                                                                      | `GET /api/v1/openapi.json`, `GET /api/docs`                                  | —                                       | consumed as contract guard                      |

## Verdict for this phase

- **External E2E agent:** `INTEGRATION-VERIFIED` (executes, contract-checks, classifies, writes report) — **live NOT TESTED**.
- **REST API:** `CODE-VERIFIED` via OpenAPI spec + existing 31 test files; **live NOT TESTED**.
- **Human UI:** `CODE-VERIFIED` only; no running instance in this environment ⇒ **NOT TESTED**.
- **MCP:** `NOT IMPLEMENTED` — the repo contains no MCP server/tools. Gap documented; proposed attachment is a thin MCP server over `/api/v1` (jobs create/status/result/artifact) reusing the same Bearer auth — **not built in this phase** (no fake implementation).
