# Agent D — TDD & CI Audit (NLO-P4-1.1)

- **Agent role:** TDD & CI Auditor (Qwen)
- **Mode:** independent audit; **all gates were re-run from scratch** on this checkout (not copied from
  the P4-1 report); executed sequentially in a separate context (no true subagents — see CONSOLIDATED
  §parallelism).
- **Executed:** 2026-11-17 ~15:55–16:35 UTC, repo HEAD `b833d89`, Node v24.14.0, npm workspaces,
  Windows 10 cmd.exe.

---

## 1. `npm test` (all workspaces) — re-run result: **PASS**

| Workspace | Test files | Tests | Time | Exit |
|---|---|---|---|---|
| `@nlo/shared` | 12 | **128 pass / 0 fail** | 1.69 s | 0 |
| `@nlo/server` | 33 | **357 pass / 0 fail** | 10.11 s | 0 |
| `@nlo/web` | 4 | **30 pass / 0 fail** | 8.55 s | 0 |

Total: **49 files, 515 tests, 0 failures.**

Server-suite coverage highlights (all re-run green): `api.test.ts` (REST surface), `settle-once.test.ts`
(job locks), `worker-queue-recovery.test.ts`, `worker-supervisor.test.ts`, `session-gate.test.ts`,
`webhooks.test.ts`, `transcode.test.ts`, `openapi-v1.test.ts`, `from-text.test.ts`,
`podcast-fault-recovery.test.ts`, `job-lifecycle.test.ts`, `internal-llm.test.ts`,
`worker-nonascii-protocol.test.ts`, `accounts.repo.test.ts`, `sessions-404.test.ts`,
`artifact-download.test.ts`, `artifact-storage.test.ts`, `provider-audio.test.ts`, `orchestrator.test.ts`,
`transcode.test.ts`. **MOCK-E2E-VERIFIED / UNIT-VERIFIED / INTEGRATION-VERIFIED** (in-process app with
the mock provider; **no live NotebookLM calls**).

Known pre-existing environment quirk (not a failure): the F-B1 libuv flake on Windows observed in prior
phases did not occur in this run; `npm ls` arborist glitch also not hit. Recorded honestly: this run was
clean.

## 2. `npm run typecheck` — **PASS** (exit 0)

All three workspaces (`shared`, `server`, `web`) typecheck clean. **CODE-VERIFIED** (run live).

## 3. `npm run lint` — **PASS** (exit 0)

Includes the P4-1D `no-restricted-imports` boundary rules (Agent B §Q1/Q11 for the rule text and its
meaning). No warnings. **CODE-VERIFIED** (run live).

## 4. `npm run build` — **PASS** (exit 0)

Vite production build green; output `apps/web/dist/assets/index-Dv9S9ohc.js` (492.36 kB). Server/shared
builds also succeed. **CODE-VERIFIED** (run live).

## 5. Provider conformance runner (C1–C7) — re-run result, verbatim output

```
C1 PASS
C2 PASS
C3 PASS
C4 PASS
C5 PASS
C6 PASS
C7 NOT RUN
result: C1–C6 all PASS (mock level — Live NOT verified; C7 is a manual gate)
```

Exit 0. C7 (live conformance against real NotebookLM) is **manually gated and NOT run in CI** — by
design (`docs/testing/E2E_TEST_STRATEGY.md` §5). **MOCK-E2E-VERIFIED**; live status NOT claimed.

## 6. CI secret-scan scripts — extracted verbatim, executed live

Both implementations were extracted **exactly as CI would run them** and executed on this checkout:

| Script | Extraction | Execution result |
|---|---|---|
| `.gitlab-ci.yml` → `secret-scan` job (bash heredoc, 6-space indent) | awk extraction with CRLF strip (`sub(/\r$/,"")` — the file has CRLF endings); heredoc body L63–150 | planted fixture **detected → removed**; working tree clean; `secret-scan: OK`; **exit 0** |
| `.github/workflows/ci.yml` → `secret-scan` job (`run: |` block, L89–174, 10-space indent) | awk line-range de-indent | identical behavior; **exit 0** |

Both contain the same 8 patterns and the same 4-file allowlist (see Agent C §1). The self-test fixture
`vless://aaaa0000-b1b1-c2c2-d3d3-4e4e4e4e4e4e@scan-fixture.example:443#selftest` is created, detected,
and removed by the script itself — proving the scanner detects before it reports OK.
**UNIT-VERIFIED** (executed live, both variants).

## 7. Prettier / `format:check` — the 36-file drift, identified exactly

`npx prettier --check .` (prettier 3.9.10, config `.prettierrc.json`: semi, double quotes, trailing
comma, width 100, tab 2) flags **exactly 36 files**. The complete list:

1. `apps/server/src/api/routes/orchestrator.ts`
2. `apps/server/test/orchestrator.test.ts`
3. `docs/api/README.md`
4. `docs/architecture/decisions/ADR-001-modular-architecture.md`
5. `docs/architecture/decisions/ADR-002-content-intake.md`
6. `docs/architecture/decisions/ADR-003-account-session.md`
7. `docs/architecture/decisions/ADR-004-egress-gateway.md`
8. `docs/architecture/decisions/ADR-005-mcp-server.md`
9. `docs/architecture/decisions/ADR-006-mcp-client-external-providers.md`
10. `docs/architecture/decisions/ADR-007-retry-failover.md`
11. `docs/architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`
12. `docs/architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md`
13. `docs/architecture/NLO_JOB_RECOVERY_AND_FAILOVER_ARCHITECTURE.md`
14. `docs/architecture/NLO_MCP_INTEGRATION_ARCHITECTURE.md`
15. `docs/architecture/NLO_P4_TARGET_ARCHITECTURE.md`
16. `docs/architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md`
17. `docs/operations/JOB_RECOVERY_RUNBOOK.md`
18. `docs/product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md`
19. `docs/product/NLO_MANUAL_RETRY_SPEC.md`
20. `docs/reports/NLO_P3_BATCH3_BACKUP_ROLLBACK.md`
21. `docs/reports/NLO_P3_BATCH3_REBASELINE.md`
22. `docs/reports/NLO_P4_0_ARCHITECTURE_DISCOVERY.md`
23. `docs/reports/NLO_P4_1_PREFLIGHT.md`
24. `docs/reports/RADIO_R0_INFRASTRUCTURE_DISCOVERY.md`
25. `docs/reports/RADIO_R0_ROADMAP_STATUS_PROPOSAL.md`
26. `docs/reports/RADIO_R1A_PREDEPLOY_READINESS.md`
27. `docs/reports/RADIO_R1A_SECURITY.md`
28. `docs/reports/RADIO_R1A3_NEO4J_SECURITY.md`
29. `docs/research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`
30. `docs/research/NLO_NOTEBOOKLM_MCP_COMPARISON.md`
31. `docs/research/NLO_PROVIDER_ECOSYSTEM_RESEARCH.md`
32. `docs/research/NLO_PROXY_EGRESS_RESEARCH.md`
33. `docs/ROADMAP_MASTER.md`
34. `docs/roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md`
35. `docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md`
36. `docs/testing/NLO_P4_FUTURE_TEST_STRATEGY.md`

### 7.1 Is the drift local or at HEAD? — **DRIFT-AT-HEAD, proven**

For each of the 36 files, the **committed blob at HEAD** was checked:
`git show HEAD:<file> | npx prettier --stdin-filepath <file> --check` — **all 36 fail** (i.e. the
non-conformance exists in the *repository*, not as a local CRLF/edit artifact). `conformant_at_head=0`.

CRLF ruled out: `.gitattributes` sets `* text=auto eol=lf`, so committed blobs are LF.
Pre-existence proven: blob extracts at older commits (e.g. `docs/api/README.md` @ `f07ac1f`,
`ADR-004` @ `f07ac1f`, `JOB_RECOVERY_RUNBOOK.md` @ `f07ac1f`, `NLO_P4_1_PREFLIGHT.md` @ `90f9619`)
already fail prettier — the drift predates the P4-1 window and was accumulated over earlier phases.

### 7.2 Consequence (the one red gate in this audit)

The CI `quality` job runs `npm run format:check` (prettier). On a **fresh clone** the same 36 files are
non-conformant, so **`format:check` would FAIL in CI** — meaning either (a) the CI has never actually run
this gate on a clean clone (GitHub Actions: no public evidence of a completed run visible from this
workstation — GitHub was network-blocked during the audit; GitLab: no runner exists yet), or (b) it has
run and the gate is red/tolerated. **Status: PARTIALLY-VERIFIED** (local run: FAIL on these 36 files;
CI-run history: NOT-VERIFIED due to network). This is the largest test/CI gap found → backlog D-BL-01
(P1: the repo cannot pass its own format gate).

## 8. Other CI jobs — static review (execution blocked as documented)

| Job | File | Runnability on this workstation |
|---|---|---|
| `quality` (lint + typecheck + format) | `.github/workflows/ci.yml`, `.gitlab-ci.yml` | lint/typecheck re-run locally green; format — see §7.2 |
| `conformance` (C1–C6) | both | re-run locally — §5 |
| `secret-scan` | both | re-run locally — §6 |
| `docker` (build image, `BUILD_DOCKER=1` gate) | both | **NOT RUN** — no Docker daemon on this Windows workstation (Docker API connect failed). Image build is PARTIALLY-VERIFIED (file review only; Agent E) |

## 9. Test-strategy honesty check (AGENTS.md §5)

- Unit/feature/integration levels all exist and are green (this audit).
- E2E against in-process app with mock provider: exists (`api.test.ts`, `job-lifecycle.test.ts`, …).
- Live scripts (`scripts/e2e-live.ts`, `verify-live.ts`) exist and are **manual-gated, excluded from CI**
  (by design). **NOT re-run** in this audit (real Google account + egress + cost).
- No invented test counts: the numbers above are from this audit's own runs.

## 10. Findings summary (Agent D)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| D-BL-01 | P1 | **36 tracked files fail prettier at HEAD** → CI `format:check` would fail on a fresh clone; drift predates P4-1 (blobs at f07ac1f/90f9619 already failing) | §7, §7.1 |
| D-BL-02 | INFO | `npm test` 515/515 green (128 shared + 357 server + 30 web); typecheck/lint/build green | §1–§4 |
| D-BL-03 | INFO | Conformance C1–C6 PASS (mock level), C7 manual gate NOT RUN (by design) | §5 |
| D-BL-04 | INFO | Both CI secret-scan scripts executed verbatim locally: fixture detected, exit 0 | §6 |
| D-BL-05 | P2 | Docker CI job not verifiable locally (no daemon); image build remains file-reviewed only | §8 |
| D-BL-06 | P3 | No CI run-history evidence available (GitHub network-blocked during audit; GitLab has no runner) — gate-red/green in CI is PARTIALLY-VERIFIED | §7.2 |

## 11. Scratch artifacts used (deleted in STOP gate)

`.nlo-36check.sh` (the 36-file HEAD-drift checker; its embedded list equals §7 verbatim),
`.nlo-scan-extract.sh` + `.nlo-scan-gh.sh` (CI scan-script extractors), `.nlo-t1.md`–`.nlo-t4.md`
(git-blob prettier probes at `f07ac1f`/`90f9619`).
