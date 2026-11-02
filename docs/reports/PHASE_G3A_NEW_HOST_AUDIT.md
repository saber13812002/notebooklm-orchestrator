# Phase G3-A — New Production Host: Secure Access and Read-only Audit

**Target host:** `172.30.0.133` (hostname `AI-TOOLS`)
**Internal LLM proxy:** `http://172.30.0.133:4000/v1` (LiteLLM v1.101.0)
**Baseline commit:** `50b31e7` (local `main` = `origin/main`)
**Date:** 2026-11-02
**Mode:** READ-ONLY audit. No install, no deploy, no service restart, no `.env`
change, no DB migration, no firewall/DNS/proxy/TLS change, no modification of any
service. Only read-only SSH commands and local git inspection were executed.

> **Scope note.** The mission premise for G3 was "NLO is not yet on the new host"
> (per G1/G2 negative control: `:4870` refused on 2026-11-02). This audit found
> that **NLO was deployed on the new host on 2026-10-31**, at commit `b5e9ad3`,
> **before** G1/G2 were executed. G3-A therefore audits the *already-present*
> deployment rather than a fresh install, and confirms exactly what is live,
> what is legacy, and what must change to reach the current baseline `50b31e7`.
> No change was made to that running service in this phase.

---

## 1. SSH access verification

**Status: AUTHENTICATED (read-only).** Public-key login is available and was
used for every command in this audit.

| Item | Value |
| --- | --- |
| Host | `AI-TOOLS` (`172.30.0.133`) |
| Remote SSH | `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20` |
| Local client | `OpenSSH_for_Windows_9.5p2` |
| KEX negotiated | `curve25519-sha256` |
| Ciphers | `chacha20-poly1305@openssh.com` (both directions), no compression |
| Host key algorithm | `ssh-ed25519` |
| **Host key fingerprint** | `SHA256:BP+9ekCAA+LaalRmqt84JQydR+PUwx0GQ8a33t4U7WY` |
| Authorized user | `saber` |
| Auth method | `publickey` (no password) |
| Client key | local `id_ed25519` → `SHA256:97MEQ0f1L/bHr49fXQf1leXELZmzkczmgCsv5d5qvOQ` |
| Authorized-key line | `/home/saber/.ssh/authorized_keys:5` (options: `agent-forwarding port-forwarding pty user-rc x11-forwarding`) |

**Sudo:** `sudo -n true` → `sudo: a password is required` (rc=1). The `saber`
user is **not** passwordless-sudo, so root-only checks (`ufw status`,
`iptables -S`) could not be completed. This is a recorded limitation, not a
blocker for the rest of the audit.

**Client/tooling note (reproducible):** `ssh-keyscan` from the Windows client
failed to collect the host key with
`choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`
(repeated 5×, exit 1). The interactive `ssh` client negotiated fine (it selected
`curve25519-sha256`). This is a known local-client/keyscan algorithm-set
discrepancy against the host's OpenSSH 9.6p1; it does **not** block normal
SSH use. The host key was pinned via `StrictHostKeyChecking=accept-new`
(`Warning: Permanently added '172.30.0.133' (ED25519)`).

**Secrets hygiene:** No private key, token, or credential was written to this
report or to any repo file. The host key fingerprint above is public by design.

---

## 2. Host audit

| Item | Value |
| --- | --- |
| OS | `Ubuntu 24.04.4 LTS` (`VERSION_ID=24.04`) |
| Kernel | `6.8.0-147-generic` |
| CPU | 20 cores — `Intel(R) Xeon(R) Gold 6458Q` |
| RAM | 78 GiB total, 17 GiB used, 60 GiB available |
| Root disk | `/dev/mapper/ubuntu--vg-ubuntu--lv`, 686 GiB, 241 GiB used (37%), 417 GiB free |
| Uptime | 2 days 7 h, load avg 2.03 / 2.16 / 2.22 |
| Primary NIC | `ens33` → `172.30.0.133/20` |
| Docker bridges | many `br-*` + `docker0` = `10.240.255.1/24` |
| Node.js (PATH) | **not on default PATH** for non-interactive shell |
| Node.js (custom) | `/home/saber/.local/node22/bin/node` → **v22.23.4**; `node22/bin` also has `npm`, `npx`, `corepack` |
| npm | present at `node22/bin`; `npm -v` failed under bare `env` (no `node` on PATH) — works only with `node22/bin` prepended |
| Python | `/usr/bin/python3` → **3.12.3**; `data/venv` Python **3.12.3** |
| Docker | **29.1.3** |
| FFmpeg | **6.1.1-3ubuntu5** |
| Git | **2.43.0** |
| systemd state | `degraded` (see failed unit below) |

**Failed units:** exactly one — `llmhub-feedback.service` (LLM Hub Feedback
Synchronization). This is an unrelated LLM-Hub service, **not** NLO. NLO's own
unit is healthy (section 3).

**Running Docker containers (read-only `docker ps`):** ~20, including
`llmhub-api` (`:8100`), `llmhub-litellm-public` (`:4102`), `llmhub-openwebui`
(`:3006`), `bot-gateway`/`bot-gateway-candidate` (`:8087`/`:8088`), `9router`,
`vless-proxy` (**unhealthy**), `llmhub-db` (postgres:16), `persian-corpus-toolkit-backend-1`
(`127.0.0.1:5055`), and `learn-lite-llm-litellm-1` (**`0.0.0.0:4000` + `0.0.0.0:4010`**).
This host runs several other org services alongside NLO — NLO must not disturb
them.

**Listening ports (relevant):**

| Port | Bind | Service |
| --- | --- | --- |
| 4870 | `127.0.0.1` | **NLO (loopback-only)** ✓ |
| 4000 | `0.0.0.0` | LiteLLM (container `learn-lite-llm-litellm-1`) |
| 4010 | `0.0.0.0` | LiteLLM Prometheus metrics |
| 22 | `0.0.0.0` | sshd |
| 8443, 8888, 9090, 9100, 9001, 9187–9189, 6379, 7575, 7777, 7779, 7810, 8000, 8050, 8087, 8088, 8099, 5433, 5435, 5678, 2222, 3002, 3006, 4101, 4102, 8100 | `0.0.0.0` | other org services (not NLO) |

**Multiple LiteLLM processes** are visible (PIDs `12130`, `176211`, `598274`,
`177505`), all under `/app/.venv/...` (container paths) — i.e. the host runs
more than one LiteLLM deployment. The one bound to `0.0.0.0:4000` is the target
for NLO.

---

## 3. NLO on the new host (already deployed at `b5e9ad3`)

**Service:** `nlo.service` — `Active: active (running) since Sat 2026-10-31
07:10:44 UTC` (2 days at audit time). Main PID `1428` (node), 37 tasks, ~169 MB
resident.

**Unit file on host** (`/etc/systemd/system/nlo.service`, root:root, 657 B):
`User=saber`, `Group=saber`,
`WorkingDirectory=/home/saber/saberprojects/notebooklm-orchestrator/apps/server`,
`Environment=PATH=/home/saber/.local/node22/bin:...`,
`ExecStart=/home/saber/saberprojects/notebooklm-orchestrator/node_modules/.bin/tsx src/main.ts`,
`Restart=always`, `TimeoutStopSec=120`, `NoNewPrivileges=true`, `PrivateTmp=true`,
`WantedBy=multi-user.target`, **enabled**. This is identical in substance to the
repo's `deploy/systemd/nlo.service` — the s52-era paths **already match** this
host (same `/home/saber/saberprojects/...` layout and same `node22` install).

**Live health (read-only, loopback):**

```
GET http://127.0.0.1:4870/api/health
→ {"ok":true,"service":"notebooklm-orchestrator","time":"2026-11-02T14:20:45.150Z"}

GET http://127.0.0.1:4870/api/health/ready
→ {"ok":true,"ready":true,
   "provider":{"name":"python-worker","configured":true,"issues":[]},
   "proxyRuntime":{"state":"available","name":"xray"},
   "liveDisabled":true}
```

Provider `python-worker` configured with no issues; `xray` proxy runtime
available; live egress disabled in the service environment. **NLO is up, ready,
and loopback-bound on the new host.**

---

## 4. LiteLLM audit (local `127.0.0.1:4000`, from the host)

Read-only probes from **on-host** (loopback), no inference, no key:

| Probe | Result |
| --- | --- |
| `GET /health/liveliness` | `200` `"I'm alive!"` |
| `GET /health/readiness` | `200` `{"status":"healthy","db":"connected"}` |
| `GET /v1/models` (no key) | `401` (auth required) |
| `GET /openapi.json` → `info.version` | **`1.101.0`** |

**Auth config:** `/v1/*` requires `Authorization: Bearer <key>` (deterministic
401 with no key). **The LLM API key is NOT provisioned** in the on-host NLO
`.env` (0 lines matching `key|token|secret`), and none exists in this repo.
Authenticated `/v1/models` therefore remains **unverified** — same state as
G1. Provisioning a key must happen out-of-band via a secret store; it must
**never** be committed or pasted into the repo.

**Binding note:** LiteLLM listens on `0.0.0.0:4000` (LAN-visible), not
loopback-only. That is a property of the LLM-proxy service (not NLO) and is
outside NLO's control in this phase — recorded as an observation.

---

## 5. Legacy / existing NLO data discovery

A full NLO checkout already exists at
`/home/saber/saberprojects/notebooklm-orchestrator` (506 MB).

### 5.1 Git state on host

| Item | Value |
| --- | --- |
| HEAD | **`b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9`** |
| `data/deployed-commit` | **`b5e9ad3`** |
| `origin` | `https://github.com/saber13812002/notebooklm-orchestrator.git` |
| host `origin/main` | `b5e9ad3` (**not** synced to `50b31e7`) |
| `b5e9ad3` vs local HEAD | **ancestor** of `50b31e7` (verified `git merge-base --is-ancestor`) |
| Untracked (host) | `apps/server/src/proxy/connect-proxy.ts.bak-curlfix`, `apps/server/src/queue/job-runner.ts.bak-e2efix`, `nul` |

So the on-host deployment is **10 commits behind** the current `origin/main`
(`50b31e7`). It is a clean ancestor, so advancing is a fast-forward, not a
rebase/merge risk. The three untracked `*.bak-*`/`nul` files are pre-existing
scratch artifacts (not staged, not part of any deploy).

### 5.2 `data/` inventory (size / ownership / permissions only — **contents not read**)

| Path | Size | Perms / Owner | Note |
| --- | --- | --- | --- |
| `data/nlo.sqlite` | 164 K | `-rw-rw-r--` saber | live DB |
| `data/nlo.sqlite-shm` | 32 K | `-rw-rw-r--` saber | WAL sidecar |
| `data/nlo.sqlite-wal` | 0 | `-rw-rw-r--` saber | (empty) |
| `data/deployed-commit` | 4 K | `-rw-rw-r--` saber | `b5e9ad3` |
| `data/backups/` | 724 K | `drwxrwxr-x` | 5 × `nlo-*.sqlite` (143 360 B) + 5 × `env-*.env` (`-rw-------` 0600) — matches `deploy.sh` retention-5 |
| `data/jobs/` | 2.0 M | `drwxrwxr-x` | 3 job dirs (`j_290f6f…`, `j_34ba94…`, `j_6568c1…`) — historical artifacts |
| `data/sessions/` | 16 K | `drwx------` 0700 | 1 account session `nlo-acc_5a03a60bbda24085.json` (`-rw-------` 0600) + lock files |
| `data/tmp/` | 12 K | `drwxrwxr-x` | scratch |
| `data/vault/` | (empty) | `drwxrwxr-x` | no secrets currently stored |
| `data/vault.key` | 64 B | `-rw-------` 0600 | AES-256-GCM key, correct perms |
| `data/vendor/` | 40 M | `drwxrwxr-x` | `xray` binary + `cfg/`, `geoip.dat`, `geosite.dat`, `LICENSE`, `README.md` — **xray proxy deps present** |
| `data/venv/` | 198 M | `drwxrwxr-x` | Python **3.12.3** worker venv |

**Legacy-data verdict:** the s52 `data/` tree (DB, 5 DB+5 env backups,
`vault.key`, sessions, `vendor/xray`, `venv`) is **already present and intact**
on the new host. No copy / delete / overwrite / migration was performed in this
phase. **No cookies or session contents were printed** — only names, sizes,
owners, and permissions.

### 5.3 On-host `.env` (variable **names** + booleans only — no secret values)

| Var | State (redacted) |
| --- | --- |
| `NLO_HOST` | `127.0.0.1` (loopback) ✓ |
| `NLO_PORT` | `4870` |
| `NLO_PROVIDER` | set (value not printed) |
| `NLO_PYTHON_BIN` | set; target **exists and is executable** |
| `NLO_PROXY_RUNTIME` | `xray` |
| `NLO_LOGIN_BROWSER` | set (value not printed) |
| `NLO_ALLOW_DIRECT_EGRESS` | **`1`** (direct egress permitted — matches s52-era behavior; see §7) |
| `NLO_INTERNAL_API_BASE_URL` | **absent** (0 lines) → falls back to the compiled default `http://172.30.0.133:4000`, which is correct |
| key/token/secret lines | **0** (no LLM key stored) |

**Perm note:** the live `.env` is `-rw-rw-r--` (0664) while the backup
`env-*.env` files are `-rw-------` (0600). The live file is group/world-readable;
recommend tightening to `0600` (not changed in this phase).

---

## 6. Deployment-preparation review (no changes made)

- **`deploy/deploy.sh`** is host-agnostic and **compatible as-is**: it
  prepends `/home/saber/.local/node22/bin` (verified present, node v22.23.4),
  backs up DB + `.env` (retention 5), deploys only reviewed commits reachable
  from `origin/main`, runs regression, and prints the previous-good commit for
  rollback. It never touches untracked `data/`, `.env`, `node_modules`, or
  `data/venv`.
- **`deploy/systemd/nlo.service`** paths match the host exactly (see §3). No
  path adaptation is required — the s52 `/home/saber/...` + `node22` layout is
  literally what this host uses. This is *verified* reuse, not blind reuse.
- **`Dockerfile` / `docker-compose.yml`:** unaffected; production path is
  systemd (not Docker) per the deployment rules.
- **To reach baseline `50b31e7`** (the only deployment work G3-B would do): on
  the host, `git fetch` + move `main` to `origin/main` (`50b31e7`) — a clean
  fast-forward from `b5e9ad3` — then run `deploy/deploy.sh`. No code, path, or
  unit change is needed beyond the git advance.

---

## 7. Security findings (read-only)

| # | Finding | Severity | Action (later, with approval) |
| --- | --- | --- | --- |
| S1 | NLO bound **loopback-only** (`127.0.0.1:4870`) | OK | none |
| S2 | LiteLLM on `0.0.0.0:4000`/`0.0.0.0:4010` (LAN-visible) | Info (not NLO) | out of NLO scope; flag to LLM-proxy owner |
| S3 | Live `.env` is `0664` (group/world readable) | Low | `chmod 600 .env` in G3-B (with DB/.env backup already routine) |
| S4 | `NLO_ALLOW_DIRECT_EGRESS=1` | Low | keep (matches legacy behavior); re-review if proxy policy changes |
| S5 | `vault.key` `0600`, `sessions/` `0700`, backups `0600` | OK | none |
| S6 | Firewall (`ufw`/`iptables`) **unverified** (no passwordless sudo) | Gap | confirm firewall posture separately with a root-capable account |
| S7 | `vless-proxy` container **unhealthy**; systemd `degraded` via `llmhub-feedback.service` | Info (other services) | out of NLO scope; do not touch |
| S8 | No secrets in repo or in on-host `.env` (no key/token/secret lines) | OK | none |

**Secret-storage posture:** the LLM key, if provisioned, must stay in a
secret store (vault/secret manager) and be injected at runtime — **never** in
`.env` committed anywhere, never in logs, never in this report.

---

## 8. What is still missing / blocked (inputs needed for G3-B)

1. **LLM API key** for authenticated `/v1/models` — not provisioned (this repo
   must not store it). Provide via the org secret store; NLO will read it at
   runtime.
2. **Root/sudo access** to verify firewall posture (S6) — optional for
   deployment, needed for a complete security sign-off.
3. **Explicit user approval** to advance the on-host deployment from `b5e9ad3`
   to `50b31e7` (a fast-forward + standard `deploy.sh` run).

---

## 9. Mandatory STOP — no action taken; plan for G3-B

**No change was made in this phase** (read-only audit only). To proceed to
G3-B (production deploy to baseline `50b31e7`), the exact plan, backup, and
rollback are:

### Deployment plan (G3-B)
1. On host, as `saber` (no sudo needed): `git -C <repo> fetch origin` then
   `git -C <repo> checkout main && git -C <repo> merge --ff-only origin/main`
   (clean fast-forward `b5e9ad3` → `50b31e7`).
2. Run `deploy/deploy.sh` (production path). It will: verify reviewed commit,
   back up DB + `.env` (retention 5), run `npm ci` only if `package.json` /
   `package-lock.json` changed, restart `nlo.service`, run health checks, run
   the server regression suite, and print the previous-good commit.
3. Verify `GET /api/health` and `/api/health/ready` on `127.0.0.1:4870` and
   confirm `data/deployed-commit` = `50b31e7`.
4. (Optional, if key provisioned) verify authenticated
   `GET /v1/models` via the internal-LLM client — no inference.

### Backup plan
- `deploy.sh` automatically snapshots `data/nlo.sqlite` **and** `.env` to
  `data/backups/` (5-generation retention) **before** any change. Current
  backups already exist (§5.2). No manual backup step is required, but the
  existing `data/backups/` generation set is a known-good restore point.

### Rollback strategy
- `deploy.sh` prints the **previous-good commit** on every run; rollback is
  `git checkout <prev-sha>` + re-run `deploy.sh` (or `ROLLBACK=1` if the script
  exposes it for this tree).
- DB restore: restore the most recent `data/backups/nlo-*.sqlite` (and
  matching `env-*.env`) over the live files after stopping `nlo.service`.
- Service rollback: `systemctl restart nlo` after the git restore returns the
  prior build; `data/` is never deleted by the deploy path.

**This phase stops here, awaiting explicit user approval for G3-B.**

---

## 10. Deliverable & integrity

- Report: `docs/reports/PHASE_G3A_NEW_HOST_AUDIT.md` (this file).
- All on-host commands were read-only (`ls`, `cat` of non-secret config,
  `ss`, `ps`, `docker ps`, `systemctl status`, `git rev-parse`, `grep` for
  variable **names**/booleans, `curl` to health/readiness/liveliness only).
- No secret values (LLM key, session contents, `.env` secret lines) appear in
  this file. Host + client public fingerprints are public by design.
- Commit + push of this docs-only change follows the standard pre-commit
  checklist (typecheck/lint/format/test/build are unaffected by a Markdown
  report; secret scan clean).
