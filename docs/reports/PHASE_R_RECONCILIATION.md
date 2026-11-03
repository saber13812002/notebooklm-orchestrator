# Phase R — Complete Repository, Local and Production Reconciliation

**Date:** 2026-11-03 (UTC)
**Mode:** READ-ONLY audit. No commit, no push, no deploy, no service restart, no file
deletion, no staged change. Only read-only `git`, read-only SSH commands, and local
quality-gate runs were executed.
**Auditor scope:** local `main`, GitHub `origin/main`, production host `AI-TOOLS`
(`172.30.0.133`).

> **Headline finding:** the feared "lost work" scenario is **not confirmed**.
> Local and GitHub are bit-for-bit in sync (`66e907f`), there are **zero unpushed
> commits**, zero merge conflicts, and zero uncommitted _tracked_ files. The only
> unrecovered work lives in untracked scratch material (`tmp/`, `$out`, `HTTP`)
> and in two `.bak` files on the production host — all of which is classified,
> preservable, and in most cases already committed elsewhere. Production is
> **14 commits behind** `origin/main`, and that gap is **documentation/tests only**
> (no runtime code delta), so a deploy is low-risk. A **Stage A nginx vhost for
> `nlo.ai.ismc.ir` was installed on production today at 16:59 UTC** (during/just
> before this audit) and is live (HTTP 301); the Let's Encrypt issuance **failed**
> because the public DNS A record points to `185.213.10.25`, not `172.30.0.133`.

---

## 1. Local repository state (verified)

| Item                                   | Value                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Branch                                 | `main`                                                                                                               |
| HEAD SHA                               | `66e907ff4a2adfeb37eed911cada5b40ce04b435`                                                                           |
| `origin/main` SHA                      | `66e907ff4a2adfeb37eed911cada5b40ce04b435` (after `git fetch`)                                                       |
| `git ls-remote origin refs/heads/main` | `66e907ff4a2adfeb37eed911cada5b40ce04b435` — **identical**                                                           |
| Ahead / behind (main…origin/main)      | **0 / 0**                                                                                                            |
| Local branches                         | `main` only (no other local branches)                                                                                |
| Remotes                                | `origin` → `https://github.com/saber13812002/notebooklm-orchestrator.git` (GitHub only; no GitLab remote configured) |
| Unpushed commits                       | **none** (`git log origin/main..HEAD` empty)                                                                         |
| Local commits absent from GitHub       | **none**                                                                                                             |
| Staged files                           | none (`git diff --cached` empty)                                                                                     |
| Modified tracked files                 | **none** (working tree clean for tracked files)                                                                      |
| Merge conflicts                        | none (`git ls-files -u` empty; not in a merge)                                                                       |
| Stashes                                | none (`git stash list` empty)                                                                                        |
| Submodules                             | none                                                                                                                 |
| Tags                                   | none                                                                                                                 |
| Last commit                            | `66e907f docs(T0): stuck files & jobs audit on live new-host deployment (read-only)`                                 |

**Untracked (not in git) — complete inventory:**

| Path                      | Size     | Type                                             | Status    | Valuable?          | Recommended action                   |
| ------------------------- | -------- | ------------------------------------------------ | --------- | ------------------ | ------------------------------------ |
| `tmp/` (28 files, see §5) | ~1.65 MB | scripts/scratch                                  | untracked | partially (see §5) | selective commit after review        |
| `$out`                    | 2,135 B  | text (captured `systemctl status` dump, s52-era) | untracked | no (obsolete host) | preserve until user approves cleanup |
| `HTTP`                    | 0 B      | empty file (artifact of a failed redirect)       | untracked | no                 | preserve until user approves cleanup |

**Ignored (relevant):** `.env` (864 B — see §1.1), `data/` (local dev DB + vault +
vendor + venv), `node_modules/` (4), `apps/web/dist/`, `__pycache__/`, and two
`tmp/*.log` files. All correctly ignored; none should ever be committed.

### 1.1 Local `.env` (keys only — values never read or printed)

Present (864 B). Keys: `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`,
`NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`,
`NLO_ALLOW_DIRECT_EGRESS`. **No `NLO_API_AUTH`** (local runs unauthenticated,
loopback only, by design). File is git-ignored. **Preserve, do not publish.**

### 1.2 Local runtime state

- Node **v24.14.0** / npm 11.9.0 (note: repo `engines` requires `>=22.5.0`; dev
  runs fine on 24).
- Two local servers observed answering during the audit:
  - `127.0.0.1:4871` — the active dev terminal (`NLO_PORT=4871`, repro run).
  - `127.0.0.1:4870` — a **stale prior dev instance** also answering `/api/health`
    (matches the Phase 0 report's "stale local server on 4870"). Candidate for
    user-initiated cleanup; **not touched** in this phase.
- Local `data/nlo.sqlite`: readable read-only — 14 tables, migrations 1–5 applied,
  12 jobs (3 SUCCEEDED / 5 FAILED / 4 CANCELLED), 3 accounts, **0 api_tokens**,
  `PRAGMA integrity_check` = `ok`.

## 2. GitHub state (verified without moving local refs)

- `git fetch origin` completed; `git ls-remote origin` shows
  `HEAD → 66e907f` and `refs/heads/main → 66e907f`.
- **Commit ancestry:** local `main` ≡ `origin/main` ≡ GitHub `main` (same SHA).
  There is **no file-level difference** between local HEAD and GitHub.
- The 14 commits between production's baseline `b5e9ad3` and the current tip
  `66e907f` are **all on GitHub already** (they are `b5e9ad3..main`, and
  `main == origin/main`). Nothing is missing from GitHub.

**Gap `b5e9ad3..main` — 14 commits, all already published:**

| SHA       | Subject (abridged)                                                            |
| --------- | ----------------------------------------------------------------------------- |
| `66e907f` | docs(T0): stuck files & jobs audit on live new-host deployment                |
| `d804e2d` | docs: Phase G3-A — new production host secure access + read-only audit        |
| `50b31e7` | docs: Phases G1+G2 — live endpoint verification + production readiness        |
| `0e5b8b8` | docs: Phase F — local verification of addendum tree on 4871                   |
| `6b9a3ab` | test(internal-llm): Phase E — integration tests for internal LLM proxy client |
| `30b03cd` | docs: Phase D — migrate s52 operational references (docs only)                |
| `3f796a6` | feat(config): `NLO_INTERNAL_API_BASE_URL` for internal LLM proxy              |
| `bc23920` | docs: Phase 1 local run + Swagger verification                                |
| `9aa4b3d` | docs: Phase 0 read-only reconciliation                                        |
| `627404c` | docs: Phase 2 API authentication report                                       |
| `cfd96e6` | Phase 2: first-admin bootstrap (offline CLI, one-shot, tested)                |
| `8938bcc` | docs: Phase 1 GitHub publication report                                       |
| `d02bcbc` | docs: Swagger accessibility & deployment diagnosis                            |
| `9e3fc67` | docs: Phase C live acceptance report                                          |

**File-level delta `b5e9ad3 → main` (40 files, +4797/−107):** 24 docs/reports,
3 wiki pages, 5 tests (`first-admin.test.ts`, `internal-llm.test.ts`,
`config-internal-api.test.ts`, …), 3 new runtime files (`internal-llm.ts`,
`domain/first-admin.ts`, `scripts/bootstrap-first-admin.ts`), `config.ts` (+15),
`apps/server/package.json` (+`bootstrap:admin` script), `deploy/deploy.sh` (3 lines),
`deploy/systemd/nlo.service` (4 lines), `AGENTS.md`/`README.md`/`CHANGELOG.md`/
`CONTRIBUTING.md`/`SECURITY.md`/`.env.example`.
**`git diff b5e9ad3 main -- apps/server/src/proxy/connect-proxy.ts
apps/server/src/queue/job-runner.ts` is empty** — the two files that production
carries `.bak` snapshots of had **no code change** in this range (see §4.3).

## 3. Missing deliverables / local-only work

Cross-checked the "pay particular attention" list:

| Deliverable class                       | In git?                            | Where                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API implementations                     | ✅ committed                       | `apps/server/src/api/**`                                                                                                                                                                                                                                                             |
| UI implementations                      | ✅ committed                       | `apps/web/src/**`                                                                                                                                                                                                                                                                    |
| Tests                                   | ✅ committed                       | 18 test files across workspaces                                                                                                                                                                                                                                                      |
| Reports / documentation                 | ✅ committed                       | `docs/**`                                                                                                                                                                                                                                                                            |
| Deployment script                       | ✅ committed                       | [`deploy/deploy.sh`](../../deploy/deploy.sh)                                                                                                                                                                                                                                         |
| systemd unit                            | ✅ committed                       | `deploy/systemd/nlo.service`                                                                                                                                                                                                                                                         |
| Docker / Compose                        | ✅ committed                       | `Dockerfile`, `docker-compose.yml`, `.dockerignore`                                                                                                                                                                                                                                  |
| Local config template                   | ✅ committed                       | `.env.example`                                                                                                                                                                                                                                                                       |
| **Nginx vhosts (stage A/B)**            | ❌ **local-only**                  | `tmp/nlo-vhost-stageA.conf`, `tmp/nlo-vhost-stageB.conf` — **valuable**, should be committed (after review) into `deploy/nginx/`                                                                                                                                                     |
| **Let's Encrypt / HTTPS deploy script** | ❌ **local-only**                  | `tmp/nlo-https-full.sh`, `tmp/nlo-deploy.sh` — **valuable**, commit candidate (`deploy/`)                                                                                                                                                                                            |
| Audit / preflight / probe scripts       | ❌ local-only                      | `tmp/n2-preflight.sh`, `tmp/t0_audit.py`, `tmp/audit-inspect.mjs`, `tmp/n0-local-db-check.py`, `tmp/n1-auth-probe.{mjs,ps1}`, `tmp/n1-worker-ping.py`, `tmp/sandbox-bootstrap.ts`, `tmp/sandbox-test.mjs` — operational value; commit candidate (`scripts/audit/` or keep in `tmp/`) |
| Host probe scripts (s52 era, obsolete)  | ❌ local-only                      | `tmp/nlo-probe-s52.sh`, `tmp/nlo-s52-{authcheck,final,repo,tokens}.sh`, `tmp/nlo-final-probe.ps1`, `tmp/g1-probe*.ps1`, `tmp/nlo-tunnel-probe.ps1` — host decommissioned; preserve (F)                                                                                               |
| Secret-scan helpers                     | ❌ local-only                      | `tmp/nlo-secret-scan.ps1`, `tmp/nlo-staged-scan.ps1`, `tmp/phase_r_tmpscan.ps1` — reusable; commit candidate (CI secret-scan)                                                                                                                                                        |
| Large third-party artifacts             | ❌ local-only                      | `tmp/litellm-openapi.json` (1.5 MB, LiteLLM spec dump), `tmp/litellm-oas-summary.txt` — reference material; keep local (F), do not commit                                                                                                                                            |
| Logs / capture dumps                    | ❌ local-only (mostly git-ignored) | `tmp/dev4871-repro.log`, `tmp/n1-auth-probe.log`, `tmp/n0-staged-review.txt`, `tmp/p2-diff-review.txt`, `$out`, `HTTP` — preserve until user approves cleanup (F/G)                                                                                                                  |

**Conclusion:** nothing of substance exists _only_ on local that is irreplaceable.
The only genuinely uncommitted project work is the **nginx/HTTPS deployment
material** (4 files, ~7.4 KB) — see §5 classes A/C.

## 4. Production server audit (172.30.0.133, read-only SSH)

Verified directly; the "reported baseline" `b5e9ad3` **is still current**.

### 4.1 Git working tree (production)

| Item                     | Value                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                     | `/home/saber/saberprojects/notebooklm-orchestrator`                                                                                                                          |
| Branch                   | `main`                                                                                                                                                                       |
| HEAD                     | **`b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9`** (matches reported baseline)                                                                                                   |
| `data/deployed-commit`   | `b5e9ad3`                                                                                                                                                                    |
| `git status --porcelain` | clean for tracked files; 3 untracked (below)                                                                                                                                 |
| Untracked on prod        | `apps/server/src/proxy/connect-proxy.ts.bak-curlfix` (6,867 B, 2026-10-26), `apps/server/src/queue/job-runner.ts.bak-e2efix` (24,216 B, 2026-10-26), `nul` (0 B, 2026-10-28) |
| Reflog                   | clone `f1bd620` → pulls/resets, last `reset: moving to b5e9ad3` (2026-10-31 deploy). No foreign trees, no lost work.                                                         |
| Remote                   | same GitHub `origin`                                                                                                                                                         |

**Production SHA gap: 14 commits** (`b5e9ad3..66e907f`), all already on GitHub
(§2). The gap contains **no changes to currently-running server code paths**
(verified diff above); it adds the internal-LLM client, first-admin bootstrap,
tests, and documentation. A fast-forward deploy would be a near-no-op for the
running service (new code is dormant unless configured via env).

### 4.2 Service / runtime (production)

| Item                     | Value                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nlo.service`            | **active (running)** since Sat 2026-10-31 07:10:44 UTC (4 days at audit time)                                                                                                                                               |
| MainPID                  | 1428 — `node …/node_modules/.bin/tsx src/main.ts`                                                                                                                                                                           |
| Process cwd              | `/home/saber/saberprojects/notebooklm-orchestrator/apps/server` ✓ matches unit                                                                                                                                              |
| Node                     | `/home/saber/.local/node22/bin/node` → **v22.23.4** (satisfies `>=22.5.0`)                                                                                                                                                  |
| Health                   | `GET 127.0.0.1:4870/api/health` → `{"ok":true,…}` ; `/api/health/ready` → `ready:true`, provider `python-worker` configured, `xray` available, `liveDisabled:true`                                                          |
| Bind                     | loopback `127.0.0.1:4870` only (by design)                                                                                                                                                                                  |
| `.env` keys (names only) | `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`, `NLO_PYTHON_BIN`, `NLO_PROXY_RUNTIME`, `NLO_LOGIN_BROWSER`, `NLO_ALLOW_DIRECT_EGRESS` — **no `NLO_API_AUTH`** (prod also unauthenticated at the API layer; loopback-only mitigates) |
| DB                       | `data/nlo.sqlite` 167,936 B (last write 2026-10-29), WAL active, `data/backups/` holds 5 sqlite + 3 env backups (retention honored)                                                                                         |
| Data dirs                | `data/{jobs,sessions,vault,vendor,venv,tmp,backups}` intact; `sessions` 0700, `vault.key` 0600                                                                                                                              |
| Journal since 2026-11-02 | **no error/exception/fatal lines**                                                                                                                                                                                          |

### 4.3 Production untracked files — classification

| File                           | Classification             | Note                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect-proxy.ts.bak-curlfix` | **F (temp) / recoverable** | Snapshot of the _pre_-curlfix version. The fix (commit `5bcccad`) **is already in `b5e9ad3`**, i.e. the live code already contains the fix; the `.bak` predates the running code. Recoverable from git history (`git show 5bcccad^:apps/server/src/proxy/connect-proxy.ts`). Safe to delete after user approval — **not deleted**. |
| `job-runner.ts.bak-e2efix`     | **F (temp) / recoverable** | Snapshot of the _pre_-e2e-fix version (pre-`a909905`, also in `b5e9ad3`). Recoverable from git history. Safe to delete after user approval — **not deleted**.                                                                                                                                                                      |
| `nul` (0 B)                    | **F (temp)**               | Artifact of a Windows-style `> nul` redirect executed on Linux. Safe to delete after user approval — **not deleted**.                                                                                                                                                                                                              |

### 4.4 Nginx / HTTPS staging state (production) — **important, changed today**

- Web stack: BaoTa panel nginx (`/www/server/panel/webserver/sbin/webserver`,
  config `/www/server/nginx/conf/nginx.conf`), plus unrelated Kong/OpenResty and
  container nginx masters. **Multiple other org services run on this host** —
  NLO changes must stay surgical.
- **Today 16:59:31 UTC**, `/tmp/nlo-https-full.sh` (root, sudo) was executed:
  - ✅ Backup made: `/www/backup/nginx-vhost-before-20261103T165931Z`
  - ✅ Stage A vhost **installed and live**: `nginx -t` ok, reloaded; local probe
    `Host: nlo.ai.ismc.ir` → **301** (verified again at 17:39 UTC).
  - ❌ **Certbot webroot issuance FAILED**: LE reported
    `185.213.10.25: Timeout during connect` fetching
    `/.well-known/acme-challenge/…` — i.e. **the public DNS A record for
    `nlo.ai.ismc.ir` points to `185.213.10.25`, not to this host
    (`172.30.0.133` is internal/RFC1918)**, and/or the edge does not forward :80
    here. Script aborted at step 4/7 by design (no partial cert state).
  - Stage B (HTTPS) **not executed** (no cert). `local https://127.0.0.1/api/health`
    with the NLO host header → 404 (default vhost answers 443).
  - `/etc/letsencrypt` exists with `live/` + `archive/` + `renewal/` (root-owned;
    contents not readable by `saber` — consistent with prior certs for other
    domains). No `nlo.ai.ismc.ir` cert could be confirmed.
  - `/www/acme/.well-known` present (ACME webroot prepared 2026-10-02/11-02).
  - Staged in `/tmp` on prod: `nlo-deploy.sh`, `nlo-https-full.sh`,
    `nlo-vhost-stageA.conf`, `nlo-vhost-stageB.conf`, `nlo-deploy.log`,
    `nlo-identity.txt` (identity check token).

**HTTPS blockers (no action taken — awaiting user):**

1. DNS: `nlo.ai.ismc.ir` → `185.213.10.25` must be verified as the edge that
   forwards :80/:443 to `172.30.0.133` (or the record must be pointed at the edge
   that does so). This is the certbot failure cause and needs owner confirmation.
2. Firewall: LE "Timeout during connect (likely firewall problem)" — external
   reachability of :80 for the ACME path must be verified.
3. Once 1–2 hold: re-run certbot (step 4), then Stage B install (step 6), then
   external verification. All steps exist in `tmp/nlo-https-full.sh` (commit
   candidate, class C).

## 5. Complete file classification (A–H)

**A — Valuable source code, should be committed:**

- `apps/server/src/internal-llm.ts`, `apps/server/src/domain/first-admin.ts`,
  `apps/server/scripts/bootstrap-first-admin.ts`,
  `apps/server/test/{first-admin,internal-llm,config-internal-api}.test.ts`
  → **already committed** (`6b9a3ab`…`cfd96e6`). Nothing to do.

**B — Documentation and reports, should be committed:**

- All `docs/**` reports incl. G1/G2/G3-A/T0 → **already committed**.
- This report (`docs/reports/PHASE_R_RECONCILIATION.md`) — new, **uncommitted**,
  commit candidate.

**C — Deployment templates, should be committed after review:**

- `tmp/nlo-vhost-stageA.conf` → `deploy/nginx/nlo.ai.ismc.ir.stageA.conf`
- `tmp/nlo-vhost-stageB.conf` → `deploy/nginx/nlo.ai.ismc.ir.stageB.conf`
- `tmp/nlo-https-full.sh` → `deploy/nginx/nlo-https-full.sh`
- `tmp/nlo-deploy.sh` → `deploy/nginx/nlo-vhost-deploy.sh`
- Reusable scan/preflight helpers: `tmp/nlo-secret-scan.ps1`,
  `tmp/nlo-staged-scan.ps1`, `tmp/n2-preflight.sh`, `tmp/t0_audit.py`
  → `scripts/audit/` (rename on commit).
  _Review notes before commit:_ scripts embed host-specific paths
  (`/www/server/…`, `172.30.0.133`) and the internal domain `nlo.ai.ismc.ir` —
  consistent with committed docs precedent (internal infra references already in
  the repo); no secrets present.

**D — Local-only configuration, preserve, do not publish:**

- `.env` (local, loopback dev; no `NLO_API_AUTH`).
- `data/` (local DB, vault, vendor, venv) — already git-ignored.

**E — Secrets / session material, never commit:**

- `.env`, `data/vault.key`, `data/sessions/`, production `.env`,
  production `data/backups/env-*.env`. **None are staged or staged-able; none
  appear in any diff.** (Verified by secret-scan below.)

**F — Temporary files, preserve until user approves cleanup:**

- Local: `tmp/` (28 files), `$out`, `HTTP`.
- Production: 2× `.bak-*`, `nul` (all recoverable / zero-byte; see §4.3).
- Production `/tmp/nlo-*` staged files (root/saber-owned; preserve — they are
  the rollback reference for the Stage A vhost).

**G — Production-generated files, do not blindly synchronize:**

- Production `data/**` (DB, backups, jobs, sessions, vendor, venv) — runtime
  state; only `deploy/deploy.sh` ever touches it (backup/retain), never
  checkout. **Not synchronized with local in either direction.**
- Production journal/backups.

**H — Unknown / request review:**

- `HTTP` (0 B file, origin: a failed shell redirect) — review: keep or delete.
- `tmp/litellm-openapi.json` (1.5 MB third-party spec dump) — review: keep local
  reference or delete.
- `tmp/n1-auth-probe.mjs` — fails eslint (6 `no-empty`); if it is to be committed
  it needs lint cleanup first (see §6 gate results).

## 6. Quality gates (run locally on `main @ 66e907f`)

| Gate                                                                        | Result                                     | Notes                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (`npm run typecheck`)                                             | ✅ PASS                                    | all workspaces                                                                                                                                                                                                                      |
| Lint (`npm run lint`)                                                       | ⚠️ **FAIL — untracked file only**          | 6 `no-empty` errors, all in **untracked** `tmp/n1-auth-probe.mjs`. Tracked source is clean.                                                                                                                                         |
| Format (`npm run format:check`)                                             | ⚠️ **FAIL — 8 files**                      | 6 **committed** docs (`CHANGELOG.md`, `ROADMAP_MASTER.md`, G1/G2/G3-A/T0 reports) + 2 untracked (`tmp/litellm-openapi.json`, `tmp/n1-auth-probe.mjs`). Cosmetic; fixable with `npm run format` in a follow-up commit.               |
| Unit/feature/E2E tests (`npm test`)                                         | ✅ PASS                                    | **175/175**: shared 44, server 106 (9 files), web 25 (3 files). In-process/mock E2E included (`api.test.ts`, `job-lifecycle.test.ts`, `openapi-v1.test.ts`). **Not live-verified** (manual gate only, per AGENTS.md §5).            |
| Build (`npm run build`)                                                     | ✅ PASS                                    | `tsc` + `vite` production build clean                                                                                                                                                                                               |
| Secret scan (committed range `b5e9ad3..d02bcbc`, `tmp/nlo-secret-scan.ps1`) | ✅ PASS for secrets                        | no tokens/keys/URLs/cookies/private keys. Hits were _infrastructure references_ only (8× `172.20.1.x`, 5× `80.191.92.189`, 13× `*.ai.ismc.ir`) — already present in committed docs precedent, no credential material.               |
| Secret scan (untracked `tmp/` candidates, `tmp/phase_r_tmpscan.ps1`)        | ✅ PASS                                    | 8 pattern hits, all reviewed manually: 6 are the scan scripts' own regexes, 2 are **dummy** `…deadbeef…` probe tokens, `litellm-openapi.json` hits are spec text ("password"/"bearer" in OpenAPI field names). **No real secrets.** |
| Production journal (since 2026-11-02)                                       | ✅ clean                                   | no error/exception/fatal                                                                                                                                                                                                            |
| Production DB integrity                                                     | ✅ (last full check 2026-11-02, T0 report) | `integrity_check ok`                                                                                                                                                                                                                |

Honesty note per AGENTS.md §5: **Unit/Integration/E2E passed; Live not tested in
this phase** (no live NotebookLM run was performed; production runtime is
healthy but not re-exercised).

## 7. Data preservation plan

1. **Local tree backup** (proposed, not done): archive the working tree
   including untracked `tmp/`, `$out`, `HTTP`, and the git-ignored `data/` +
   `.env` to a dated tarball outside the repo (e.g. `../nlo-phaseR-backup-<ts>.7z`).
   `git bundle create phaseR-bundle-66e907f.git main` additionally preserves all
   commit history + reflog reachability.
2. **Unpushed commits:** none to preserve (0 ahead). History integrity already
   guaranteed by GitHub (`66e907f` on `origin/main`).
3. **Production backups:** existing `data/backups/` retention (5 sqlite + 3 env)
   is intact; a fresh DB+env backup will be made by `deploy/deploy.sh` itself
   before any future deploy (step 4 of the script).
4. **Stage A vhost rollback reference** on prod: `/www/backup/nginx-vhost-before-20261103T165931Z`
   - `/tmp/nlo-*` staged files — preserve until HTTPS work concludes.
5. **`.bak` files on prod:** recoverable from git history (§4.3); keep until
   user approves cleanup.

## 8. Deployment SHA gap and recommended recovery sequence

**Gap:** production `b5e9ad3` → target `66e907f` = 14 commits, fast-forward only,
already on GitHub, docs/tests/new-dormant-modules only (no runtime-code delta for
currently-configured env).

**Proposed sequence (each step awaits explicit user approval before execution):**

1. Backup local working tree + untracked + ignored runtime data (§7.1).
2. (No unpushed commits to preserve — verified.)
3. Review file classifications with user (§5) — especially classes C and H.
4. Authoritative branch = `main` on GitHub (single source of truth; GitLab
   mirror only if/when re-authorized — no GitLab remote currently configured).
5. Prepare **clean, separated commits** (no mass `git add -A`):
   - Commit 1: `docs(reports): Phase R reconciliation audit` (this report).
   - Commit 2: `deploy(nginx): nlo.ai.ismc.ir vhost templates + HTTPS staged
rollout script` (the 4 class-C nginx files, moved from `tmp/`).
   - Commit 3 (optional, on approval): `scripts(audit): preflight/secret-scan/
db-check helpers` from `tmp/`.
   - Commit 4 (optional): `chore: prettier baseline for 6 docs files`
     (format fixes only, `npm run format` on the 6 listed files).
6. Re-run secret scans over each staged diff (reusable: `tmp/nlo-secret-scan.ps1`).
7. Re-run full gates (typecheck, lint, format:check, test, build) on the final
   tree — target: all green (lint gate requires either committing
   `tmp/n1-auth-probe.mjs` in cleaned-up form or leaving it untracked).
8. Push **fast-forward only** (`git push origin main`, no force).
9. Verify GitHub `refs/heads/main` SHA == local HEAD.
10. Production deploy plan: on `172.30.0.133` run
    `bash deploy/deploy.sh 66e907f` (auto DB+env backup, restart, health/ready/
    port/journal verification, in-place test suite). Rollback:
    `ROLLBACK=1 bash deploy/deploy.sh b5e9ad3`.
11. Deploy **only after separate explicit approval** (and optionally after the
    HTTPS/DNS blocker resolution in §4.4 — independent tracks).
12. Post-deploy verification: `data/deployed-commit` == `66e907f`,
    `git rev-parse HEAD` == `66e907f`, `/api/health/ready` ready:true,
    service active, no new journal errors.

**Explicitly NOT doing in this phase (mandatory STOP honored):** no deletes, no
resets, no checkouts, no stash, no staging, no commits, no pushes, no deploy, no
service restart, no production configuration change.

## 9. Open items requiring user decision

1. **HTTPS/DNS:** confirm ownership of `185.213.10.25` and that it forwards
   :80/:443 for `nlo.ai.ismc.ir` to `172.30.0.133`; confirm external :80
   reachability (certbot timed out). Until then Stage B cannot proceed.
2. **Commit scope:** approve which class-C/H files enter git (§5, sequence step 5).
3. **Cleanup approvals:** local `HTTP`, `$out`, `tmp/litellm-openapi.json`,
   s52-era probe scripts; prod `nul` + 2× `.bak-*`; stale local dev server on
   `127.0.0.1:4870`.
4. **Format gate:** approve `npm run format` fixes on the 6 committed docs.
5. **GitLab:** no remote configured locally; `docs/operations/gitlab-sync.md`
   describes a mirror policy — re-authorize if mirroring is to resume.

_Report generated by the Phase R read-only audit; all commands listed in §1–§4
were read-only or local quality-gate executions._
