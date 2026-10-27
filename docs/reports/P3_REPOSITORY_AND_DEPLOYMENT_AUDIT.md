# P3 — Repository, Deployment & Provider Abstraction Audit

**Date:** 2026-10-27 (UTC) · **Server:** s52 (`172.20.1.52`), service `nlo`, port 4870
**Repo:** `https://github.com/saber13812002/notebooklm-orchestrator`
**Final deployed commit:** `180e5a2` (local `main` == `origin/main` == s52)

All statements below were verified by direct inspection on 2026-10-27; nothing
in this report is assumed from earlier phases.

---

## Mission 1 — Actual repository state (as found)

| | Local (Windows dev) | GitHub `origin/main` | s52 deployed |
|---|---|---|---|
| Branch | `main` | `main` | `main` |
| HEAD at inspection | `a909905` | `7df8aa6` | `7df8aa6` |
| Working tree | clean | n/a | `M` on 2 files + 2 untracked `.bak` files |
| `5bcccad` present | yes | **no** | **no** (as commit) |
| `a909905` present | yes | **no** | **no** (as commit) |
| Untracked | `deploy/`, one `.pyc` | n/a | 2 `.bak` files (P2 backups) |

**Key findings**

1. **P2 was never pushed.** Local `main` was 2 commits ahead of GitHub
   (`5bcccad` proxy fix, `a909905` runner fix); GitHub and s52 had never seen
   them as commits.
2. **s52 ran P2 code without knowing it.** The two P2-modified files on s52
   were scp'd from the Windows working copy (CRLF line endings,
   `core.autocrlf` unset on the Linux box), so `git status` showed them as
   modified against `7df8aa6` and `git diff` produced a large CRLF-noise
   patch. **Content-level proof:** after LF-normalization, the s52 blobs
   exactly match the `a909905` blobs:
   - `connect-proxy.ts` → `b4b1a7a7…` ✔
   - `job-runner.ts` → `7072a980…` ✔
   No server-only work existed — nothing was missing from the local repo.
3. **A Python bytecode cache had been committed** to the repository
   (`apps/server/src/providers/python-worker/__pycache__/nbl_worker.cpython-312.pyc`)
   — a regenerable artifact in git history.
4. `deploy/systemd/nlo.service` was untracked. Inspected line-by-line: it
   contains only system paths, the repo path, `User=saber`, and hardening
   flags — **no secrets, no environment-specific credentials** → belongs in
   version control.

## Mission 2 — Git workflow repair (actions taken, all non-destructive)

| Commit | Change |
|---|---|
| `6c60855` | Add `deploy/systemd/nlo.service` (secret-free) + `.gitignore` python-cache entries |
| `1744cc6` | `git rm --cached` the tracked `__pycache__/*.pyc` (regenerable artifact) |
| `8d7362d` | Add `deploy/deploy.sh` + `docs/deployment.md` (reproducible procedure) |
| `180e5a2` | PATH-hardened dep install + repo-local vitest in `deploy.sh` (non-interactive SSH) |

- `origin` was already correctly configured (verified before changing
  anything). All four pushes were **fast-forwards**
  (`7df8aa6 → 6c60855 → 1744cc6 → 8d7362d → 180e5a2`); no force-push, no
  rewrite, nothing overwritten.
- **s52 reconciliation** (content-proven safe before running):
  `git fetch` from GitHub → `git reset` branch pointer to `origin/main` →
  `git checkout <commit> -- .` (only LF-normalization applied to the two
  scp-touched files; no foreign tree imposed) → removed `__pycache__`.
  Runtime data (`data/` DB, `.env`, `data/vendor/xray`, `data/venv`,
  `node_modules`) is git-ignored and was untouched; service stayed healthy
  throughout. No `git reset --hard` to a foreign tree, no destructive
  checkout, no work discarded.
- End state: local, GitHub, and s52 are **byte-identical at `180e5a2`** with
  clean working trees (except the two harmless untracked `.bak` files on s52).

## Mission 3 — Reproducible deployment procedure

Implemented as [`deploy/deploy.sh`](../../deploy/deploy.sh) +
[`docs/deployment.md`](../deployment.md). The script was **executed twice on
the live server** (both `DEPLOY SUCCESS`):

1. `git fetch origin`; resolve target commit; deploy only commits reachable
   from `origin/main` (reviewed code).
2. Refuse to run when tracked files have uncommitted changes.
3. Prerequisite warnings (service, `.env`, `data/vendor/xray`).
4. **Backup** `data/nlo.sqlite` + `.env` to `data/backups/` (0600, keep 5).
5. Checkout target commit (no-op when HEAD already matches).
6. `npm ci --omit=dev` **only if** `package*.json` changed; venv sync **only
   if** `python-requirements.txt` changed.
7. `sudo systemctl restart nlo` (existing unit, 120s graceful SIGTERM drain).
8. Verify: unit active, `/api/health`, `/api/health/ready` (`ready:true`),
   port 4870 listening, journal free of new errors.
9. Server vitest suite (repo-local binary; failures reported, not fatal).
10. Record `data/deployed-commit`.

Rollback = re-run at the previous good commit (printed on every run); DB
restore from `data/backups/` is a separate manual step. Dry-run mode:
`NLO_DEPLOY_DRY_RUN=1`.

Execution evidence: backups created (`nlo-…-180e5a2.sqlite`,
`env-…-180e5a2.env`), restart clean, all verifications green, **59/59 tests
passed**. Caveat: both live runs were *no-op* deploys (HEAD already at
target), so the checkout branch of the script is code-reviewed but not yet
exercised by a live commit advance.

## Mission 4 — Live system verification (2026-10-27 08:35 UTC)

| Check | Result |
|---|---|
| `nlo.service` | `active` (MainPID 1805140, restarted 08:35:38) |
| UI `GET /` | 200 |
| `/api/health` | `{"ok":true,…}` |
| `/api/health/ready` | `ready:true`, provider `python-worker configured`, `proxyRuntime available (xray)`, `liveDisabled:true` |
| Port 4870 | exactly **one** listener (service node process) — no duplicate instance |
| Worker lifecycle | spawned with venv python (`pid=1805543`) during readiness validation → **exited code=0, signal=none**; historical `SIGTERM: shutting down (draining queue)` lines confirm graceful stops |
| App commit | HEAD `180e5a2` == `data/deployed-commit` `180e5a2` |
| Account | `acc_5a03a60bbda24085` ACTIVE, enabled, default |
| Proxies | `france1-SeyedSaber` + `England_1` both enabled (config intact) |
| Session | `sess_013327da4aff48eb` AUTHENTICATED, `hasStoredFile:true`; `sessionUsable:false` — **expected**: 10-min verification TTL expired ~15h ago (re-verify via `POST /api/sessions/:acc/verify` before the next live job) |
| Tests | server suite **59/59 pass** on s52 (5 files) |

No full live job was re-run: the deployment changed no application code
(only `deploy/` + docs), and P2 already produced two real successful jobs
(`resultProvenance:"real"`, correct answers, real destination IDs). Creating
another real notebook was deemed unnecessary churn.

## Mission 5 — Provider abstraction audit

Interface: [`NotebookLMProvider`](../../apps/server/src/providers/types.ts:72)
(`capabilities`, `validateConfiguration`, `getAccountStatus`, `runJob`,
`cancel`) with honest `CapLevel` declarations via `capabilityMatrix()`.
Selection/registration: single factory in
[`app-context.ts`](../../apps/server/src/app-context.ts:103)
(`config.provider === "python-worker"` → live adapter, else `MockProvider`).

| Component | Files | Status |
|---|---|---|
| Provider contract + capability levels | `providers/types.ts` | **Implemented and verified** (enforced by app-context; both branches exercised) |
| NotebookLM live adapter | `providers/python-worker/python-worker-provider.ts` (534 ln) | **Implemented and verified live** (P2: 2 real jobs, real notebook/source/conversation IDs, `simulated:false`) |
| Mock provider | `providers/mock-provider.ts` | **Implemented and verified** (full test suite; honest `implemented_tested` levels) |
| MCP client integration | — | **Not implemented** (zero references in codebase; remains a future evaluation option per `docs/provider-evaluation.md`) |
| Python worker integration | `worker.ts` (supervisor: arg-array spawn, JSONL stdio, deadlines, process-group kill, SIGTERM→SIGKILL, stderr cap), `protocol.ts`, `nbl_worker.py` (ops: `ping`, `validate`, `verify`, `login`, `browser_import`, `job`) | **Implemented and verified** (live spawn/exit-code-0 observed; P2 jobs; P1 shutdown fix `7df8aa6`) |
| Source management (audio) | job upload → archive `input/` → adapter `runJob` → worker `op_job` (ADD_SOURCE_FILE + processing wait) | **Implemented; wav verified live** (`.mp3` et al. declared unverified) |
| Prompt execution | worker `op_job` conversation turn | **Implemented and verified live** (correct grounded answers, P2) |
| Artifact / output registry | `domain/archive.ts` (per-job manifest, `execution/timeline.jsonl`, `output/answer.md`, `output/artifacts/`), `jobs.repo.recordAttempt`, `GET /api/jobs/:id/artifacts/:aid` + `/audio/download` | **Implemented and verified** (answer archived in P2; live worker honestly returns `artifacts: []` — chat answers are text) |
| Job orchestration | `queue/queue.ts`, `queue/job-runner.ts` (state machine, attempts, fail-closed account/proxy selection, cancel, events) | **Implemented and verified** (job-lifecycle + fail-closed tests; P2 retry-after-502 success) |
| Download manager | artifact + input-audio download endpoints only | **Partially implemented** — no general download subsystem for external (Drive/URL) sources; out of scope per mission |

Live adapter declared capability matrix (from
`capabilities()`, `python-worker-provider.ts:187`):

| Operation | Declared level | Live evidence |
|---|---|---|
| validateConfiguration | `implemented_tested` | readiness check green on s52 |
| getAccountStatus | `implemented_untested_live` | verified: 165 notebooks, `mismatch:false` |
| login (interactive Playwright) | `implemented_untested_live` | not exercised — s52 used `browser_import` instead (which *is* live-verified) |
| submitAudioJob | `implemented_untested_live` | live-verified in P2 (upload + processing) |
| retrieveResult | `implemented_untested_live` | live-verified in P2 (correct answers) |
| retrieveArtifacts | `unsupported` | honest — chat workflow yields text only |
| cancelJob | `experimental` | kill-worker semantics; in-flight op may still finish |

Note: even after P2's live verification the declared levels remain
`implemented_untested_live` — there is no `verified_live` level in
`CapLevel`. Recommend adding one and upgrading the matrix (P4).

## Remaining blockers & recommended next steps

1. **Session TTL (10 min)** — a live job needs a fresh
   `POST /api/sessions/:acc/verify` within 10 minutes of submission
   (observed: a job submitted 28 s after expiry failed fail-closed).
   Consider a keepalive re-verify or a documented "verify-then-submit"
   workflow in the UI.
2. **England node instability** — intermittent TLS resets
   (`curl exited 35`); France is the reliable route. Monitor via the proxy
   panel; consider disabling the flaky node.
3. **Exercise the deploy checkout path once for real** (advance to a new
   commit and deploy) to close the one untested branch of `deploy.sh`.
4. **Clean up s52 P2 leftovers** — untracked
   `connect-proxy.ts.bak-curlfix`, `job-runner.ts.bak-e2efix` (safe to delete
   once the next deploy backup exists).
5. **Upgrade capability levels** to a `verified_live` tier with P2 evidence;
   verify `.mp3` upload and interactive `login` live to move them.
6. **MCP integration** remains unimplemented — revisit only when the
   provider-evaluation decision calls for it.
7. s52's local git has no `origin` remote (it fetches the GitHub URL
   directly in the deploy script); optionally `git remote add origin …` for
   convenience.

**Completion criteria met:** local/GitHub/s52 relationship is documented and
reconciled (all three at `180e5a2`); deployment procedure is reproducible and
executed; production service healthy; no runtime configuration or user work
lost; abstraction audit based on actual code and tests.
