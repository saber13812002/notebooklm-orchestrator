# NLO Deployment Procedure (Git-based, reproducible)

Target: the single-user server **s52** (`172.20.1.52`), service **`nlo`**
(systemd), loopback port **4870**. Everything in this document has been
executed and verified; it is the canonical deployment path.

## Principles

1. **Only reviewed commits are deployed.** A commit is deployable only after
   it exists on `origin/main` (GitHub). Local-only commits are rejected with
   a warning by the deploy script.
2. **Runtime state is never touched.** `data/` (SQLite DB, job archives,
   vault, `data/vendor/xray`), `.env`, `node_modules`, and `data/venv` are
   all git-ignored. The deploy script refuses to run when tracked files are
   dirty, so no local work can be clobbered.
3. **Backup before risk.** The DB and `.env` are copied to `data/backups/`
   (5 newest kept) before any file change.
4. **Verify, don't assume.** Every deploy ends with health, readiness, port,
   journal, and regression-test verification.
5. **Rollback is a deploy.** Re-running the script at the previous good
   commit restores the application code; runtime data is never rolled back
   (DB restore is a separate manual step from the backups).

## Normal deploy (on s52)

```bash
cd /home/saber/saberprojects/notebooklm-orchestrator
git fetch origin
bash deploy/deploy.sh origin/main        # or a specific SHA / tag
```

What the script does, in order:

| Step | Action |
|---|---|
| 1 | `git fetch origin`; resolve target commit; refuse if not on `origin/main` (warns for local commits) |
| 2 | Refuse if the working tree has uncommitted **tracked** changes |
| 3 | Prerequisite warnings: service active, `.env` present, `data/vendor/xray` present |
| 4 | Back up `data/nlo.sqlite` + `.env` to `data/backups/` (0600), prune to 5 |
| 5 | `git checkout` the target (no-op if HEAD already matches) |
| 6 | `npm ci --omit=dev` **only if** `package*.json` changed; venv sync **only if** `python-requirements.txt` changed |
| 7 | `sudo systemctl restart nlo` |
| 8 | Verify: unit `active`, `/api/health`, `/api/health/ready` (`ready:true`), port 4870 listening, journal free of new errors |
| 9 | `apps/server` vitest suite (failures are reported, not fatal) |
| 10 | Record the deployed commit to `data/deployed-commit` |

**Dry run** (no restart, no backup, no checkout):

```bash
NLO_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh <commit>
```

**Rollback** (the previous good commit is printed at the top of every run):

```bash
bash deploy/deploy.sh <previous-commit>     # e.g. from data/deployed-commit
# If the DB itself must be restored:
#   sudo systemctl stop nlo
#   cp data/backups/nlo-<TS>-<sha>.sqlite data/nlo.sqlite
#   sudo systemctl start nlo
```

## First-time host setup (already done on s52 — reference only)

1. Node 22 + repo clone at `/home/saber/saberprojects/notebooklm-orchestrator`.
2. `npm ci --omit=dev`.
3. Python 3 venv: `python3 -m venv data/venv && data/venv/bin/pip install -r apps/server/python-requirements.txt` (pulls `notebooklm-py` + Playwright).
4. Official Xray binary: download the `Xray-linux-64.zip` release asset →
   `data/vendor/xray` (never installed system-wide; required for
   `NLO_PROXY_RUNTIME=xray`).
5. `install -m 644 deploy/systemd/nlo.service /etc/systemd/system/nlo.service`
   → `systemctl daemon-reload` → `systemctl enable --now nlo`.
6. `.env` at repo root (never committed): see `.env.example`. Required for
   live mode: `NLO_PROVIDER=python-worker`, `NLO_PROXY_RUNTIME=xray`,
   `NLO_ALLOW_DIRECT_EGRESS=false`, `NLO_PYTHON_BIN=<venv python>`,
   `NLO_HOST=127.0.0.1`, `NLO_PORT=4870`.
7. Proxy nodes are registered through the UI/API (`POST /api/proxies/manual`
   or the VLESS import modal) — they live in the DB, not in git.

## Security invariants

- `.env`, `data/` (DB, vault, session cookies, job audio), `node_modules`,
  `data/vendor`, `data/venv` are git-ignored and never part of any commit.
- The deploy script reads no credentials and prints none.
- The server binds `127.0.0.1` only; access from the workstation is via the
  standing SSH port-forward (`ssh -N -L 4870:127.0.0.1:4870 s52`).
- Live egress to Google goes exclusively through the xray tunnels
  (`NLO_ALLOW_DIRECT_EGRESS=false`, fail-closed health checks).

## Verification checklist (post-deploy, also run by `deploy/deploy.sh`)

- [ ] `systemctl is-active nlo` → `active`
- [ ] `GET /api/health` → `{"ok":true,...}`
- [ ] `GET /api/health/ready` → `ready:true`, provider `python-worker configured`, `proxyRuntime available`
- [ ] `ss -ltnp | grep 4870` → exactly one listener (the service node process)
- [ ] `journalctl -u nlo --since <restart>` → no new errors
- [ ] `apps/server` test suite → green
- [ ] `cat data/deployed-commit` matches the deployed SHA
- [ ] (optional, controlled) one live job reuses an existing notebook by
      title (no new notebook) and returns `resultProvenance:"real"`
