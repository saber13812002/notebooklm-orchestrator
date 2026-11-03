# Phase R1 — Safe Backup, Nginx Artifact Recovery and GitHub Publication

**Date:** 2026-11-03 (UTC)
**Baseline:** local `main` = `origin/main` = `66e907f` (start of phase)
**Production:** `172.30.0.133` (untouched — no deploy, restart, reload, DNS,
firewall, certificate, or file deletion in this phase)
**Result:** backup complete and verified; nginx artifacts recovered as
host-agnostic templates; **3 commits published to GitHub**; production
deployment remains the next separately-approved phase.

---

## 1. Backup verification (Step 1)

**Location (outside the repo, outside git):**
`C:\Users\s.tabatabaei\Documents\saberprojects\backups\nlo-phaseR1-20261103T214713Z\`

| Item            | Value                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files backed up | 215 (214 content + 1 manifest)                                                                                                                                                                                            |
| Total size      | 139,737,578 bytes (~133 MB)                                                                                                                                                                                               |
| Manifest        | `MANIFEST.sha256` — 214 SHA-256 entries                                                                                                                                                                                   |
| Verification    | every manifest entry re-hashed on disk: **0 mismatches, 0 missing**                                                                                                                                                       |
| Git bundle      | `nlo-bundle-20261103T214713Z.bundle` (0.6 MB) — `git bundle verify`: "okay", **records a complete history**, 4 refs: `refs/heads/main`, `refs/remotes/origin/main`, `refs/remotes/origin/HEAD`, `HEAD` (all at `66e907f`) |

**Included (secure, git-excluded):**

- `.env` (local loopback dev config; sha256
  `dad565da…775b2a` — value never printed)
- `data/` runtime state: `nlo.sqlite` (+`-shm`, `-wal`), `vault.key`
  (`3c09bd95…514ec8`), `jobs/` (all 12 job dirs incl. audio inputs/outputs),
  `sessions/`, `vault/`, `backups/`, `data/tmp/` (historic ops scripts + probes)
- all untracked `tmp/` files (28) incl. logs, probes, the one-shot nginx
  scripts, and the 1.5 MB LiteLLM spec dump
- untracked top-level: `$out`, `HTTP`

**Deliberately excluded (regenerable, documented):** `data/venv` (155.9 MB,
recreate via `npm run worker:setup`) and `data/vendor` (34.0 MB, xray binary
re-download per docs). `node_modules/` excluded (recreate via `npm ci`).

**Integrity note:** the backup is a point-in-time copy taken **before any
Phase R1 modification**; the repo working tree itself was not altered by the
backup.

## 2. Recovered files (Step 2)

Originals **preserved in place** (`tmp/nlo-vhost-stageA.conf`,
`tmp/nlo-vhost-stageB.conf`, `tmp/nlo-deploy.sh`, `tmp/nlo-https-full.sh`) —
untouched, untracked, and also inside the Step-1 backup.

Reviewed copies now live in **`deploy/nginx/`** (new directory):

| New file                                                                                     | Source                                                    | Review outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`deploy/nginx/nlo-vhost.stageA.conf.tpl`](../../deploy/nginx/nlo-vhost.stageA.conf.tpl)     | `tmp/nlo-vhost-stageA.conf`                               | host-specific domain/logs/webroot → `__NLO_DOMAIN__`, `__NLO_LOG_DIR__`, `__NLO_ACME_WEBROOT__` placeholders; logic unchanged (ACME HTTP-01 + 301)                                                                                                                                                                                                                                                                                                              |
| [`deploy/nginx/nlo-vhost.stageB.conf.tpl`](../../deploy/nginx/nlo-vhost.stageB.conf.tpl)     | `tmp/nlo-vhost-stageB.conf`                               | placeholders for cert dir/upstream/upload limit; **bug fix:** hard-coded `Connection "upgrade"` (breaks keep-alive for non-WS clients) replaced by the standard `$connection_upgrade` map; upload limit parameterized (default 210 MB = 200 MB NLO limit + multipart headroom); 600 s proxy timeouts and HSTS/nosniff/XFO/Referrer-Policy headers preserved                                                                                                     |
| [`deploy/nginx/ngx-map-connection.conf.tpl`](../../deploy/nginx/ngx-map-connection.conf.tpl) | (missing prerequisite in original)                        | one-time `http {}` snippet required by the Stage B fix; idempotent install guidance in README                                                                                                                                                                                                                                                                                                                                                                   |
| [`deploy/nginx/nlo-nginx-deploy.sh`](../../deploy/nginx/nlo-nginx-deploy.sh)                 | merged from `tmp/nlo-deploy.sh` + `tmp/nlo-https-full.sh` | host paths/IPs/email removed — everything via env vars (`NLO_DOMAIN`, `NLO_VHOST_DIR`, `NLO_LOG_DIR`, `NLO_ACME_WEBROOT`, `NLO_CERT_DIR`, `NLO_UPSTREAM`, `NLO_MAX_UPLOAD_MB`, `NLO_BACKUP_DIR`); `bash -n` syntax check passed; fail-closed: unrendered placeholder → abort, `nginx -t` before every reload, Stage B refuses without an issued cert; timestamped vhost-dir backup before each install; rollback documented (single `rm` + `nginx -t` + reload) |
| [`deploy/nginx/README.md`](../../deploy/nginx/README.md)                                     | new                                                       | procedure, placeholder table, rollback, and the full review notes (see below)                                                                                                                                                                                                                                                                                                                                                                                   |

**Review checklist outcomes (as required by the mission):**

- Hardcoded IPs: removed from templates (only referenced as an example of the
  DNS blocker in the README).
- Host-specific paths: replaced by placeholders (originals used
  `/www/server/panel/vhost/nginx`, `/www/wwwlogs`, `/www/acme`).
- Certificate paths: placeholder `__NLO_CERT_DIR__` (default
  `/etc/letsencrypt/live/$NLO_DOMAIN`); **no certs/keys copied or stored**.
- Email addresses: removed (the one-shot script had a hardcoded ACME contact;
  README now says `<ACME_EMAIL>` "never stored in this repo").
- Nginx assumptions: BaoTa panel layout is now an _example_, not an
  assumption; the `$connection_upgrade` prerequisite is made explicit.
- Rollback: preserved and documented (vhost backup per run + one-command
  removal).
- Idempotency: map-snippet check is grep-guarded; re-runs safe; backups
  timestamped, never overwritten.
- Security headers, upload limit, timeouts: preserved (HSTS 1 y
  includeSubDomains, nosniff, X-Frame-Options DENY, Referrer-Policy
  strict-origin-when-cross-origin; 210 MB; 30 s/600 s/600 s).

## 3. Report publication (Step 3)

`docs/reports/PHASE_R_RECONCILIATION.md` reviewed + prettier-formatted and
secret-scanned: no tokens, keys, cookies, or credential values; only
infrastructure references (host IP `172.30.0.133`, internal domain,
`185.213.10.25` edge) already established as committed-docs precedent. No
`.env` values, session contents, or vault material anywhere.

## 4. Excluded artifacts (Step 4) — verified untracked, none deleted

| Artifact                                                           | State                               |
| ------------------------------------------------------------------ | ----------------------------------- |
| `HTTP` (0 B), `$out` (2.1 KB)                                      | untracked, preserved (in backup)    |
| `tmp/litellm-openapi.json` (1.5 MB), `tmp/litellm-oas-summary.txt` | untracked, preserved                |
| `tmp/n1-auth-probe.mjs` (+ `.ps1`, logs)                           | untracked, preserved                |
| All probe outputs, `data/`, `.env`, DB backups, sessions           | git-ignored or untracked, preserved |

Post-commit `git status --porcelain`: only `?? $out`, `?? HTTP`, `?? tmp/`
remain — nothing sensitive staged or committed.

## 5. Quality gates (Step 5)

| Gate                                                                | Result                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                          | ✅ **175/175** (shared 44, server 106, web 25)                                                                                                                             |
| `npm run typecheck`                                                 | ✅ PASS (all workspaces)                                                                                                                                                   |
| `npm run lint`                                                      | ⚠️ 6 `no-empty` — **all in untracked** `tmp/n1-auth-probe.mjs` (pre-existing, explicitly excluded from commit; out of scope per "fix only issues in newly prepared files") |
| `npx prettier --check` (new files: `deploy/nginx/**`, both reports) | ✅ PASS after `--write` on the 2 new markdown files                                                                                                                        |
| `npm run build`                                                     | ✅ PASS (tsc + vite)                                                                                                                                                       |
| `bash -n deploy/nginx/nlo-nginx-deploy.sh`                          | ✅ PASS                                                                                                                                                                    |
| Secret scan — new files (`tmp/phase_r1_scan.ps1`)                   | ✅ 0 credential hits after removing one real ACME email reference from the README                                                                                          |
| Secret scan — staged diff (`tmp/phase_r1_staged_scan.ps1`)          | ✅ **0 hits** across all 358 staged diff lines (10 patterns)                                                                                                               |

## 6. Commits and GitHub SHA (Step 6)

Pushed **fast-forward only** (no force). All staged diffs reviewed file-by-file.

| #   | SHA           | Subject                                                                     | Files    |
| --- | ------------- | --------------------------------------------------------------------------- | -------- |
| 1   | `de1b696`     | `docs(reports): Phase R repository reconciliation audit (read-only)`        | 1 (+378) |
| 2   | `914f16f`     | `deploy(nginx): host-agnostic vhost templates + staged HTTPS deploy helper` | 5 (+328) |
| 3   | (this commit) | `docs(reports): Phase R1 backup + artifact recovery + publication`          | 1        |

**Verification after push:**

- `git push origin main` → fast-forward `66e907f..{new tip}`
- post-push: local `main` SHA == `git ls-remote origin refs/heads/main` SHA
  (recorded below in §7).

## 7. New directory structure

```
deploy/
  deploy.sh                 (unchanged, git-based app deploy)
  systemd/nlo.service       (unchanged)
  nginx/                    ← NEW (this phase)
    README.md
    nlo-vhost.stageA.conf.tpl
    nlo-vhost.stageB.conf.tpl
    ngx-map-connection.conf.tpl
    nlo-nginx-deploy.sh
docs/reports/
  PHASE_R_RECONCILIATION.md ← NEW (commit 1)
  PHASE_R1_ARTIFACT_RECOVERY.md ← NEW (this commit)
```

## 8. Remaining blockers (for the separately-approved production phase)

1. **DNS/edge (certbot blocker):** `nlo.ai.ismc.ir` resolves to
   `185.213.10.25` while the host is `172.30.0.133` (RFC1918); LE HTTP-01
   timed out. Owner must confirm the edge forwards :80/:443 to the host (or
   re-point DNS) and that external :80 is reachable. Until then Stage B is
   impossible.
2. **Production SHA gap:** `b5e9ad3` → new tip (17 commits after this phase,
   per `git rev-list --count b5e9ad3..main` = 17),
   fast-forward; deploy via `bash deploy/deploy.sh <tip>` — auto DB+env
   backup, restart, verify, rollback path `ROLLBACK=1 … b5e9ad3`. **Awaiting
   separate explicit approval.**
3. **Pre-existing lint debt:** 6 `no-empty` in untracked
   `tmp/n1-auth-probe.mjs` — either clean and commit or discard (user call).
4. **Pre-existing format debt:** 6 committed docs fail `format:check`
   (cosmetic) — separate chore commit if desired.
5. **Cleanup candidates (user approval):** prod `nul` + 2× `.bak-*`
   (recoverable from git history), local `HTTP`/`$out`/s52-era probes, stale
   local dev server on `127.0.0.1:4870`.

**STOP:** publication complete; production deployment explicitly NOT
performed, per mission.
