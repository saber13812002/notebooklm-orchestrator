# NLO Network & Nginx Audit (172.30.0.133 + DNS)

Mission: **NLO-ACCESS-REBASELINE-01** — companion report (Phases D + E).
Date: 2026-11-14. All commands read-only. Checks requiring `sudo` were
recorded as **BLOCKED**, not bypassed.

## 1. nginx stacks present on the host (VERIFIED — process + config inspection)

| Stack                        | Evidence                                                   | Notes                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BT Panel / aaPanel webserver | master **PID 2291**, user `www`                            | conf: `/www/server/panel/webserver/conf/webserver.conf` → `/www/server/nginx/conf/nginx.conf`; includes `/www/server/panel/vhost/nginx/*.conf`; `client_max_body_size 50m`; `server_tokens off`; `access_log off` |
| OpenResty/Kong               | saber PID 3565, `-p /usr/local/kong`                       | 8443 cert `CN=216.147.121.136` (aapanel.com); 8000 → 200                                                                                                                                                          |
| GitLab embedded nginx        | `/opt/gitlab/embedded/sbin/nginx -p /var/opt/gitlab/nginx` | runsv PID 12413 + svlogd; serves `git.ai.ismc.ir`                                                                                                                                                                 |
| Container nginx × 2          | `nginx -g 'daemon off;'` PIDs 4051 / 4082                  | Docker containers                                                                                                                                                                                                 |
| message+ workers             | additional worker processes                                | (port ≈ 8081)                                                                                                                                                                                                     |

- `/www/server/panel/vhost/nginx/` → **Permission denied** for `ls` as
  `saber` (root-owned); contents were inspected via the `nginx -T` dump
  instead.
- The config dump referenced other active vhosts
  (`sources.ai.ismc.ir.conf`, `tasnim.ai.ismc.ir.conf`) — evidence the panel
  vhost mechanism is in active use for other services.

## 2. Is there an NLO vhost? (VERIFIED)

- **Zero** matches for `nlo` or `4870` in the full `nginx -T` dump →
  **no NLO vhost and no upstream to `127.0.0.1:4870`**.
- SNI test: `https://nlo.ai.ismc.ir/` (against `127.0.0.1:443`) → default
  cert **CN=admin.ai.ismc.ir** (Let's Encrypt) → **307 → /login** (final 200).
- Identical behavior with `Host: admin.ai.ismc.ir` → the **catch-all vhost is
  the admin app**, not NLO.

## 3. TLS / Let's Encrypt (VERIFIED)

- Live LE certs on the host (`.ai.ismc.ir`): `admin`, `bot`, `chat2`, `chat`,
  `corpus`, `docs`, `eiis`, `grafana`, `kong`, `llmhub`, `mesbah`, `meshkat`,
  `rag`, `taghrir`.
- **No `nlo.ai.ismc.ir` cert exists** → the domain currently falls back to
  the catch-all default cert.
- `certbot` / `ufw` / `iptables` inspection → `sudo: a password is required`
  → **BLOCKED** (not bypassed, per mission rule).

## 4. GitLab on the same host (PARTIALLY VERIFIED)

- `https://git.ai.ismc.ir` → 302 → `/users/sign_in`.
- `/api/v4/projects?search=notebooklm` → 200 `[]` (no public project visible).
- `/api/v4/version` → 401 (authentication required).
- `gitlab-runner.service` active; `gitlab` unit reports `inactive` via
  systemctl while its processes are clearly running (runsv-managed) → overall
  GitLab service state recorded as **PARTIALLY VERIFIED**.

## 5. DNS (VERIFIED — no split-horizon)

| Name             | local resolver (172.22.6.1) | 1.1.1.1       | 8.8.8.8       |
| ---------------- | --------------------------- | ------------- | ------------- |
| `nlo.ai.ismc.ir` | 185.213.10.25               | 185.213.10.25 | 185.213.10.25 |

- A record only (no AAAA / CNAME observed); reverse of `185.213.10.25` →
  NXDOMAIN.
- **DNS is not the problem**: the name resolves consistently everywhere.

## 6. TCP reachability matrix (VERIFIED)

From the workstation (`172.27.128.1`):

| Target         | :22  | :443 | :4870     |
| -------------- | ---- | ---- | --------- |
| `172.30.0.133` | True | True | **False** |

Public side (`185.213.10.25`):

| :80  | :443 | :4870     |
| ---- | ---- | --------- |
| True | True | **False** |

- `https://nlo.ai.ismc.ir/` → 307; `http://nlo.ai.ismc.ir/` → 301.
- `185.213.10.25` being the public face of `AI-TOOLS`: **PARTIALLY VERIFIED**
  (its :443 catch-all serves a certificate present in this server's LE
  inventory).
- `curl ifconfig.me` from the server → 403 (egress through a proxy), so the
  server's exact public IP was not directly confirmed.
- Public internet access as seen from a truly independent vantage point:
  **NOT VERIFIED** (no external test device available in this mission).

## 7. Answers to the diagnostic questions

1. **Is an nlo vhost active?** No — it does not exist in the config.
2. **Does the upstream (127.0.0.1:4870) respond?** Yes — 200 from the host;
   but nothing proxies to it.
3. **Is a valid NLO cert in place?** No — no nlo cert; the default admin cert
   is served for the name.
4. **Is LE renewal active for nlo?** No — there is no cert to renew.
5. **301/302 behavior:** observed (http→https on the domain; GitLab →
   sign-in) — expected, not NLO errors.
6. **403/404/502/504 for NLO:** **not observed** — there is no NLO route at
   all; the domain is answered by the catch-all admin app (307 → /login →
   200).
7. **What does a browser see?** The admin application's login page — not NLO.

## 8. Conclusions

- Network and DNS are fine. The gap is entirely at the **reverse-proxy
  layer**: no vhost, no upstream, no certificate for `nlo.ai.ismc.ir`.
- Firewall state for `:4870`: **PARTIALLY VERIFIED** (requires sudo).
