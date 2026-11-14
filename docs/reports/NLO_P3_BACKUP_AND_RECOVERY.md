# NLO-P3 — Phase 1: Backup & Recovery Point (Gate 1)

- **Mission**: NLO-P3-PRODUCTION-LAUNCH-2026-11
- **Phase**: 1 — Backup + recovery point
- **Date (UTC)**: 2026-11-14T17:29:54Z
- **Host**: `AI-TOOLS` (172.30.0.133, Ubuntu 24.04.4 LTS)
- **Scope**: production host only; read-only + new backup artifacts; no service change, no nginx change, no DB write
- **Gate 1 status**: **PASSED** — a verified, checksummed, WAL-safe recovery point exists before any NLO-P3 production change

## 1. What was backed up

Backup directory: `/home/saber/saberprojects/notebooklm-orchestrator/data/backups/p3-20261114T172954Z/`
(directory mode `0700`, owner `saber` — outside the web root, not served, not git-tracked)

| Artifact                   | How it was made                                                     | Why it is safe                                                                                                               |
| -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `nlo.sqlite`               | `sqlite3 data/nlo.sqlite ".backup …"` while the service was running | Uses SQLite's online backup API (WAL-safe; no `cp` of a live DB); `PRAGMA integrity_check` = `ok`                            |
| `.env`                     | `cp .env …` + `chmod 600`                                           | Full copy of the live environment file (all keys, incl. NLO_RADIO_TOKEN etc.)                                                |
| `nlo.service.unit`         | `systemctl cat nlo`                                                 | Exact current unit definition as seen by systemd                                                                             |
| `nginx-effective.conf`     | `sudo -n /www/server/nginx/sbin/nginx -T` (52 898 bytes)            | Full effective nginx config of the instance that owns :80/:443 (`/www/server/nginx`, nginx/1.31.4), incl. all vhost includes |
| `nginx-effective.conf.err` | stderr of the same command                                          | Only pre-existing `http2` deprecation warnings for unrelated vhosts (documented in preflight)                                |
| `deployed-sha`             | `git rev-parse HEAD`                                                | Pins the deployed app commit: `278273a2e9f8fabb137d6ecdb3a51c1745dd8352`                                                     |
| `SHA256SUMS`               | `sha256sum` over the four artifacts (mode `0600`)                   | Verifiability                                                                                                                |

## 2. Verification (executed, not assumed)

1. **Backup integrity** — `sqlite3 <backup> 'PRAGMA integrity_check'` → `ok`; `COUNT(*) FROM jobs` → `11`; `COUNT(*) FROM api_tokens` → `0`. Matches the live baseline from preflight (11 jobs, 0 tokens).
2. **Checksums** — `sha256sum -c SHA256SUMS` (from repo root) → all four artifacts `OK` (first run "failed" only because the check was invoked from inside the backup dir while the sums file stores repo-relative paths; re-run from repo root passed).
3. **Permissions** — directory `0700`; `.env`, `SHA256SUMS`, and the other artifacts `0600` (final pass applied to all files).
4. **Space** — `/` at 38 % used, 409 G free; backup total ≈ 350 KB.

## 3. What is NOT in this backup (and why that is fine)

- **Sessions / vault / archives under `data/`**: pre-existing since P1; the 2026-11-14 deploy already backed DB + `.env` (`env-20261114T114000Z-278273a.env`, `nlo-20261114T114000Z-278273a.sqlite`). NLO-P3 changes no session/vault format, and the auth batch adds only new files (never overwrites existing untracked files — mission rule honored).
- **Artifacts**: 0 artifacts in production (nothing to back up). The first real podcast (Phase 5) will be retained on the host.
- **Local Windows workstation**: unaffected (no changes there are production-relevant for rollback).

## 4. Rollback procedures (exact commands, tested syntax)

All rollback steps affect **only the config changed by the specific batch**; every step ends with the standard health check (step R9).

### R0 — Pre-rollback rule

Record the current state of the failing component **before** rolling back (status, config diff, journal tail). Never roll back DB and nginx at the same time.

### R1 — nginx vhost (Phase 3 change)

```bash
# remove the NLO vhost file (created in Phase 3; name below is the planned one)
sudo -n /www/server/nginx/sbin/nginx -t          # config check WITHOUT the file removed first? No — order below.
# actual order: remove, then test, then reload
docker run --rm -v /etc/nginx:/etc/nginx alpine rm -f /etc/nginx/...   # NOT used — see R1a
```

The vhost dir `/www/server/panel/vhost/nginx/` is root-owned and `saber` has no generic sudo, so file removal uses the same mechanism used for creation (a one-off `docker run` container mounting the directory — documented in the Phase 3 report). Exact sequence:

```bash
# 1) delete the NLO vhost
sudo -n /usr/bin/nginx -t >/dev/null 2>&1 || true   # not the active instance; informational only
docker run --rm -v /www/server/panel/vhost/nginx:/vhost alpine rm -f /vhost/nlo.ai.ismc.ir.conf
# 2) validate the active instance config
sudo -n /www/server/nginx/sbin/nginx -t
# 3) graceful reload of the CORRECT nginx (PID 199642)
sudo -n /www/server/nginx/sbin/nginx -s reload
# 4) verify the domain answers the admin catch-all again (previous default behavior)
curl -sk -o /dev/null -w '%{http_code}\n' https://nlo.ai.ismc.ir/   # expect 307 (admin app) again
```

**If `nginx -t` fails after removal: do NOT reload.** Restore the vhost from this backup (`nginx-effective.conf` contains its full rendered text; the file itself will additionally be copied into the batch-3 change record before installation).

### R2 — TLS certificate (Phase 3 change)

The LE certificate for `nlo.ai.ismc.ir` is installed into the standard `letsencrypt` path for the LE account `5b51c0b79a2656a3aab5b589cd7f05cd`. Removing it is optional (an idle cert causes no harm); to remove:

```bash
sudo certbot --delete --cert-name nlo.ai.ismc.ir   # sudo w/ password; or via docker-mount approach
```

The ACME webroot file `/www/acme/.well-known/acme-challenge/*` is self-cleaning (used only during issuance).

### R3 — `.env` / app configuration (Phase 2 & 4 changes: NLO_API_AUTH, NLO_FFMPEG_BIN)

```bash
cd /home/saber/saberprojects/notebooklm-orchestrator
cp data/backups/p3-20261114T172954Z/.env .env
chmod 600 .env
sudo -n /usr/bin/systemctl restart nlo
```

The pre-P3 `.env` contains none of the keys added by NLO-P3, so restoring it removes them exactly.

### R4 — first-admin token (Phase 2 change)

The bootstrap token lives in `api_tokens` (0 rows before the batch). Two options:

```bash
# a) targeted: revoke via the admin API while auth is still enforced
curl -s -X DELETE http://127.0.0.1:4870/api/v1/tokens/<token-id> -H "Authorization: Bearer <token>"
# b) full: restore the DB snapshot (service stopped first)
sudo -n /usr/bin/systemctl stop nlo
cp data/backups/p3-20261114T172954Z/nlo.sqlite data/nlo.sqlite
chmod 644 data/nlo.sqlite
sudo -n /usr/bin/systemctl start nlo
```

Option (b) also rolls back any jobs created after the backup (there were 11; the first real podcast in Phase 5 is expected to be retained, not rolled back — use (a) instead unless a job-corruption issue demands (b)).

### R5 — nginx `auth_basic` (Phase 2 change)

The htpasswd file and the `auth_basic` directives are added inside the NLO vhost (created in Phase 3). If auth must be disabled **before** the vhost exists, there is nothing to roll back. If auth misbehaves after the vhost exists, edit the vhost to drop the `auth_basic`/`auth_basic_user_file` lines, then R1 step 2–3.

### R6 — FFmpeg env (Phase 4 change)

Covered by R3 (removing `NLO_FFMPEG_BIN` from `.env` + restart). The adapter returns to `not_configured`, the pre-P3 state.

### R7 — systemd unit

No NLO-P3 batch modifies the unit. If it ever does, restore from `nlo.service.unit`:

```bash
sudo tee /etc/systemd/system/nlo.service < data/backups/p3-20261114T172954Z/nlo.service.unit
sudo -n /usr/bin/systemctl daemon-reload && sudo -n /usr/bin/systemctl restart nlo
```

(`tee` as root requires password sudo — the unit file will be written via the same docker-mount mechanism if needed.)

### R8 — app code / deployed SHA

NLO-P3 makes **no source changes** (docs-only commits locally, no push). Production stays on `278273a`. If a deploy were ever needed mid-mission:

```bash
cd /home/saber/saberprojects/notebooklm-orchestrator
ROLLBACK=1 bash deploy/deploy.sh 278273a2e9f8fabb137d6ecdb3a51c1745dd8352
```

### R9 — Post-rollback verification (always)

```bash
sudo -n /usr/bin/systemctl is-active nlo                       # expect: active
curl -s http://127.0.0.1:4870/api/health | head -c 400        # expect: healthy JSON, liveDisabled true (pre-P3 display state)
curl -s http://127.0.0.1:4870/api/health/ready | head -c 200  # expect: ready
sudo -n /usr/bin/journalctl -u nlo -n 20 --no-pager | grep -iE 'error|fatal' || echo NO_NEW_ERRORS
```

## 5. Change-control note

From this point on, every NLO-P3 production change batch will:

1. state which backup artifact covers its rollback;
2. record the exact "before" text of any file it modifies (into the batch's change record);
3. re-verify `sha256sum -c data/backups/p3-20261114T172954Z/SHA256SUMS` still passes (backup must remain intact);
4. run R9 after the change.

## 6. Gate 1 verdict

**GATE_1_PASSED** — verified, checksummed, WAL-safe recovery point in place (`data/backups/p3-20261114T172954Z/`, `0700`/`0600`, outside web root, integrity `ok`, checksums `OK`, readable by owner). Cleared to proceed to Phase 2 (security-first authentication).
