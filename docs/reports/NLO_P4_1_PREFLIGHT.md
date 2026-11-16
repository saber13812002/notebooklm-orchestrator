# NLO-P4-1 — Phase Zero Preflight & Backup Report

**Mission:** NLO-P4-1 — Modular Foundations Implementation
**Date:** 2026-11-16 (16:10–16:40 UTC)
**Status:** PREFLIGHT PASSED — no source code modified in Phase Zero
**Baseline reference:** `AGENT-C-P4-1-IMPLEMENTATION-MAP.md` (P4-0.1 seven-agent audit, Agent C) + `NLO-P4-0.1-INDEPENDENT-ADJUDICATION.md`

---

## 1. Repository / git baseline

| Item | Value | Verified |
|---|---|---|
| Workspace | `c:/Users/s.tabatabaei/Documents/saberprojects/notebooklm-orchestrator` | yes |
| Branch | `main` | yes |
| HEAD | `f07ac1fc577da4c2803853f274f3deb756aec7b2` ("ریبورت") | yes |
| Prompt baseline | `5720d16` — HEAD is **exactly one commit ahead** of it | yes |
| Discrepancy disposition | `f07ac1f` adds the two P3 Batch 3 reports as **tracked** files (150 insertions, nothing else). The prompt described them as "untracked P3 reports"; they are now committed on `main`. They must be preserved byte-for-byte (see §4). | yes (diff inspected) |
| Remote | `origin = https://github.com/saber13812002/notebooklm-orchestrator.git` (fetch+push) | yes |
| Sync state | `HEAD == origin/main == f07ac1f` (nothing unpushed) | yes |
| Working tree | clean (no modified, no untracked except `node_modules`-exempt) | yes |
| Migration sequence | `0001`…`0006` applied → **next migration is `0007`** | yes |
| OpenAPI contract | programmatic (`spec.ts`), bidirectional contract test in `openapi-v1.test.ts` | yes |

## 2. Test / quality baselines (measured on `main @ f07ac1f`, before any change)

| Gate | Result | Detail |
|---|---|---|
| `npm test` | **426/426 PASS** | shared 110, server 286, web 30. F-B1 flake (425/426 in audit) did not reproduce — full baseline green. |
| `npm run typecheck` | **PASS** (exit 0) | all workspaces |
| `npm run lint` | **PASS** (exit 0) | |
| `npm run format:check` | **35 pre-existing files** with style issues (exit 1) | list in §6. This is the pre-P4-1 baseline; P4-1 commits must not add to it and will report it separately (not fixed in P4-1 scope). |
| `npm run build` | not re-run in preflight (covered by final gate) | |

## 3. Backup (created before any modification)

Location: `C:/Users/s.tabatabaei/Documents/saberprojects/nlo-p4-1-backups/2026-11-16-p4-1/`

| Artifact | Path | SHA256 |
|---|---|---|
| Git bundle (all 5 refs) | `nlo-p4-1-2026-11-16.bundle` | `154ede11957e18de8edaeb20e019f29def91689aebaabdfb29f3ac2867e15bdf` |
| SQLite online backup (28 jobs, `PRAGMA integrity_check = ok`) | `nlo.sqlite.backup` | `4ff1e38867c844a8c5fe7a7912459d5cddb65a2ebaa1fdc6329b6caaf9617a8c` |
| P3 report — BACKUP_ROLLBACK (preserved file) | `NLO_P3_BATCH3_BACKUP_ROLLBACK.md` | `bb37d23eea1fb69610319455040b9821d30a8684e7f52729326d30e6e6b89cb0` |
| P3 report — REBASELINE (preserved file) | `NLO_P3_BATCH3_REBASELINE.md` | `a9db089b1d91a8b4bf14ed76edfd9bb8b08b66665630334ba6f337b65d259a2a` |

Bundle verified with `git bundle verify` (5 refs, HEAD `f07ac1f`). DB backup taken with Python `sqlite3` online `.backup()` (node:sqlite in v24.14.0 has no `DatabaseSync.backup`); `integrity_check` = ok; job count 28 matches production DB.

## 4. Preserved files (must stay byte-identical)

| File | SHA256 | Note |
|---|---|---|
| `docs/reports/NLO_P3_BATCH3_BACKUP_ROLLBACK.md` | `bb37d23e…6e6b89cb0` | tracked since `f07ac1f`; one of the 35 pre-existing prettier issues — **not reformatted** in P4-1 |
| `docs/reports/NLO_P3_BATCH3_REBASELINE.md` | `a9db089b…37b65d259a2a` | tracked since `f07ac1f`; same disposition |

Rule for all four P4-1 commits: stage files **explicitly by path** (no `git add -A`), never touch the two files above.

## 5. Security preflight

| Item | State |
|---|---|
| `.env` | present, gitignored (`.gitignore` line 18), untracked — **never staged** |
| `.env.example` | tracked; all values empty/safe (`NLO_HOST=127.0.0.1`, `NLO_PORT=4870`, `NLO_PROVIDER=mock`, …) — no real secrets |
| `data/vault.key` | present (64 bytes) — outside git |
| `data/sessions/` | 3 account session JSON files (0600-equivalent) — outside git |
| Live service | local dev instance running on port 4871 (Terminal 2, `NLO_PORT=4871`); production host is read-only for this mission (no deploy, no push) |
| Staging | no staging host configured for P4-1; acceptance is local (mock) + CI (GitHub Actions). Production deploy explicitly out of scope per mission. |

## 6. Pre-existing `format:check` baseline (35 files — NOT introduced by P4-1)

```
apps/server/src/api/routes/orchestrator.ts
apps/server/test/orchestrator.test.ts
CHANGELOG.md
docs/architecture/decisions/ADR-001-modular-architecture.md
docs/architecture/decisions/ADR-002-content-intake.md
docs/architecture/decisions/ADR-003-account-session.md
docs/architecture/decisions/ADR-004-egress-gateway.md
docs/architecture/decisions/ADR-005-mcp-server.md
docs/architecture/decisions/ADR-006-mcp-client-external-providers.md
docs/architecture/decisions/ADR-007-retry-failover.md
docs/architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md
docs/architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md
docs/architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md
docs/architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md
docs/architecture/NLO_P4_TARGET_ARCHITECTURE.md
docs/architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md
docs/product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md
docs/product/NLO_MANUAL_RETRY_SPEC.md
docs/reports/NLO_P3_BATCH3_BACKUP_ROLLBACK.md
docs/reports/NLO_P3_BATCH3_REBASELINE.md
docs/reports/NLO_P4_0_ARCHITECTURE_DISCOVERY.md
docs/reports/RADIO_R0_INFRASTRUCTURE_DISCOVERY.md
docs/reports/RADIO_R0_ROADMAP_STATUS_PROPOSAL.md
docs/reports/RADIO_R1A_PREDEPLOY_READINESS.md
docs/reports/RADIO_R1A_SECURITY.md
docs/reports/RADIO_R1A3_NEO4J_SECURITY.md
docs/research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md
docs/research/NLO_NOTEBOOKLM_MCP_COMPARISON.md
docs/research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md
docs/research/NLO_PROXY_EGRESS_RESEARCH.md
docs/ROADMAP_MASTER.md
docs/roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md
docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md
docs/testing/NLO_P4_FUTURE_TEST_STRATEGY.md
README.md
```

P4-1 policy: newly created/modified source files are prettier-clean; pre-existing issues above are **reported, not fixed**, except `CHANGELOG.md` which P4-1 commits must append to — the appended section will be written prettier-clean, and the file is reformatted only if the appended change is the diff (documented per commit).

## 7. Key structural facts recorded for the workstreams (from source reads)

- `app-context.ts`: provider ternary (157–178); boot recovery `jobs.recoverInFlight()` at 208–212 (P4-1C inserts `locks.resetAll()` **before** it); `AppContext` interface at 29–49 (additive fields for `registry`, `gateway`, `locks`).
- `domain/api-tokens.repo.ts`: `ALL_TOKEN_SCOPES` (38–45) = 6 scopes → add `"providers:read"` (→ 7); `create()` default `["jobs:read","jobs:write","jobs:download"]`.
- `api/v1.ts`: `requiredScope()` (106–141); generic GET fallback (126–131) ⇒ `providers:read` check for `GET /capabilities` must be inserted **before** it; route registration block 259–272.
- `api/routes/tokens.ts` line 22: `.max(6)` ⇒ `.max(ALL_TOKEN_SCOPES.length)`.
- `providers/types.ts`: `tunnel: TunnelHandle | null` at 64, 187, 212, 238 (P4-1B → `endpoint: EgressEndpoint | null`); `CapLevel` + `capabilityMatrix()` at 261–279.
- `providers/python-worker/python-worker-provider.ts`: `tunnelEnv` def at 180; call sites 305, 360, 411 (auth ops), 490 (`runJob`), 662 (`prepareAudioWorker`); `acquireAuthTunnel` 140–177; fail-closed guards 443–451 (`runJob`) and 641–648 (`prepareAudioWorker`); `capabilities()` 194–230.
- `proxy/egress.ts`: `ProviderEgress.request(tunnel, target, body)` (37); `MockProviderEgress` records `EgressAttempt[]`; `DirectEgressBlockedError` on null tunnel (76–87).
- `queue/job-runner.ts`: `JobRunnerDeps` 39–79; `selectAuto` call 161; `tunnel: handle` at 234, 759, 830, 858; tunnel release in `finally` at 374 (`runtime.stopTunnel(nodeId)`); RUNNING transition at 208.
- `db/db.ts`: `Db.open` migrates on open; `db.now()` = `new Date().toISOString()` (UTC) — used by `JobLocks`.
- Migration convention (0006): header comment + pure DDL + compatibility note; `CREATE TABLE IF NOT EXISTS`.
- Test harness: `helpers.ts` `makeParts()` (runner-level) and `makeAppContext(env)` (app-level, queue stopped); `buildApp(ctx)` from `api/server.ts`; `createAdminToken` pattern in `openapi-v1.test.ts`.
- `.github/workflows/ci.yml`: `quality` job (lint→format:check→typecheck→test→build) + `docker` job. P4-1D adds a secret-scan job and a conformance step.
- `packages/shared`: zod 3.24 is an available dependency; `index.ts` is a flat re-export list.

## 8. Open items carried from P4-0.1 (disposition for P4-1)

| Item | Disposition |
|---|---|
| F-B1 (425/426 flake) | **Not reproduced** — full 426/426 baseline green on `f07ac1f`. No formal waiver needed; recorded in final report. |
| F-C1 (fusion declaration) | Mandatory in the `notebooklm.web` descriptor notes + C3 test comments. |
| F-C4 (boot `resetAll()`) | Mandatory in P4-1C with dedicated test. |
| F-C7 (secret scan mechanism) | git-grep gate in CI (no new repo dependency). |
| D1/D2/D3/D7 decisions | Recorded in this report + P4-1A commit message: D1 `GET /api/v1/capabilities`; D2 `providers:read` scope; D3 settle-once arbiter + boot `resetAll()`; D7 gateway = thin `selectAuto` adapter (no cap/affinity in P4-1). |

## 9. Preflight verdict

**GO** — baselines green, backup verified, preservation rules recorded, workstream specs confirmed against source. Proceed to P4-1A (TDD).
