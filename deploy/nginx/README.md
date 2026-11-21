# NLO — Nginx / HTTPS deployment templates

Reusable, host-agnostic nginx vhost templates + staged deploy helper for putting
NLO behind an HTTPS reverse proxy. Recovered (2026-11-03, Phase R1) from
one-shot scripts in `tmp/` that had already been **partially executed on the
production host** (Stage A live; certbot issuance blocked by DNS — see
[`docs/reports/PHASE_R_RECONCILIATION.md`](../../docs/reports/PHASE_R_RECONCILIATION.md) §4.4).

**NLO remains loopback-only (`127.0.0.1:4870`).** The proxy adds TLS and a
public entry point; it does not change the NLO bind, firewall, or app auth.

## Files

| File                             | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `nlo-vhost.stageA.conf.tpl`      | HTTP-only vhost: ACME HTTP-01 challenge + 301 to HTTPS   |
| `nlo-vhost.stageB.conf.tpl`      | Full vhost: ACME + HTTPS reverse proxy to NLO            |
| `nlo-vhost.stageB-auth.conf.tpl` | Full vhost + **Basic auth on 443** (Stage deployments)   |
| `ngx-map-connection.conf.tpl`    | One-time `http {}` map for WebSocket/SSE upgrade         |
| `nlo-nginx-deploy.sh`            | Render → backup → install → `nginx -t` → reload → verify |

## Placeholders (rendered by the deploy script via literal `__NLO_*__` substitution)

| Env var             | Meaning                                                              | Example (AI-TOOLS)              |
| ------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `NLO_DOMAIN`        | public domain fronting NLO                                           | (internal service FQDN)         |
| `NLO_VHOST_DIR`     | webserver vhost dir on the host                                      | `/www/server/panel/vhost/nginx` |
| `NLO_LOG_DIR`       | webserver log dir                                                    | `/www/wwwlogs`                  |
| `NLO_ACME_WEBROOT`  | certbot webroot                                                      | `/www/acme`                     |
| `NLO_CERT_DIR`      | issued cert dir (default `/etc/letsencrypt/live/$NLO_DOMAIN`)        | —                               |
| `NLO_UPSTREAM`      | NLO loopback upstream (default `127.0.0.1:4870`)                     | —                               |
| `NLO_MAX_UPLOAD_MB` | `client_max_body_size` (default `210` = 200 MB + multipart headroom) | —                               |
| `NLO_BACKUP_DIR`    | pre-change vhost backup dir (default `/www/backup`)                  | —                               |
| `NLO_AUTH_FILE`     | htpasswd file (stageBAuth only; `0640 root:www`)                     | `/etc/nginx/htpasswd-nlo2`      |

## Procedure (approved, stepwise — each step is individually verifiable)

1. **Preconditions (external, human-verified):**
   - Public DNS A record for `NLO_DOMAIN` resolves to the edge/firewall IP that
     forwards :80 and :443 to this host. (On AI-TOOLS this was the
     **blocker**: `nlo.ai.ismc.ir` → `185.213.10.25`, not `172.30.0.133`,
     and certbot's HTTP-01 timed out.)
   - External :80 reachability for the ACME path.
   - `NLO_UPSTREAM` answers `GET /api/health/ready` locally.
2. **Stage A** (HTTP-only):
   `NLO_DOMAIN=… NLO_VHOST_DIR=… NLO_LOG_DIR=… NLO_ACME_WEBROOT=… sudo bash deploy/nginx/nlo-nginx-deploy.sh stageA`
   Installs a _new_ file `<NLO_DOMAIN>.conf` in the vhost dir, backs up the whole
   vhost dir first, verifies a local 301 with the NLO host header.
3. **Certificate** (manual step — an externally visible action, deliberately not
   scripted):
   `sudo certbot certonly --webroot -w "$NLO_ACME_WEBROOT" -d "$NLO_DOMAIN" --key-type ecdsa --non-interactive --agree-tos -m <ACME_EMAIL>`
   `<ACME_EMAIL>` is environment-specific (never stored in this repo).
4. **Stage B** (full HTTPS): same env, `… nlo-nginx-deploy.sh stageB`.
   Refuses to run without an existing `fullchain.pem`/`privkey.pem`.
   Verifies local HTTPS 200 + HTTP 301.
5. **Stage B Auth** (full HTTPS + Basic auth — Stage deployments):
   same env plus `NLO_AUTH_FILE=/etc/nginx/htpasswd-…` (created with
   `sudo htpasswd -b -c $NLO_AUTH_FILE <user> <pass>`, chmod 0640 root:www),
   then `… nlo-nginx-deploy.sh stageBAuth`.
   Refuses to run without the issued certificate **and** the htpasswd file.
   Verifies local HTTPS **401** (auth gate) + HTTP 301.
6. **External verification** (after any approval for public exposure):
   `curl -sI https://$NLO_DOMAIN/api/health` and the UI from an external network.

## Rollback

```
sudo rm "$NLO_VHOST_DIR/$NLO_DOMAIN.conf" && sudo nginx -t && sudo systemctl reload nginx
```

Every run also leaves a full vhost-dir snapshot under `$NLO_BACKUP_DIR`.

## Review notes (Phase R1)

- **No hardcoded IPs, paths, or emails** in the templates (the recovered
  `tmp/` scripts had host-specific values: `/www/...` paths, a hardcoded ACME
  contact email, and a host IP reference — those live only in the one-shot
  copies, which are preserved but not committed).
- **No certificates, keys, or secrets** are referenced at rest: cert paths are
  placeholders rendered at deploy time; cert issuance stays a manual,
  separately-approved step.
- **Idempotency:** safe to re-run each stage; the map-snippet check is
  idempotent (grep before install); backups are timestamped and never
  overwritten.
- **Fail-closed:** unrendered `__NLO_*` placeholder → abort; `nginx -t` fails →
  abort without reload; missing cert → stage B aborts.
- **Render fix (P5-1A):** the original script called
  `envsubst '$NLO_DOMAIN …'` against templates whose placeholders are
  `__NLO_*__` — a no-op that rendered nothing, so the fail-closed grep would
  always abort. Rendering now substitutes each `__NLO_*__` placeholder
  literally (sed), and is fail-closed on any leftover.
- **Stage B fix over the recovered original:** the original hard-coded
  `Connection "upgrade"` for every request (breaks keep-alive on non-WS
  clients); the template uses the standard `$connection_upgrade` map instead.
- **stageBAuth (Stage):** adds `auth_basic` on the 443 server block and drops
  the WS/SSE upgrade headers (the current UI polls plain REST, and AI-TOOLS'
  main nginx config has no `$connection_upgrade` map) so the vhost is
  self-contained — the install touches only this one file. The 80 block stays
  auth-free so Let's Encrypt HTTP-01 can reach the challenge. The htpasswd
  password is a host secret (0640 root:www), never stored in this repo or in
  logs/reports.
- **Upload limit** tracks `NLO_MAX_UPLOAD_BYTES` (200 MB default) + 10 MB
  multipart headroom; **proxy timeouts** 600 s for long audio→text jobs;
  **security headers**: HSTS (1 y, includeSubDomains), nosniff, DENY,
  strict-origin-when-cross-origin; upstream 502/503/504 → readable 503 page.
