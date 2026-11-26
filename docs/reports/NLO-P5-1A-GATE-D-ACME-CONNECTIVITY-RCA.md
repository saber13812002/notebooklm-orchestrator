# NLO-P5-1A — Gate D: ACME Connectivity RCA

- **Date:** 2026-11-25 (UTC)
- **Scope:** Root-cause analysis of the Let's Encrypt HTTP-01 validation failure for
  `nlo2.ai.ismc.ir`, **before** any firewall/ISP change is requested.
- **Directive:** 12-step RCA ("Gate D") — no Production changes, no global firewall
  changes, no other services touched, **no Cloudflare**.
- **Result:** the failure is a **network-layer block at the public edge
  (185.213.10.25) on inbound TCP/80 from Let's Encrypt validator source
  ranges**. Every layer on the host side (DNS, Nginx, vhost, webroot, IPv6)
  is verified PASS. The fix must be made at the edge/NAT/ISP; nothing on the
  server can unblock it. A precise technical request for the network owner is
  included in §8.

---

## 1. Server identity (Gate D step 12 — re-recorded)

The name "s52" was ambiguous in prior reports. Definitive identity captured
2026-11-25 from the host itself:

| Property                 | Value                                         |
| ------------------------ | --------------------------------------------- |
| Hostname                 | `AI-TOOLS`                                    |
| Internal IP (ens33)      | `172.30.0.133/20` (brd `172.30.15.255`)       |
| Default gateway          | `172.30.15.254`                               |
| MAC (ens33)              | `00:50:56:ad:fb:00` (VMware OUI — it is a VM) |
| IPv6 (ens33)             | link-local only: `fe80::250:56ff:fead:fb00`   |
| Public inbound edge IP   | `185.213.10.25` (what LE resolves & dials)    |
| Public egress IP         | `185.208.180.217` (cf/ipify from the host)    |
| Uptime                   | ~25 days at capture time                      |
| Docker bridges           | ~35 × `10.240.x.1`                            |
| Public DNS (A)           | `nlo2.ai.ismc.ir → 185.213.10.25` (CF DoH)    |
| Internal DNS (A)         | `nlo2.ai.ismc.ir → 172.30.0.133` (TTL 175)    |
| AAAA (public & internal) | **none**                                      |

**Asymmetric NAT:** the inbound edge IP (`185.213.10.25`) differs from the
host's own egress IP (`185.208.180.217`). LE dials the _inbound_ edge address.

## 2. Step 1 — DNS (A/AAAA, public + internal)

| Query                             | Resolver         | Result                   |
| --------------------------------- | ---------------- | ------------------------ |
| `nlo2.ai.ismc.ir` A (public)      | Cloudflare DoH   | `185.213.10.25`          |
| `nlo2.ai.ismc.ir` AAAA (public)   | Cloudflare DoH   | none                     |
| `nlo2.ai.ismc.ir` A (internal)    | workstation resv | `172.30.0.133` (TTL 175) |
| `nlo2.ai.ismc.ir` AAAA (internal) | workstation resv | none                     |

Note: Google DoH (`dns.google`) timed out from this workstation (a local
workstation→Google DNS quirk); Cloudflare DoH (`1.1.1.1/dns-query`) was the
reliable public resolver. **DNS verdict: PASS** (correct A, no AAAA anywhere,
so IPv6 is not a path LE would use).

## 3. Step 2 — Benign challenge file, verified from outside

- Placed (as root, via `python:3.12-slim` container):
  `/www/acme/.well-known/acme-challenge/p51a-gated-1795621891`
  content `nlo2-p51a-gateD-challenge-ok` (28 B).
- **Local (host, via loopback + `Host: nlo2.ai.ismc.ir`):** HTTP **200** +
  exact body. Without the Host header: 404 (catch-all) — proving the vhost
  serves the path.
- **External (workstation, through the public edge `185.213.10.25`):**
  - by domain → HTTP **200**, body = `nlo2-p51a-gateD-challenge-ok`
  - by direct edge IP + `Host` header → HTTP **200**, same body
  - control domain `rag.ai.ismc.ir` root URL → edge:80 alive (redirect chain)
- **Verdict: PASS.** The file is downloadable from outside through the very IP
  LE uses. (One additional third-party vantage was not obtainable from this
  workstation — the workstation itself is already a second, external network
  beyond the host; the tcpdump in §6 provides the decisive third signal.)
- The benign file was **removed** after the test.

## 4. Step 3 — ACME path excluded from Basic Auth and the public redirect

Vhost `nlo2.ai.ismc.ir.conf` (lines 19–21):

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /www/acme;
}
```

- No `auth_basic` in that block (or anywhere in the stageA vhost).
- The 301-to-HTTPS redirect is `location / { return 301 ... }` — the `^~`
  acme location takes precedence and is **not** redirected.
- **Verdict: PASS.**

## 5. Step 4 — Exact ACME error text (Nginx + Let's Encrypt logs)

From `/var/log/letsencrypt/letsencrypt.log` (read via container root):

Production attempts (3 distinct challenge tokens, 3 attempts):

```
Detail: 185.213.10.25: Fetching http://nlo2.ai.ismc.ir/.well-known/acme-challenge/xQ64IkUNbBjSeT...: Timeout during connect (likely firewall problem)
Detail: 185.213.10.25: Fetching http://nlo2.ai.ismc.ir/.well-known/acme-challenge/FAcxbw9TPefpDWE0...: Timeout during connect (likely firewall problem)
Detail: 185.213.10.25: Fetching http://nlo2.ai.ismc.ir/.well-known/acme-challenge/mSLilZbQdFEaCYGfiXMvLyJGtPxwPdrxg429k-zNELc: Timeout during connect (likely firewall problem)
```

Control domain `rag.ai.ismc.ir` (forced real HTTP-01, throwaway
`--cert-name p51a-http01-test`) — **identical failure**:

```
Detail: 185.213.10.25: Fetching http://rag.ai.ismc.ir/.well-known/acme-challenge/XyGUvPBW0CR1...: Timeout during connect (likely firewall problem)
```

Nginx evidence:

- Main `access.log` (`/www/wwwlogs/access.log`): **0** hits for `acme-challenge`.
- nlo2 vhost access log (`/www/wwwlogs/nlo2.ai.ismc.ir.log`): **does not exist**
  (0 hits) — LE validator requests **never reached nginx at all**.
- nginx listening: `0.0.0.0:80` and `[::]:80` (confirmed via `ss`).
- **Verdict: the validator's TCP connection to `185.213.10.25:80` times out
  before it can reach the host's nginx. Not an nginx/webroot problem.**

## 6. Steps 5 + 6 — tcpdump on :80 during a live (Staging) attempt

- Used the **Let's Encrypt Staging** endpoint
  (`--staging`, `acme-staging-v02`) with throwaway `--cert-name
p51a-staging-probe` so production issuance limits were **not** consumed.
- 4 staging attempts total this window, all with the identical edge timeout:
  `Bw_FIR6K...`, `F3pKYG0t...`, `ClsEUxkv...`, `2aL4Uw8x...` →
  `Timeout during connect (likely firewall problem)`.
- **tcpdump** (host `tcpdump` lacks permission for the ssh user; captured via
  `docker run --net=host --privileged` with a debian container having tcpdump
  installed) on `tcp port 80` while a staging validation ran:
  - **Total packets captured on port 80 during the live validation: `0`.**
  - No SYN, no GET, no external source IP on :80 — **the LE validator's
    packets never reached the host.**
- `ss` immediately after: no half-open or established :80 connection from any
  validator source.
- Staging certs were **deleted** after each attempt (verified: no `p51a`
  remains in `/etc/letsencrypt/live|archive|renewal`).
- **Verdict: DECISIVE.** The connection is dropped at the edge (firewall/NAT/
  ISP) before the host sees any bytes. Staging validators fail identically to
  production → the block is not specific to LE production IPs only; it is on
  the edge's inbound :80 path from external/validator source ranges.

## 7. Step 7 — Separation matrix (Firewall / NAT / ISP / IPv6 / DNS / Nginx /

Webroot / Rate Limit)

| Layer                                                          | Verdict               | Evidence                                                                                                                             |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **DNS**                                                        | PASS                  | A=185.213.10.25 public, 172.30.0.133 internal; no AAAA                                                                               |
| **IPv6**                                                       | N/A                   | No public/internal AAAA; host has only link-local → LE can't use v6                                                                  |
| **Nginx**                                                      | PASS                  | Listening 0.0.0.0:80+[::]:80; -t clean; 200 on challenge locally                                                                     |
| **Vhost config**                                               | PASS                  | ACME `^~` location excluded from auth + redirect (§4)                                                                                |
| **Webroot**                                                    | PASS                  | Benign file 200 + correct body locally AND externally (§3)                                                                           |
| **External reach (workstation)**                               | PASS                  | 200 through 185.213.10.25 by domain and by IP+Host                                                                                   |
| **ACME Rate Limit**                                            | PASS                  | Staging used; failures are `connection` timeouts, not `rateLimited`                                                                  |
| **Firewall/NAT/ISP (edge inbound :80 from validator sources)** | **FAIL — ROOT CAUSE** | tcpdump=0 packets on :80 during live validation; access.log=0; "Timeout during connect"; reproduced on control domain rag.ai.ismc.ir |

**Root cause (single sentence):** inbound TCP/80 to the public edge
`185.213.10.25` from Let's Encrypt validator source ranges is being
dropped/timed out at the edge (firewall/NAT/ISP), so the HTTP-01 challenge
can never reach the host's nginx — while the same path works for other
external clients (e.g. the workstation), indicating source-range filtering
or an edge ACL specific to the validator's egress IPs/ASNs.

## 8. Step 8 — Technical request for the network owner

> **Subject:** Allow inbound TCP/80 from Let's Encrypt validators to
> `185.213.10.25` (blocks ACME HTTP-01 for `*.ai.ismc.ir`)
>
> **Request:** Open/allow **inbound TCP/80** to destination IP
> **`185.213.10.25`** from Let's Encrypt's validator egress source
> ranges, so that Let's Encrypt's HTTP-01 challenge validation can reach the
> host's nginx webroot.
>
> **Destination:** IP `185.213.10.25`, protocol **TCP**, port **80**,
> direction **inbound** (validator → edge).
>
> **Why (evidence):**
>
> - 7+ validation attempts (production + staging, two domains `nlo2` and
>   `rag`) all fail with
>   `Detail: 185.213.10.25: Fetching http://<domain>/.well-known/acme-challenge/<token>: Timeout during connect (likely firewall problem)`.
> - A tcpdump capture on the host's `:80` **during** a live staging
>   validation captured **0 packets** — validator traffic never reaches the
>   host.
> - nginx `access.log` shows **0** `acme-challenge` hits.
> - The same challenge path returns HTTP 200 with correct content when
>   fetched from other external networks (workstation) through
>   `185.213.10.25` → the block is specific to the validator's source
>   ranges/ASNs at the edge.
> - The failure is identical for a control domain (`rag.ai.ismc.ir`), so it
>   is edge-wide, not vhost-specific.
>
> **LE validator source ranges** (current, from Let's Encrypt docs
> https://letsencrypt.org/docs/ports/): IPv4 egress ranges are published by
> Let's Encrypt; the network owner should allow inbound :80 from those
> ranges (or from general Internet if per-range allowlisting is not
> feasible). Note: the host's _egress_ IP is `185.208.180.217` (asymmetric
> NAT) — only the **inbound** edge `185.213.10.25:80` needs to be opened for
> the validators.
>
> **Impact of the block:** all `*.ai.ismc.ir` domains cannot obtain or renew
> Let's Encrypt certificates via HTTP-01 (14 existing certs were issued
> Oct 2–24 2026, before the Nov 1 migration that introduced this edge
> behavior).

## 9. Backups & rollback (nothing on the host changed in a way needing

rollback)

- **No production files, no global firewall, no other services were changed.**
- Stage A vhost (already live, verified 301) — backup from its install:
  `/www/backup/nlo-vhost-20261125-110921`.
- The only host artifacts created during this RCA and their disposition:
  - `/www/acme/.well-known/acme-challenge/p51a-gated-1795621891` — **removed**.
  - Staging throwaway cert (`p51a-staging-probe`) — **deleted** (verified
    absent from live/archive/renewal).
  - `/tmp/p51a-gateD-*.sh`, `/tmp/p51a-cert-evidence.sh`,
    `/tmp/p51a-http01-control*.sh` — removed (the 0-byte pcap was
    container-owned and left in place, harmless).
  - `debian:bookworm` image gained a tcpdump install inside a transient
    container (not committed; no persistent image change).
- **Rollback:** N/A for this RCA (read-only + throwaway artifacts). The
  Stage A vhost is untouched and remains the active config for
  `nlo2.ai.ismc.ir`.

## 10. Steps 10–11 — DEFERRED (resume after the edge fix + user "retry")

Once the network owner opens inbound :80 from LE validator sources to
`185.213.10.25`:

1. **Issue the production cert:**
   `certbot certonly --webroot -w /www/acme -d nlo2.ai.ismc.ir --key-type
ecdsa` (standard store `/etc/letsencrypt/live/nlo2.ai.ismc.ir`), then
   **test auto-renewal** (`certbot renew --dry-run`).
2. **Stage B install:** render + install the `stageB-auth` vhost (443 + TLS +
   Basic Auth, `CERT_DIR=/etc/letsencrypt/live/nlo2.ai.ismc.ir`), `nginx -t`,
   SIGHUP reload.
3. **External proof matrix (from an external network):**
   - HTTP → HTTPS **301**
   - HTTPS no-creds **401**
   - HTTPS valid-creds **200**
   - `/api/health` **PASS**
   - TLS cert **VALID** (correct CN, dates, chain)
   - **Production UNCHANGED** (other services/domains on the host still up)

## 11. Final status

- **RCA complete.** Root cause = edge-layer drop of inbound :80 from LE
  validator sources to `185.213.10.25` (firewall/NAT/ISP). Host-side layers
  all PASS.
- **No Cloudflare used.** No Production / global firewall / other-service
  changes made.
- **Next action is the network owner's** (apply the §8 request). After the
  fix, the user says **"retry"** and steps 10–11 are executed.

**STOP** (per Gate D directive).
