# NLO-P3 Batch 3 — Phase A: Fresh Production Rebaseline

- **Mission**: NLO-P3-BATCH3-EXECUTE-2026-11
- **Date (UTC)**: 2026-11-15T09:25Z – 09:35Z
- **Host**: `AI-TOOLS` (`172.30.0.133`)
- **Verdict**: **PROCEED** — host confirmed as intended production host; no concurrent operator activity on any Batch-3 target resource.

## 1. Host identity (A1)

| Item             | Value                                                                                                                                        | Evidence          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Hostname         | `AI-TOOLS`                                                                                                                                   | `hostname`        |
| OS               | Ubuntu 24.04.4 LTS                                                                                                                           | `/etc/os-release` |
| Operator user    | `saber` (uid 1001, docker group)                                                                                                             | `whoami`/`id`     |
| Docker           | client/server 29.1.3                                                                                                                         | `docker version`  |
| Disk `/`         | 686 G total, 250 G used, **409 G free (38%)**                                                                                                | `df -h /`         |
| Public listeners | `0.0.0.0:80`, `0.0.0.0:443`, `[::]:80`, `[::]:443` (nginx), `127.0.0.1:4870` (node)                                                          | `ss -tln`         |
| Certbot image    | `certbot/certbot:latest` = `sha256:186bfc6591d8863694654a3671b4d185145bdf4c01eca700778e7fa0293d22bf`, created 2026-11-10T22:32Z, linux/amd64 | `docker inspect`  |

## 2. NLO runtime (A2)

| Item                              | Value                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `nlo.service`                     | **active** + **enabled**                                                                                 |
| Process                           | PID 2809780 `tsx src/main.ts` → node child 2809792 (uptime 15 h 51 min — unchanged since Gate 2)         |
| Working dir / commit              | `/home/saber/saberprojects/notebooklm-orchestrator`, HEAD **`278273a2e9f8fabb137d6ecdb3a51c1745dd8352`** |
| Bind                              | **`127.0.0.1:4870` only** (loopback confirmed in `ss -tlnp`, owner `node` pid 2809792)                   |
| `/api/health`                     | `{"ok":true,"service":"notebooklm-orchestrator",…}`                                                      |
| `/api/health/ready`               | `{"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},…}`           |
| `/api/openapi.json` / `/api/docs` | 200 / 200                                                                                                |
| `/api/v1/health`                  | 200                                                                                                      |

No modification and no restart of NLO during this phase.

## 3. Which nginx serves public 80/443 (A3) — the critical identification

The host runs **four** nginx-related processes; only one owns public 80/443:

| Master PID  | Executable / config                                                                             | Workers               | Owned ports                                            | Role                                            |
| ----------- | ----------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| **199642**  | `/www/server/nginx/sbin/nginx -c /www/server/nginx/conf/nginx.conf` (nginx **1.31.4**)          | 20 × `www` (uid 1003) | **`0.0.0.0:80`, `0.0.0.0:443`, `[::]:80`, `[::]:443`** | **PUBLIC edge — the instance Batch 3 targets**  |
| 2291        | `/www/server/panel/webserver/sbin/webserver -c /www/server/panel/webserver/conf/webserver.conf` | 1 × `www`             | `0.0.0.0:8443` (+`[::]:8443`)                          | BT/aaPanel panel UI (proxies `/tmp/panel.sock`) |
| 3565        | `/usr/local/openresty/nginx/sbin/nginx -p /usr/local/kong -c nginx.conf`                        | (kong)                | none of 80/443                                         | Kong gateway                                    |
| 4051 / 4082 | `nginx -g daemon off;` (containerized, user `message+`)                                         | per container         | none of 80/443                                         | Docker-internal (e.g. GitLab)                   |

**Proof that `nginx -t` / `nginx -s reload` target 199642** (the public instance):

- `sudo -n /www/server/nginx/sbin/nginx -T` (run as root, full config dump) shows `pid /www/server/nginx/logs/nginx.pid;` and `include /www/server/panel/vhost/nginx/*.conf;` (line 97) and contains `nlo.ai.ismc.ir` (5 occurrences).
- `docker cat` of `/www/server/nginx/logs/nginx.pid` → **`199642`** — the same PID that `ss -tlnp` shows owning `:80`/`:443`.
- `/www/server/panel/webserver/logs/webserver.pid` → `2291` (the panel instance; its config only listens on 8443, so a reload of it could never touch 80/443).
- The pre-existing M2-7-SSL-02 deploy hook (`/etc/letsencrypt-cloudflare/renewal-hooks/deploy/reload-nginx.sh`) uses exactly `/www/server/nginx/sbin/nginx -t` then `-s reload` — the same binary, same pidfile, same instance.

**Conclusion**: `sudo -n /www/server/nginx/sbin/nginx -t` and `-s reload` act on the public 80/443 instance and on none other. This is the reload mechanism used by Phases E/G/I.

### Vhost inventory (A3, read-only)

Vhost dir `/www/server/panel/vhost/nginx/` (root 0700): 16 domain vhosts + includes. The NLO vhost is the **Stage-A** file:

```
-rw-r--r-- 1 root root 594 Nov  3 16:59 nlo.ai.ismc.ir.conf
```

- Content (594 B): port-80-only server, `server_name nlo.ai.ismc.ir`, ACME location `root /www/acme`, `location / { return 301 https://$host$request_uri; }`.
- SHA-256: **`1697a95418de93a1232c343d53f9616bf518fd52773e4f5ff718722aadd07960`** (identical to the 2026-11-14 backup `nlo.ai.ismc.ir.conf.stageA-20261114T1759Z`).
- SNI baseline before this batch: `nlo.ai.ismc.ir` over 443 returns the **default vhost cert** `CN=admin.ai.ismc.ir` (LE YE2, valid to 2027-01-01) — i.e. today the domain hits the default vhost, **not** an NLO server block (Stage-A listens on port 80 only).

## 4. Concurrent-operator protection (A4)

| Check                                              | Result                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vhost dir mtime                                    | `Nov 14 12:40` (= 2026-11-14 12:40 UTC, M2-7-SSL-02 cert-store setup; before this mission)                                                                                                                                                                                               |
| `nlo.ai.ismc.ir.conf` mtime                        | **2026-11-03 16:59:31 UTC** — untouched since Stage-A was created                                                                                                                                                                                                                        |
| Any vhost file modified 2026-11-14 17:00 UTC → now | **none** (full listing scan; latest non-nlo vhost mtimes are 2026-10-31 or earlier)                                                                                                                                                                                                      |
| Running certbot processes                          | **none** (`pgrep -af 'cf-certbot\|certbot renew'` empty; no certbot docker containers)                                                                                                                                                                                                   |
| `certbot-cf.timer`                                 | **enabled**; last run 2026-11-15 04:21:52 UTC finished cleanly — journal: `No renewals were attempted.` (isolated store is empty until Batch 3 issues)                                                                                                                                   |
| Staged host scripts vs local                       | hashes match exactly: `issue-nlo-cert.sh` `54484b1eb9057870c9fcbd7bb6dcb6103b87fc0aef567f5c0894bd8d796ad06b`, `install-vhost.sh` `5b4c3d3fb891127b7b5f0b04f7384ed50039a5c74596eba0cb422b7e5e6e993c`, `p3-stageB.conf` `12ea344a744c9ff844829c6226246e51b012a9320355b27e88f2a84e2a5a6250` |
| `/www/acme` webroot                                | `p3test` (planted by us 2026-11-14 17:45, to be removed after go-live) + pre-existing `m27-probe` (Nov 13), `nlo-selftest-66e907f` (Nov 2)                                                                                                                                               |

No other operator touched any Batch-3 resource since the 2026-11-14 preflight. **No STOP condition.**

## 5. DNS state (A/H1 pre-check)

Via Cloudflare DoH (`1.1.1.1/dns-query`), 2026-11-15T09:33Z:

| Record                | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `nlo.ai.ismc.ir` A    | `185.213.10.25`, TTL 300                                                  |
| `nlo.ai.ismc.ir` AAAA | **none**                                                                  |
| `nlo.ai.ismc.ir` TXT  | **none** (clean for DNS-01)                                               |
| SOA                   | `indie.ns.cloudflare.com. dns.cloudflare.com.` (Cloudflare-authoritative) |

## 6. Local git baseline

- Branch `main`, HEAD **`76cd5f0`**, 3 ahead of `origin/main` (`4e2d533`), working tree clean, **no push** (remote state untouched by this mission so far).

## 7. Residual risks / notes

1. `certbot/certbot:latest` is a floating tag (image id pinned above: `sha256:186bfc65…22bf`, created 2026-11-10). It is **already pulled on the host**; Batch 3 uses the local copy and does not re-pull. Phase C records the identity.
2. The BT-panel `webserver` (2291) and the public nginx (199642) are separate processes with separate pidfiles — a `-s reload` issued from `/www/server/nginx/sbin/nginx` cannot affect the panel.
3. The public nginx `nginx.conf` sets `client_max_body_size 50m` at http level; the Stage-B vhost overrides it with `210m` for NLO (already in the rendered file) — no http-level change needed or made.
4. Default-vhost fallback: while the Stage-A vhost (port 80 only) is active, HTTPS for the domain currently answers with the `admin.ai.ismc.ir` default cert (behavior since 2026-11-03, pre-existing, unchanged).
