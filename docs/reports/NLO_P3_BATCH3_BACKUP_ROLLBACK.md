# NLO-P3 Batch 3 — Phase D: Pre-Change Backup & Rollback

- **Mission**: NLO-P3-BATCH3-EXECUTE-2026-11
- **Date (UTC)**: 2026-11-15T09:35Z
- **Gate D verdict**: **PASS** — fresh recovery point created, integrity-verified, rollback script ready and syntax-checked. Vhost replacement (Phase G) is cleared **after** Phase E issues the certificate.

## 1. Fresh backup targets (D1)

All captured **read-only** (docker volume mounts; nothing modified on the host) into the gitignored local dir `data/backups/p3-20261114T172954Z/`.

| #   | Target                                                                                      | Local file                                                                                 | Size      | SHA-256                                                            | Notes                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Active NLO vhost (Stage-A) `/www/server/panel/vhost/nginx/nlo.ai.ismc.ir.conf`              | `nlo.ai.ismc.ir.conf.stageA-20261115T0935Z`                                                | 594 B     | `1697a95418de93a1232c343d53f9616bf518fd52773e4f5ff718722aadd07960` | **Byte-identical** to the 2026-11-14 backup (`stageA-20261114T1759Z`, same hash) → live file unchanged overnight; mtime on host 2026-11-03 16:59:31 |
| 2   | Public nginx root config `/www/server/nginx/conf/nginx.conf` (+ panel `webserver.conf`)     | `phaseD-config-backups-20261115T0940Z.txt` (sections `===NGINX_CONF`, `===WEBSERVER_CONF`) | 228 lines | `0dd8d2d2c0516a68ea1a7bd1593a1103069703934641727dc2d00079b63c6c4d` | Full text captured; include tree documented in rebaseline §3                                                                                        |
| 3   | Browser-auth material `/etc/nginx/nlo-htpasswd`                                             | same file, section `===NLO_HTPASSWD`                                                       | 111 B     | (within #2)                                                        | SHA-512 crypt hash (stored form, not plaintext); Gate-2 A12 worker-readability already verified                                                     |
| 4   | CF credential file `/etc/letsencrypt-cloudflare/credentials/cloudflare.ini`                 | same file, section `===CF_CRED`                                                            | 57 B      | (within #2)                                                        | Currently holds the **dummy** probe token from the 2026-11-14 dry run; Phase E overwrites it with the real token (root:root 0600)                   |
| 5   | Renewal unit files `certbot-cf.service` / `certbot-cf.timer`                                | recorded verbatim in `NLO_P3_BATCH3_REBASELINE.md` §4 + Phase C report                     | —         | —                                                                  | `systemctl is-enabled certbot-cf.timer` = enabled; last run clean                                                                                   |
| 6   | Deploy hook `/etc/letsencrypt-cloudflare/renewal-hooks/deploy/reload-nginx.sh`              | recorded verbatim in Phase C report                                                        | 1656 B    | —                                                                  | M2-7-SSL-02; reloads the public instance (rebaseline §3)                                                                                            |
| 7   | Isolated cert store state `/etc/letsencrypt-cloudflare/{live,renewal,accounts,credentials}` | recorded in rebaseline §4 + Phase C report                                                 | —         | —                                                                  | `live/` **empty** (no existing NLO cert to preserve), `accounts/` empty, `credentials/` = dummy file only                                           |
| 8   | ACME webroot `/www/acme/.well-known/acme-challenge/`                                        | recorded in rebaseline §4                                                                  | —         | —                                                                  | `p3test` (ours, removed post go-live); `m27-probe`, `nlo-selftest-66e907f` pre-existing — **untouched**                                             |

**No private key is stored in git** (the NLO live dir is empty; `data/` is gitignored anyway). Backups live outside the web root (`/home/saber/saberprojects/…/data/backups/…`, host mode inherited `0700`-ish home; local dir gitignored).

## 2. Integrity verification (D2)

- Every backup was re-hashed after capture (table above; hashes computed with `Get-FileHash`/`sha256sum` and cross-checked local↔host for the three staged scripts in rebaseline §4).
- The Stage-A backup was **read back** from the host and its SHA-256 equals the 2026-11-14 capture → the on-disk file is verifiable and uncorrupted.
- Timestamps: capture 2026-11-15 09:35–09:40 UTC; source vhost mtime 2026-11-03 16:59:31 UTC.

## 3. Rollback procedure (D3)

Rollback restores **only the NLO vhost** (never other vhosts) and leaves the issued certificate in place (a cert with no vhost referencing it is inert):

```bash
# on host, as saber (already staged):
/tmp/p3-install-vhost.sh rollback     # swaps BACKUP_FILE over the live vhost (root via docker)
/tmp/p3-install-vhost.sh check        # sudo -n /www/server/nginx/sbin/nginx -t  (must pass before reload)
/tmp/p3-install-vhost.sh reload       # sudo -n /www/server/nginx/sbin/nginx -s reload (public instance only)
/tmp/p3-install-vhost.sh verify       # re-run probes: expect the pre-Batch-3 behavior (Stage-A: 301 from :80, default-vhost HTTPS)
```

- `BACKUP_FILE` in [`install-vhost.sh`](data/backups/p3-20261114T172954Z/install-vhost.sh:14) points to `…/data/backups/p3-20261114T172954Z/nlo.ai.ismc.ir.conf.stageA-20261114T1759Z` (same 594 B file, same hash `1697a954…`).
- Rollback semantics: after rollback the domain serves Stage-A again (HTTP→301; HTTPS answers via the default vhost) — i.e. exactly the pre-Batch-3 state. NLO itself (`127.0.0.1:4870`) is never restarted by the rollback.
- `swap`/`rollback` use `docker run alpine` to copy into the root-owned vhost dir (saber has no generic sudo); `check`/`reload` use `sudo -n` on the exact public binary (NOPASSWD-authorized), which reloads instance 199642 only (rebaseline §3).
- If `nginx -t` fails after a swap: **no reload happens** (check exits non-zero first); the previous config stays live; re-run `rollback`.

## 4. What rollback does NOT touch

Other vhosts, the panel nginx (2291), Kong, docker-internal nginxs, NLO service, DB/sessions/artifacts, the issued certificate files, `certbot-cf.{service,timer}`, and all non-NLO DNS records.
