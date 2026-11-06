# Production Readiness Audit — 172.30.0.133 (read-only)

**Date:** 2026-11-06 (audit window ≈ 04:01–04:20 UTC)
**Mode:** READ-ONLY on the production host. Only status/inspect commands and
loopback `curl` to NLO health endpoints were executed. No service start/stop/
restart, no git checkout/reset/fetch-write on prod, no file writes, no DB
writes, no nginx/DNS/Docker changes.
**Access method:** SSH publickey — `saber@172.30.0.133:22` (host `AI-TOOLS`,
OpenSSH 9.6p1 Ubuntu; same channel verified in `PHASE_G3A_NEW_HOST_AUDIT.md`).
No password used; no credentials written to this report.
**Local baseline:** local `main` = `origin/main` = `4ae25da` (clean tracked
tree; untracked scratch only: `$out`, `2026-11-05`, `HTTP`, `tmp/`).

---

## 1. Premise correction: prod is NOT at `b5e9ad3`

The task premise (and the last several phase reports) assumed production
`172.30.0.133` runs `b5e9ad3`. **This is stale.** A deployment to
`d705634` was already executed on **2026-11-04 03:33 UTC**. Evidence (all
collected read-only on the host):

| Evidence                          | Value                                                                      |
| --------------------------------- | -------------------------------------------------------------------------- |
| `git rev-parse HEAD` in prod repo | `d705634dacff5e3b97cdb29cb3968a8d91e90cab`                                 |
| `data/deployed-commit`            | `d705634`                                                                  |
| `data/backups/`                   | `nlo-20261104T033349Z-d705634.sqlite` + `env-20261104T033349Z-d705634.env` |
| `systemctl status nlo`            | `active (running) since Wed 2026-11-04 03:33:49 UTC`                       |
| prod `main` branch                | `d705634 [origin/main]`                                                    |

`d705634` is a **clean fast-forward ancestor** of `4ae25da`
(verified `git merge-base --is-ancestor` locally). Therefore:

- `b5e9ad3..4ae25da` = **30 commits** (not 12).
- The 18 commits `b5e9ad3..d705634` **are already deployed** (endpoint
  migration C–E config, first-admin bootstrap, Phase R/R1 reports, nginx
  templates, format-fix).
- **The actual deploy delta is `d705634..4ae25da` = exactly the 12
  mission commits** (P0 audio recovery + H1 text-to-notebook).

---

## 2. Prod current state (all observed live, read-only, 2026-11-06 ~04:05 UTC)

### 2.1 Service

| Item          | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| `nlo.service` | **active (running)** since 2026-11-04 03:33:49 UTC (~2.9 days at audit time) |
| Main PID      | 3155405 (node/tsx `src/main.ts`), 36 tasks, 97.1M resident (peak 156.7M)     |
| Unit          | loaded, enabled; identical in substance to repo `deploy/systemd/nlo.service` |
| Bind          | loopback `127.0.0.1:4870` (per `.env` `NLO_HOST=127.0.0.1`, `NLO_PORT=4870`) |

### 2.2 Git state on host

| Item                     | Value                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| HEAD                     | `d705634`                                                                                                    |
| Tracked working tree     | **clean** (`git status --porcelain --untracked-files=no` → empty)                                            |
| Untracked (pre-existing) | `connect-proxy.ts.bak-curlfix`, `job-runner.ts.bak-e2efix`, `nul` (scratch; ignored by deploy.sh)            |
| `origin`                 | `https://github.com/saber13812002/notebooklm-orchestrator.git`                                               |
| GitHub reachable         | **YES** — `git fetch --dry-run` reported `d705634..4ae25da main → origin/main` (fetch only, no state change) |

### 2.3 Live health (loopback curl)

```
GET http://127.0.0.1:4870/api/health
→ {"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-06T04:06:03.470Z"}

GET http://127.0.0.1:4870/api/health/ready
→ {"ok":true,"ready":true,
   "provider":{"name":"python-worker","configured":true,"issues":[]},
   "proxyRuntime":{"state":"available","name":"xray"},
   "liveDisabled":true}
```

### 2.4 OpenAPI surface on prod

| Check                                 | Result                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Operation count (`/api/openapi.json`) | **52**                                                                                                    |
| `POST /notebooks/from-text` present   | **NO** (as expected — H1 not yet deployed)                                                                |
| Post-deploy expectation               | **53** operations, incl. `POST /notebooks/from-text` (verified in local spec at `4ae25da`, `spec.ts:395`) |

### 2.5 Capacity

| Resource  | Value                                               |
| --------- | --------------------------------------------------- |
| Root disk | 686 GiB, **242 GiB used (37%)**, 416 GiB free       |
| Memory    | 78 GiB total, 23 GiB used, **54 GiB available**     |
| Uptime    | 5 days 20 h, load avg 2.59 / 2.41 / 2.29 (20 cores) |

### 2.6 `data/` integrity (sizes/permissions only — contents not read)

| Path                   | State                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `data/nlo.sqlite`      | 172 K (+`-shm` 32 K, `-wal` 2.5 M) — live DB intact                                                            |
| `data/deployed-commit` | `d705634`                                                                                                      |
| `data/backups/`        | 5 × `nlo-*.sqlite` (oldest `180e5a2` … newest `d705634`) + 3 × `env-*.env` (0600) — retention-5 pattern intact |
| `data/jobs/`           | 5 job dirs (historical artifacts)                                                                              |
| `data/sessions/`       | `0700`, session files `0600`                                                                                   |
| `data/vault/`          | present + `vault.key` `0600`                                                                                   |
| `data/vendor/xray`     | **present** (35 MB executable) + geoip/geosite.dat                                                             |
| `data/venv/`           | present (worker python verified in journal)                                                                    |

### 2.7 Jobs / queue

DB (opened `mode=ro`) job status counts: **2 SUCCEEDED, 3 FAILED, 0 in-flight**
(no QUEUED/RUNNING). The deploy's "no in-flight jobs" precondition is met.

### 2.8 Journal review (since the 2026-11-04 deploy)

14 error-pattern lines, **all inside a single window 2026-11-04 06:46–06:49
UTC** (a P0-audio attempt made that morning): worker `SIGABRT` ×3
(`Fatal Python error: _enter_buffered_busy … at interpreter shutdown`),
`chat.ask (TransportServerError)` ×3, API `500: ConnectError` ×2.
**Nothing since** — the service has been quiet for ~2 days. Note:
`deploy.sh` step 8 checks the journal only _since restart_, so these
historical lines will not trip a future deploy.

### 2.9 Host environment (names only — no values read or logged)

`.env` vars present: `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`,
`NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`,
`NLO_ALLOW_DIRECT_EGRESS`. **No** `NLO_INTERNAL_API_BASE_URL` (compiled
default `http://172.30.0.133:4000` applies — correct on this host) and **no
LLM key** (unchanged since G3A). The pending delta adds one new optional var
(`NLO_MAX_TEXT_CHARS`, default 200000) — no `.env` edit required.

`apps/web/dist` **is present on the host** (the server serves the built UI).
Note: `deploy.sh` never rebuilds the web bundle; after the deploy the served
UI will remain the pre-deploy build (no H1 form in the UI) until a manual
`npm run build` + `dist` refresh. The API contract is unaffected.

**Sudo:** `sudo -n true` → `sudo: a password is required` (rc=1). `saber`
has no passwordless sudo (unchanged since G3A). Consequence: `deploy.sh`
step 7 (`sudo systemctl restart nlo`) requires an **interactive sudo
password** at deploy time.

---

## 3. The exact deploy delta: `d705634..4ae25da` (12 commits)

38 files changed, **+4577 / −131**. `b5e9ad3..4ae25da` (30 commits) is shown
for completeness; the middle 18 are already on prod.

### 3.1 Commit list (oldest → newest)

| SHA       | Commit                                                                                  | Class       | Runtime effect                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fc54fc4` | fix(audio): session preflight on create-job + 404 for unknown account ids (P0)          | **runtime** | P0 recovery: session-freshness preflight before submit; unknown account ids return 404 (`accounts.repo.ts`, web `create-job.tsx`)                                                                                                                                                                                                               |
| `a32547d` | feat(api): add text-to-notebook endpoint (H1)                                           | **runtime** | New `POST /notebooks/from-text` (OpenAPI +183, route `jobs.ts` +89), `job-create-text.ts` new, shared `text-source.ts` new, worker support (`nbl_worker.py` +123, `python-worker-provider.ts`, `protocol.ts`, `types.ts`), mock provider, `archive.ts`, `config.ts` (`NLO_MAX_TEXT_CHARS`), `job-runner.ts`, web UI `create-job.tsx` + `api.ts` |
| `07d1475` | test(api): cover text-to-notebook (H1)                                                  | tests       | `from-text.test.ts`, `openapi-v1.test.ts`, web + shared tests                                                                                                                                                                                                                                                                                   |
| `5e28c20` | docs: update API and mission reports for H1                                             | docs        | API docs, architecture doc, `PHASE_H1` report, `.env.example`, CHANGELOG                                                                                                                                                                                                                                                                        |
| `dcd0c23` | docs(evidence): live acceptance — P0 audio + H1 text                                    | docs        | reports                                                                                                                                                                                                                                                                                                                                         |
| `19fba24` | fix(auth): keep worker protocol frames pure-ASCII (non-ASCII errors don't crash worker) | **runtime** | `nbl_worker.py` + test — robustness of the worker protocol (part of P0 recovery)                                                                                                                                                                                                                                                                |
| `6adc746` | docs(evidence): live acceptance — browser-import + P0 + H1                              | docs        | reports                                                                                                                                                                                                                                                                                                                                         |
| `58e90b2` | docs(api): H1 from-text client examples + regression verification                       | docs        | examples, README, testing doc                                                                                                                                                                                                                                                                                                                   |
| `6f7e8f4` | docs(evidence): attempt #3 — BLOCKED (0xC0000142 xray spawn, Chrome lock)               | docs        | reports                                                                                                                                                                                                                                                                                                                                         |
| `3344b32` | docs(evidence): attempt #4                                                              | docs        | reports                                                                                                                                                                                                                                                                                                                                         |
| `d6213df` | docs(evidence): P0 audio attempt #5 — final retry                                       | docs        | reports                                                                                                                                                                                                                                                                                                                                         |
| `4ae25da` | docs: PHASE_H0_H1 final acceptance report (consolidated)                                | docs        | report                                                                                                                                                                                                                                                                                                                                          |

**Split: 3 runtime commits** (`fc54fc4`, `a32547d`, `19fba24`) +
**1 test-only** (`07d1475`) + **8 docs-only**.

### 3.2 New DB migrations: **NONE**

`git diff --name-only` over `apps/server/src/db/migrations/` is empty for both
`b5e9ad3..4ae25da` and `d705634..4ae25da`. All five migrations
(`0001`–`0005`, incl. `0005_api_tokens.sql`) are already applied on prod
(the 172 K DB was migrated by the 2026-11-04 deploy). **A deploy therefore
carries no schema-change risk; `data/` preservation is routine, not special.**

### 3.3 Dependency / packaging impact: **NONE**

No changes to `package.json`, `package-lock.json`,
`apps/server/python-requirements.txt`, `Dockerfile`, `docker-compose.yml`,
`deploy/`, or `.github/workflows`. `deploy.sh` will log
"dependencies: unchanged — skipping npm ci / venv sync" — the deploy is a
pure source swap + restart.

### 3.4 What the 18 already-deployed commits brought (context only)

`b5e9ad3..d705634` already delivered: `NLO_INTERNAL_API_BASE_URL` config +
`internal-llm.ts` (endpoints C–E), first-admin bootstrap (offline CLI),
Phase R/R1 reconciliation + nginx template recovery, and the CI format-fix
(`d705634`). Nothing in that span is pending.

---

## 4. Deploy preconditions (verified at audit time)

| #   | Precondition (per `deploy/deploy.sh`)                       | Status                                                                                                         |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Target commit reachable from `origin/main` (GitHub)         | ✅ `4ae25da` on GitHub; prod dry-run fetch confirms `d705634..4ae25da` available                               |
| 2   | Prod tracked working tree clean                             | ✅ clean (only untracked scratch)                                                                              |
| 3   | `data/` (DB, backups, sessions, vault, vendor, venv) intact | ✅ §2.6                                                                                                        |
| 4   | DB + `.env` auto-backup before file change                  | ✅ automatic (retention 5; headroom: 4 sqlite slots free after prune… currently 5/5 → oldest `180e5a2` prunes) |
| 5   | No in-flight jobs                                           | ✅ 0 (5 total, all terminal)                                                                                   |
| 6   | `data/vendor/xray` present (xray runtime)                   | ✅                                                                                                             |
| 7   | Service active (first-restart warning avoided)              | ✅                                                                                                             |
| 8   | Sudo for `systemctl restart` (step 7)                       | ⚠️ **password required at deploy time** (no passwordless sudo)                                                 |
| 9   | New DB migrations runnable                                  | ✅ n/a — no migrations in delta                                                                                |
| 10  | Dependency sync (npm/venv)                                  | ✅ n/a — no manifest changes                                                                                   |

---

## 5. Blockers / risks

1. **P0 audio tunnel instability — EXTERNAL, not fixed by this deploy.**
   Long-held operations on the `france1-SeyedSaber` VLESS tunnel drop
   (`GET_NOTEBOOK ConnectTimeout` / `RemoteProtocolError`; 3/3 in the last
   5 live attempts). The delta _improves_ P0 odds (`fc54fc4` session
   preflight + 404 on unknown account, `19fba24` ASCII-protocol hardening)
   but does not cure it. **Audio jobs may still fail post-deploy; text and
   short operations are unaffected** (H1 text-to-notebook was
   live-verified on local 4871 in `PHASE_H0_H1_TEXT_TO_NOTEBOOK.md` §12).
2. **`worker.ts` timeout/cancel wedge bug — PRE-EXISTING, unchanged by this
   deploy.** The task premise noted "wedge bug present in the delta";
   correction: `apps/server/src/providers/python-worker/worker.ts` is
   **byte-identical between `d705634` (prod) and `4ae25da`** (verified by
   file compare). The timeout path (`worker.ts:168-177`) deletes the pending
   entry **before** `kill()`, so on a 30-min timeout the Promise never
   settles and the in-process queue stays `busy` (wedge). This ordering
   exists on prod today and survives the deploy unchanged; it is documented
   as **not fixed** in `PHASE_H0_H1_TEXT_TO_NOTEBOOK.md` §16 and
   `PHASE_P0_AUDIO_RECOVERY.md` §15 (which prescribe the mitigation:
   early-stop before the 30-min mark, DB-terminalize + service restart if
   wedged). Prod's journal shows the related `SIGABRT`
   interpreter-shutdown pattern from the 2026-11-04 attempt window.
3. **Sudo password** for the restart step — operator must be present at the
   terminal (or provision NOPASSWD for `systemctl restart nlo` out-of-band).
   Not a code blocker.
4. **Web UI drift after deploy:** `apps/web/dist` on the host is untracked
   and `deploy.sh` never rebuilds it. The H1 create-job form (source shipped
   in `a32547d`) will not appear in the served UI until a manual web build +
   `dist` copy on the host. API-first contract unaffected (per AGENTS.md §4
   the frontend is one consumer only).
5. **Auth not activated on prod** (no API tokens created; first-admin CLI is
   deployed but unused). This deploy changes nothing about auth behavior;
   activation remains a separately approved action.
6. **Historical journal errors** (§2.8) — cosmetic for the deploy (journal
   check is since-restart), but a reminder that the P0 failure mode is live
   on this host.

**Non-issues confirmed:** no migration risk, no dependency-install network
risk on the host, no dirty-tree abort risk, no disk/memory pressure, GitHub
reachable from prod, loopback bind + fail-closed egress config unchanged.

---

## 6. Recommendation

**READY-WITH-CAVEATS.** Every deploy precondition is verified green; the
delta is a fast-forward of 12 reviewed, committed, pushed commits with no
schema or dependency changes. The caveats are all _pre-existing or external_
(audio tunnel, worker wedge, sudo password) — none are introduced by
`4ae25da`. If the acceptance bar includes _working P0 audio in production_,
that bar is **not** met by this deploy and remains blocked on tunnel
stability; if the bar is "prod serves current origin/main incl. H1
text-to-notebook", it is met.

### Exact command sequence for the future (approved) deploy

Not executed in this audit. To be run by an operator on
`172.30.0.133` (interactive, sudo password available):

```bash
ssh saber@172.30.0.133
cd /home/saber/saberprojects/notebooklm-orchestrator

# 0) Optional read-only preview (no restart, no backup, no checkout):
NLO_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh 4ae25da

# 1) Deploy (auto: fetch, tree check, DB+env backup, checkout, restart,
#    health/ready/port/journal verify, server test suite, record SHA):
bash deploy/deploy.sh 4ae25da

# 2) Post-deploy verification:
cat data/deployed-commit                                  # expect: 4ae25da
curl -s localhost:4870/api/health/ready | python3 -m json.tool
curl -s localhost:4870/api/openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); p=[k for k in d['paths'] if 'from-text' in k]; print('from-text paths:', p)"
#    expect: from-text paths: ['/notebooks/from-text']  (53 operations total)

# 3) Optional, only if UI parity is wanted (manual, separate step):
npm run build --workspace @nlo/web    # then confirm apps/web/dist refreshed

# Rollback (always possible; previous-good printed by the script):
bash deploy/deploy.sh d705634
# DB restore, only if ever needed: stop nlo; cp data/backups/nlo-<TS>-<sha>.sqlite data/nlo.sqlite; start nlo
```

---

## 7. Checks NOT performed (honesty)

- **Root-level host inspection** (`ufw status`, `iptables -S`, full firewall
  audit) — requires sudo; `saber` has none. Carried over as a known limit
  from G3A.
- **Authenticated LiteLLM `/v1/models`** — no LLM key provisioned on the
  host (unchanged; out of scope for this audit).
- **Live NotebookLM job** on prod — no job was submitted; this audit
  submitted nothing to the service.
- **Prod web bundle build** — not performed (read-only mandate); noted as a
  post-deploy option only.
- DB contents beyond job status counts (accounts, tokens, proxies) were not
  enumerated — sizes/permissions verified instead.

## 8. Verification level

`Live prod inspected (read-only, SSH)` + `local git analysis (deterministic)`.
No tests were run as part of this audit (the pre-deploy regression evidence
is on record in `PHASE_H0_H1_TEXT_TO_NOTEBOOK.md` §10: 213/213 across 3
workspaces at `4ae25da`).
