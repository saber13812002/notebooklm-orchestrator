# Phase B — Engineering Governance & Productization Baseline (Report)

Date: 2026-10-27 (UTC)
Baseline at start: `main` @ `87e57f1` (user-committed Phase A report), tree clean,
in sync with `origin/main` (GitHub verified from s52: `git ls-remote`).
Target at end: this report's commit (see §2).
Status: **complete, pending push** (push mechanics in §7).

## 1. Mission recap

Phase B scope (per user instruction "Start Phase B now. Complete only this
phase and report + get approval before Phase C"):

1. Repository governance files: `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`,
   `CHANGELOG.md` — permanent rules, not a one-phase checklist.
2. README completed to the real project state; docs reorganized without
   duplicates; Phase A report preserved.
3. CI: GitHub Actions first; `.gitlab-ci.yml` **ready** but no runner or
   infrastructure change without permission.
4. GitLab `git.ai.ismc.ir`: without credentials, document the repo-creation
   procedure + minimum-scope token request; never store tokens in the repo.
5. Wiki.js: customer docs as Markdown in the repo; auto-publish only with
   authorized credentials.
6. Quality gate before commit (tests, build, typecheck), git change review,
   no secrets.
7. Logical, reviewable commits; push only after checks; **no production
   restart** for docs-only changes; this report.

Explicit non-goals honored: no `/api/v1`, no new auth, no webhooks, no new
NotebookLM features, no OpenAPI (all Phase C or later).

## 2. Commits (logical, reviewable)

| #   | SHA           | Commit                                                                                   | Scope                                                                                               |
| --- | ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0   | `57b9195`     | "md files" (user commit, pre-existing at start of this session)                          | docs/ restructure renames (7 `git mv`)                                                              |
| 1   | `ef43480`     | chore: normalize line endings to LF (gitattributes) + prettier baseline                  | `.gitattributes` + formatting of pre-existing files                                                 |
| 2   | `eddbd1d`     | docs: update references after docs/ restructure                                          | 7 reference fixes (Dockerfile, compose, deploy.sh, quick-start, P3 report, 3 code comment pointers) |
| 3   | `60b4a3f`     | docs(governance): add AGENTS/CONTRIBUTING/SECURITY/CHANGELOG; rewrite README             | governance baseline + product README                                                                |
| 4   | `f12abf1`     | docs(customer): add Wiki.js customer docs (14 pages) + api/testing/operations topic docs | customer documentation source                                                                       |
| 5   | `1dd5233`     | ci: add GitHub Actions pipeline + ready .gitlab-ci.yml mirror                            | CI only, no infra changes                                                                           |
| 6   | (this commit) | docs(reports): Phase B report                                                            | this file                                                                                           |

Docs restructure (commit 0, user-made with my `git mv` staging) created:
`docs/architecture/` (overview, proxy-design, provider-evaluation),
`docs/development/` (quick-start, plan), `docs/deployment/s52-deploy.md`,
`docs/security/threat-model.md`. No content was duplicated; Phase A report
preserved at `docs/reports/PHASE_A_AUDIT.md`.

## 3. New/changed files (by purpose)

**Governance (new):**

- `AGENTS.md` — 10 sections of permanent rules: operational protection
  (inspect local + s52 state before changes; ask don't guess), dual-repo
  policy (GitHub source of truth, one-way mirror to GitLab, no secrets ever),
  per-change standards (goal/scope, arch compatibility, proportional tests,
  docs, OpenAPI sync, deploy review, no destructive changes), API-first
  architecture rules, mandatory testing with honest status levels,
  documentation rules, security invariants, deployment rules (git-based,
  `data/` survives), phase discipline (approval gates), pre-commit checklist.
- `CONTRIBUTING.md` — branch/PR flow, Conventional Commits, quality-gate
  commands, no-secrets rule, deploy by maintainers only, live-mode manual gate.
- `SECURITY.md` — current trust model (loopback, single-user, **no API
  auth** — stated honestly), 8 invariants (no secrets in repo/logs/images;
  loopback default; upload validation + safe names; SSRF guard; 0700
  sessions; 0600 vault key; "internal ≠ authorized"), private vulnerability
  reporting, accepted risks.
- `CHANGELOG.md` — Keep a Changelog; `Unreleased` entries for this phase with
  explicit "no API changes"; historical entries P1–P3.

**Product docs (changed/new):**

- `README.md` — rewritten to real state: architecture, prerequisites table,
  full env-var table (all `NLO_*` from `.env.example`), tests section, s52
  deployment section, full API endpoint table, **honest feature-status table**
  (live-verified / tested / planned), docs links to new structure. All
  original content preserved.
- `docs/api/README.md` — no OpenAPI yet; contract = route code + `api.test.ts`;
  Phase C plan (openapi.json, /api/docs, /api/v1, tokens, webhooks, SDK).
- `docs/testing/README.md` — test-level matrix (Unit / Feature / E2E-mock /
  Live), commands, CI note, live-verification procedure.
- `docs/operations/README.md` — day-2 operations (health, journal, deploy,
  rollback, DB restore, backups), s52 runtime specifics.
- `docs/operations/gitlab-sync.md` — GitLab mirror: verified facts (evidence
  table), minimum-scope token request (`api` scope, short expiry), one-time
  setup procedure using `$GITLAB_TOKEN` placeholder (never a real token),
  one-way mirror rules, CI coordination, verification checklist, explicit
  out-of-scope list (no runners in Phase B).
- `docs/wiki/` (15 new files) — customer documentation source for Wiki.js:
  README (page map + writing rules) + 14 Persian pages (service intro, quick
  start, jobs, files/sources, prompts/language, processing status, outputs,
  API auth, API guide with real cURL examples, webhook = explicitly planned,
  common errors, limits/capabilities, developer guide, deployment/operations).
  All statuses honest; all examples use verified routes; no secrets.

**CI (new):**

- `.github/workflows/ci.yml` — quality stage (lint → format:check → typecheck
  → test → build on Node 22) + docker stage (image build + container health
  smoke test, **no push** — images are not part of the deploy path).
  Live scripts deliberately excluded (real accounts, real cost).
- `.gitlab-ci.yml` — mirrors the GitHub pipeline (quality on node 22; docker
  stage gated behind `BUILD_DOCKER=1`). **Ready, not active** — no runner
  exists for this project; none was created (infrastructure changes are
  out of Phase B scope).

**Tooling (new):**

- `.gitattributes` — `* text=auto eol=lf` (see §5).

## 4. Quality gate results (run on the final tree, before push)

| Gate                               | Result                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`             | **PASS** (all files, after §5 fix)                                                                                                                                                                |
| `npm run lint`                     | **PASS**                                                                                                                                                                                          |
| `npm run typecheck` (3 workspaces) | **PASS**                                                                                                                                                                                          |
| `npm test`                         | **PASS** — server 59/59, web 25/25, shared 44/44 = **128/128** (baseline unchanged, no regression)                                                                                                |
| `npm run build`                    | **PASS** (web bundle + server typecheck)                                                                                                                                                          |
| Secret scan of staged diff         | **PASS** — no tokens/UUIDs/keys; one near-miss caught and sanitized (see §5.3)                                                                                                                    |
| `git status` (staged)              | no runtime/secret files; `data/`, `.env`, `dist/` all git-ignored                                                                                                                                 |
| s52 live check (pre-push)          | `nlo` **active**, `/api/health` ok, `/api/health/ready` ready:true (python-worker configured, xray available), `deployed-commit` = `80a9e66` **unchanged** (no restart, no deploy — docs/CI only) |

Verification level (honest): **Unit/Integration/E2E-mock passed.** No live
NotebookLM run was performed in Phase B (not needed — zero runtime changes).
The GitHub Actions pipeline itself has not run yet (needs the push, §7).

## 5. Errors encountered and fixed (full disclosure)

### 5.1 Pre-existing format gate failure (discovered, root-caused, fixed)

`npm run format:check` failed on **141 files** — including files I had never
touched. Root cause: the repo had no `.gitattributes` and this Windows
workstation uses `core.autocrlf=true`, so working trees were CRLF while
prettier (default `endOfLine: lf`) requires LF. Blobs in git were LF
(`git ls-files --eol` → `i/lf w/crlf`), so Linux checkouts passed and Windows
checkouts failed — the gate had never actually run green here.
Fix: `.gitattributes` with `* text=auto eol=lf` (+ explicit LF for deploy
scripts/systemd unit, `binary` for assets) and a one-time working-tree
normalization. Cross-platform, no per-machine config needed.

### 5.2 Double-encoding regression introduced by my own script, detected and fully repaired

The CRLF normalizer script (first version) had a Node encoding bug: it read
bytes with `toString("binary")` (latin-1 view) and wrote them back with UTF-8,
double-encoding every non-ASCII file (Persian text became Latin-1 mojibake).
Detected **before any commit** when the staged diff showed symmetric ±200-line
changes in files I had never edited (`git diff` showed `Ø­Ø³Ø§Ø¨...`).
Repair: exact inverse transform (utf8-decode → latin1-encode restores the
original bytes bit-for-bit; detection = post-UTF8-decode codepoints all ≤
U+00FF, which real Persian UTF-8 can never satisfy). 120 files repaired;
post-repair diff vs HEAD contains **only** the intended Phase B changes;
128/128 tests + typecheck re-run green. 13 `apps/web/dist/**` artifacts were
flagged as anomalies — they are git-ignored build output and were regenerated
by `npm run build`.

### 5.3 Secret near-miss caught by the staged-diff scan

`docs/wiki/09-api-guide.md` contained a cURL example with a VLESS URI path
fragment (`path=%2Fdownload%2Fli`) matching a real node path found in
git-ignored runtime data (`data/tmp/p2-setup-proxy.sh`). Replaced with a fully
generic placeholder (`vless://<uuid>@<node-host>:443?...&path=%2F<ws-path>&sni=<sni>`).
`data/` is git-ignored and was verified not staged (`git check-ignore` +
`git status` review).

### 5.4 Pre-existing (not caused by Phase B, not fixed here)

- The repo's committed code was **never prettier-formatted** (24 files had
  style violations at HEAD). Fixed in commit 1 with `prettier --write`;
  verified the code changes are line-wrap/trailing-comma only via `-w` diffs
  (e.g. `job-runner.ts`, `runtime.ts`, `python-worker-provider.ts`,
  `job-lifecycle.test.ts`).
- `package.json` `allowScripts` (esbuild) — noted for the record; not changed.

## 6. Credential-dependent work (documented, not bypassed)

| Item                                          | State                                                                                                                                                                                                                                                                                                                                                             | What is needed                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| GitLab project `git.ai.ismc.ir`               | Instance verified (CE 16.3.9, container on s52, `https://git.ai.ismc.ir` → 172.20.1.52, sign-in 200, API 401, **no NLO project, no credentials on either host**). Procedure + minimum-scope token request (`api` scope, 30–90 d) documented in `docs/operations/gitlab-sync.md`. Token will be used only interactively / as masked CI variable — never committed. | **PAT with `api` scope** for the maintainer account                   |
| Wiki.js publish (`docs.ai.ismc.ir`, s52:8888) | All 14 customer pages written as repo source with page map. Auto-publish requires the Wiki.js API.                                                                                                                                                                                                                                                                | **Wiki.js local account with API enabled** (Phase E executes publish) |
| GitHub Actions run                            | Workflow committed; runs automatically **after push** (§7).                                                                                                                                                                                                                                                                                                       | (push itself)                                                         |

## 7. Push plan (pre-push checks passed)

Checks done: working tree clean; 5 logical commits on `main`; branch = `main`;
`origin` = `github.com/saber13812002/notebooklm-orchestrator`; s52 service
active/ready and `deployed-commit` unchanged (docs-only phase → **no deploy,
no restart**, per mission).

Known network constraint (from Phase A): the Windows workstation cannot reach
`github.com:443`. Push path: try direct push from the workstation; if
blocked, `git bundle` → scp to s52 → fast-forward push from s52 (s52 already
has a working GitHub credential for `origin`, proven by `deploy/deploy.sh`
fetching `origin`). The mirror push to GitLab happens only after the token
exists (§6).

## 8. Remaining limitations / next phase input

- GitHub Actions pipeline not yet executed (first run = after push).
- GitLab: no project, no runner, no token — all documented, zero infra changes.
- Wiki.js: pages written, not published (no API credentials).
- No OpenAPI, no `/api/v1`, no token auth, no webhooks, no domain/TLS —
  explicitly deferred (Phase C and later).
- CI secret-scan is documented as a hard gate but not yet implemented as a
  workflow step (candidate for Phase C alongside OpenAPI).

## 9. Evidence index

- Commits: `git log --oneline 57b9195..HEAD`
- Gate runs: format/lint/typecheck/test/build outputs of this session (all PASS;
  128/128 tests).
- s52: `systemctl is-active nlo` → active; `/api/health` → ok;
  `/api/health/ready` → ready:true; `data/deployed-commit` → `80a9e66`
  (unchanged).
- Phase A audit (baseline): `docs/reports/PHASE_A_AUDIT.md`.
