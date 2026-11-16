# NLO-P4-1 Final Report — Modular Foundations (provider conformance & CI security)

- **Date:** 2026-11-16
- **Branch:** `main` (local; no push, no production deployment — per mission constraints)
- **Commit chain:** `f07ac1f` → `90f9619` → `373440d` → `073637d` → `232b5da`
- **Preflight:** `docs/reports/NLO_P4_1_PREFLIGHT.md`

## 1. Workstreams delivered

| Workstream | Commit                                                                | Scope                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P4-1A**  | `90f9619` `feat(p4-1a): add provider registry and capabilities API`   | Provider registry (`providers/registry.ts`), `GET /api/v1/capabilities`, `providers:read` scope, descriptor derivation from mock + python-worker providers, OpenAPI + docs.                                                                |
| **P4-1B**  | `373440d` `refactor(p4-1b): introduce provider egress gateway`        | `EgressGateway` over `ProxyManager.selectAuto` (`proxy/gateway.ts`), `EgressEndpoint` migration, `DirectEgressBlockedError` fail-closed transport, `tunnelEnv` removed from the provider path; fail-closed semantics preserved and tested. |
| **P4-1C**  | `073637d` `feat(p4-1c): add durable job execution locks`              | `0007_job_locks.sql`, settle-once `JobLocks` (atomic steal-only-expired acquire, owner-only release/refresh, boot `resetAll()` before `recoverInFlight()`), runner integration (acquire at `run()` entry, release in outer `finally`).     |
| **P4-1D**  | `232b5da` `test(p4-1d): enforce provider conformance and security CI` | Conformance suite C1–C6 + runner (this report §2), ESLint module-boundary rules, CI `conformance` + `secret-scan` jobs mirrored in GitHub Actions and `.gitlab-ci.yml`, docs updates.                                                      |

All four workstreams were implemented inline (TDD where behavior was new), each
committed with its exact mission message. No push, no deploy, no
`git reset --hard` / `git clean -fd` / `git push --force` / `git add -A`
(explicit-path staging only).

## 2. Conformance evidence (P4-1D, mock level)

Runner: `npx tsx apps/server/test/conformance/runner.ts` — prints the table and
exits non-zero unless all six suites are PASS. Verbatim final run (exit 0):

```
Provider conformance table (NLO-P4-1D)
provider: notebooklm.web
  C1 declaration lint            PASS
  C2 capability honesty          PASS
  C3 lifecycle                   PASS
  C4 failure classes             PASS
  C5 concurrency                 PASS
  C6 egress boundary             PASS
  C7 live (manual gate)          NOT RUN
result: C1–C6 all PASS (mock level — Live NOT verified; C7 is a manual gate)
```

Suite detail: 6 files / 34 tests (C1×9, C2×14, C3×2, C4×4, C5×1, C6×4),
re-verified green after every fix. C6 highlights: every provider egress call in
a healthy podcast job goes through the tunnel (zero direct dials); a tunnel
killed mid-job fails the job with class `proxy` and the fail-closed error
(F-C3); with no proxy node the job fails **before any** provider egress; a
null endpoint throws `DirectEgressBlockedError`.

**F-C1 (descriptor honesty):** the `notebooklm.web` descriptor declares the
worker's fused operation set — `notebook.create` + `source.add` + `chat.ask`
arrive at the worker as one `job`/`job_text` operation — and C1 lints exactly
that declaration.

**C7 is a manual live gate and was NOT RUN** in this mission (per contract
§4: a provider is `active` only while C1–C6 are green; live verification is
separate, recorded evidence, never CI).

## 3. Final gate evidence (run at the end of the mission, tests ×2)

| Gate                                                                              | Result                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm test` (run **twice**)                                                        | **green both runs** — server 33 files / 357 tests, shared 12 / 128, web 4 / 30                                 |
| `npm run typecheck`                                                               | clean (all workspaces)                                                                                         |
| `npm run lint`                                                                    | clean                                                                                                          |
| `npm run build`                                                                   | green (web vite + server tsc)                                                                                  |
| Conformance runner                                                                | C1–C6 all PASS, exit 0 (§2)                                                                                    |
| Secret-scan (extracted verbatim from `.gitlab-ci.yml`, run against this checkout) | clean; planted-fixture self-test **detected** the planted `vless://` secret; git index left unmodified; exit 0 |
| Prettier on touched files                                                         | applied; all P4-1D-touched files pass `prettier --check`                                                       |

**Honest level of verification: Unit/Integration (in-process, mock provider)
passed. Live NOT verified** — no live run was performed in this mission.

## 4. Secret-scan gate design (CI, both pipelines)

git-grep over `git ls-files` — no new dependency. 8 patterns: PEM private keys,
Google `AIza` keys, `sk-…`, GitHub `ghp_`, Slack `xox…`, `NLO_(API_TOKEN|
VAULT_KEY|JWT_SECRET)=…` in file form, sha256-length hex in TS/JS, and
`vless://<uuid>@<host>`.

Documented allowlist (reviewed in P4-1D):

- `apps/server/scripts/_add-nodes.py` — production node UUID (kept so the
  ops script stays runnable);
- `apps/server/test/api.test.ts` — TEST-NET fixture (203.0.113.x, fake UUID);
- `.github/workflows/ci.yml` + `.gitlab-ci.yml` — the scan's own planted
  fixture line (needed to prove the gate detects secrets).

Self-test: plants `vless://aaaa0000-…@scan-fixture.example:443` in a temp
tracked file, expects detection, removes it, and asserts the index is
unmodified. The GitLab mirror runs the identical script in a
`bash <<'NLO_SECRET_SCAN'` heredoc (GitLab's default shell is dash; the script
uses bash process substitution).

## 5. Rulings ledger (P4-1D)

1. **C1 unknown-op:** `operation` is a `z.enum(PROVIDER_OPERATIONS)`, so an
   unknown op fails the schema before the lint's dedicated check. The test
   asserts the honest contract (the schema error names the unknown op); the
   lint check remains as defense-in-depth for schema-bypassing data.
2. **vless pattern host class:** first self-test run RED — the original
   IP-only host class `[0-9a-fA-F:.]+` cannot match the domain hosts used by
   production nodes (`*.kelmora.ir` etc.). Broadened to `[A-Za-z0-9.-]+` in
   both pipelines; allowlist extended to the two CI files (finding: 3, not 2,
   files contain a vless-UUID URI — the CI files contain their own fixture).
3. **C3 `noUncheckedIndexedAccess`:** bind the rows list + `?.` on the
   element so an empty list still fails the assertion honestly.
4. **Vitest 3 JSON reporter:** file-based (`--outputFile`), per-file `status`
   field — the runner reads/parses/removes the report file.
5. **C6 determinism:** the mid-job tunnel kill flips the runtime scenario to
   `down` inside an egress `request` wrap at `POST /artifacts/generate_audio`
   (no timing race); the no-node case uses zero nodes because `selectAuto`
   self-heals only on `no healthy proxy node available`, while the 0-node
   message rethrows straight to the gateway error.
6. **Lint gate scope:** module-boundary rules use the `regex` field (globs
   mis-group `test` vs `src` in this layout) — verified with
   `--inspect-config` and a RED→GREEN probe.

## 6. Known limitations & pre-existing issues (honest)

- **36 files fail `prettier --check` at HEAD** — verified by extracting the
  HEAD blobs of two flagged files and checking them: the drift predates this
  mission (likely a prettier minor-version bump, 3.6 → 3.9.10 in
  `package-lock.json`). This mission formatted only the files it touched
  (per the no-unrelated-changes rule). Suggested follow-up: one repo-wide
  `prettier --write` commit, explicitly approved.
- **F-B1 libuv Windows flake** — known pre-existing test-flakiness source on
  Windows (does not affect the green runs above).
- **GitLab mirror is NOT active** — no runner registered for the project
  (provisioning requires maintainer approval, `docs/operations/gitlab-sync.md`);
  the pipeline mirrors GitHub CI exactly and will gate once a runner exists.
- **Secret-scan vless pattern** matches UUID-shaped `vless://` URIs only
  (documented scope; non-UUID vless forms are out of scope).
- **OpenAPI drift:** no API contract changed in P4-1D (test/lint/CI only), so
  no spec update was required; the `openapi-v1` suite (30 tests) is green.

## 7. DO-NOT-CHANGE compliance

Untouched in P4-1D (and throughout P4-1 where protected): `db/db.ts`,
`domain/stages.repo.ts`, `domain/artifact-validate.ts`, `jobs.repo.ts`
(`recoverInFlight` semantics), `secrets/vault.ts`, `webhooks/dispatcher.ts`,
`media/transcode.ts`, `main.ts`, `queue/queue.ts`, `providers/python-worker/
protocol.ts` + `nbl_worker.py` + `worker.ts`, `proxy/proxy-manager.ts`,
`proxy/runtime.ts`, `packages/shared/src/job-state.ts`, and the two P3
Batch 3 untracked reports (byte-identical; sha256 recorded at the gate:
`NLO_P3_BATCH3_BACKUP_ROLLBACK.md`
`bb37d23eea1fb69610319455040b9821d30a8684e7f52729326d30e6e6b89cb0`,
`NLO_P3_BATCH3_REBASELINE.md`
`a9db089b1d91a8b4bf14ed76edfd9bb8b08b66665630334ba6f337b65d259a2a`).

The only runtime-code changes in P4-1D are the type re-exports in
`proxy/gateway.ts` and the import consolidation in `queue/job-runner.ts`
(both outside the protected list; behavior-neutral, covered by the full
green test suite).

## 8. Rollback (per spec)

P4-1D: "test files + lint rules + CI config revert cleanly; no runtime code"
— `git revert 232b5da` restores the pre-P4-1D state with zero runtime impact.
P4-1A/B/C each have their own additive rollbacks as documented in their
CHANGELOG entries.

## 9. Remaining work (owner decisions)

1. Run the **C7 live conformance gate** when a live account + proxy window is
   available (manual; recorded evidence required before any "live-verified"
   claim).
2. Approve a **repo-wide prettier commit** for the 36 drifted files (§6).
3. **P4-2** (next roadmap workstream) — not started, per mission stop rule.
4. GitLab runner provisioning (enables the mirrored pipeline).

---

**Status: `NLO_P4_1_IMPLEMENTATION_COMPLETE — WAITING_FOR_OWNER_REVIEW`**
