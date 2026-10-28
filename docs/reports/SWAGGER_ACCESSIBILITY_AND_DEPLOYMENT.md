# Deployment & Swagger Accessibility — Diagnosis and Controlled Access Report

Date: 2026-10-28 (UTC)
Mission: **"Deployment and Swagger Accessibility Addendum"** — determine why
`http://172.20.1.52:4870/api/docs` and related URLs do not open, establish a
**controlled** way to reach Swagger/OpenAPI, test endpoints from inside the
server, from the internal network, and (if configured) from the HTTPS domain,
run API tests with a test token, and document Local + Server access.
**No production change, restart, bind change, or push was performed for this
mission.** All evidence below is real tool output collected on
2026-10-28 between ~16:30Z and ~17:25Z.

| Item                | Value                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| s52 service         | `nlo` active, MainPID `3812771`, node pid `3812839`                                                |
| s52 bind (observed) | `127.0.0.1:4870` only — `ss -ltnp` shows no 0.0.0.0/external listener                              |
| s52 deployed commit | `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9` (Phase C docs, deployed 2026-10-28T13:43Z)              |
| Local main          | `9e3fc67` (docs only), ahead 1 of `origin/main` (`b5e9ad3`)                                        |
| Working access      | SSH tunnel `ssh -N -f -L 14870:127.0.0.1:4870 s52` → `http://127.0.0.1:14870/api/docs`             |
| HTTPS domain        | `nlo.ai.ismc.ir` → **blocked** (wrong vhost/cert at shared edge `80.191.92.189`) — §8, §14         |
| Regression          | `npm test` **152/152**, typecheck clean, build succeeded                                           |
| Status              | **Complete — diagnosis confirmed, controlled access verified, report only (no production change)** |

---

## 1. Root cause (exact category)

**Category: network binding, by design — the service listens on
`127.0.0.1:4870` only.** It is _not_ a firewall rule, _not_ an application
bug, _not_ a DNS problem, and _not_ a deployment regression.

Evidence (all real output from s52):

- `ss -ltnp | grep 4870` →
  `LISTEN 0 511 127.0.0.1:4870 0.0.0.0:* users:(("node",pid=3812839,fd=78))`
  — the _only_ listener is loopback. No `0.0.0.0:4870` listener exists.
- Negative control **from s52 itself**:
  `curl --max-time 4 http://172.20.1.52:4870/api/health` → **HTTP 000**
  (connection to its own public/internal IP fails). If the app or firewall
  were at fault, a connection from the host to its own IP would behave
  differently (typically 200 or a timeout at a different layer).
- Negative control **from the local machine** (internal network client):
  `http://172.20.1.52:4870/api/health` → `CONN_FAIL` (~2 s).
- All four endpoints return **200 on loopback** (s52-internal, §6) — the
  application is healthy and complete.
- `firewalld` is **inactive** on s52 — there is no host firewall filtering
  the port.
- The loopback bind is the configured default: [`apps/server/src/config.ts`](../../apps/server/src/config.ts)
  (`NLO_HOST` default `127.0.0.1`), and the s52 `.env` sets it explicitly.
  This is an intentional security posture (loopback-only by default;
  non-loopback only behind an authenticated reverse proxy — see
  [`README.md`](../../README.md) env table and AGENTS.md §7).

Conclusion: `http://172.20.1.52:4870/...` can never open from a remote
client while the service binds loopback. The correct, policy-compliant
access paths are (a) **SSH tunnel** (used and verified here) and
(b) **authorized HTTPS reverse proxy** for `nlo.ai.ismc.ir` (does not exist
yet — §8, blocked pending proxy-admin authorization).

## 2. Initial state (before any change in this mission)

**Local repository**

- `main` clean at `9e3fc67` (docs-only: Phase C live acceptance report),
  **ahead 1** of `origin/main` (`b5e9ad3`). Only remote: GitHub.
- Untracked local artifacts: `tmp/` (gitignored), plus two stray untracked
  files at repo root (`$out`, `HTTP`) — pre-existing, not touched.

**s52 (production)**

- `systemctl is-active nlo` → `active`; MainPID `3812771`.
- Deployed repo: `/home/saber/saberprojects/notebooklm-orchestrator`,
  checked out at `b5e9ad30e1f87b0a9ee95575d43f9ab503505cd9`.
- Untracked leftovers on s52 (pre-existing, not touched):
  `apps/server/src/proxy/connect-proxy.ts.bak-curlfix`,
  `apps/server/src/queue/job-runner.ts.bak-e2efix`, `nul`.
- DB: `data/nlo.sqlite`, 3 jobs; `api_tokens` = **0 rows**;
  `NLO_API_AUTH` **not set** → v1 runs in **optional auth mode** (no-token
  requests accepted; with-token requests enforced). This is finding
  **F2** from [`PHASE_C_LIVE_ACCEPTANCE.md`](PHASE_C_LIVE_ACCEPTANCE.md):
  there is no API path to create the _first_ admin token (token creation
  requires an admin token) — production was seeded out-of-band in Phase C
  and is currently at 0 tokens.
- Backups intact (newest first): `env-20261028T134316Z-b5e9ad3.env`,
  `nlo-20261028T134316Z-b5e9ad3.sqlite`, older pairs for `80a9e66`, `888e8f9`.
- `firewalld` inactive; journal free of recent errors.
- DNS: `nlo.ai.ismc.ir` resolves to `80.191.92.189` (shared edge proxy).

**Local machine (this workstation)**

- A local dev instance of NLO was **already running** on `127.0.0.1:4870`
  (pid `8380`). It turned out to be a **stale pre-Phase-C build**:
  `/api/health` 200, but `/api/docs`, `/api/openapi.json`, `/api/v1/jobs`
  all **404** (the v1/Swagger surface was added in Phase C, `b5e9ad3`).
- Local `.env`: loopback, `NLO_PROVIDER=python-worker`,
  `NLO_PROXY_RUNTIME=xray`, `NLO_LOGIN_BROWSER=chrome`.

## 3. Commits before / after

| When   | Local `main` | `origin/main` (GitHub) | s52 deployed |
| ------ | ------------ | ---------------------- | ------------ |
| Before | `9e3fc67`    | `b5e9ad3`              | `b5e9ad3`    |
| After  | `9e3fc67`    | `b5e9ad3`              | `b5e9ad3`    |

This mission changed **no code and moved no commits**: no push, no force-push,
no deploy, no restart. The only new artifact is this report file
(`docs/reports/SWAGGER_ACCESSIBILITY_AND_DEPLOYMENT.md`), which will be a
docs-only commit when approved.

## 4. Changes made in this mission

Deliberately minimal — **zero changes to s52**:

1. **Ephemeral SSH port-forward** (no server-side change):
   `ssh -N -f -L 14870:127.0.0.1:4870 s52`
   (local port 4870 was already occupied by the local dev instance, hence
   14870). Still active at report time; harmless to close anytime.
2. **Read-only probe scripts** (scp'd to s52 `/tmp`, executed, no writes to
   repo/data): `nlo-probe-s52.sh`, `nlo-s52-authcheck.sh`,
   `nlo-s52-tokens.sh`, `nlo-s52-final.sh`, `nlo-s52-repo.sh`.
3. **Isolated local sandbox** (same code, `NLO_PROVIDER=mock`,
   `NLO_API_AUTH=true`, port `4871`, own `tmp/sandbox-swagger` data dir):
   used _only_ to verify token-authenticated API behavior, which production
   cannot demonstrate with 0 tokens (§10). **Fully torn down** (process
   killed, data dir deleted, `PORT_4871_FREE` confirmed).
4. **Local scratch scripts** under gitignored `tmp/` (probe + test harness).

Nothing in the production tree, DB, sessions, vault, or archives was
modified.

## 5. Backup / rollback

No risky infrastructure change was performed, so no new backup was required.
Existing protection verified still intact on s52:

- DB + env backup pair for the current deployment:
  `nlo-20261028T134316Z-b5e9ad3.sqlite`, `env-20261028T134316Z-b5e9ad3.env`.
- Rollback target `80a9e667b283f440cf7e69de159b91251b28df15` present
  (local + origin), with its own backup pair.
- `deploy/deploy.sh` remains the only sanctioned change path; it backs up
  DB + `.env` on every deploy and prints the rollback target.

## 6. Server-internal tests (executed on s52, loopback)

All run **on s52 itself** via scp'd bash scripts:

| Endpoint                                                    | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/health`                                           | **200**                                                    |
| `GET /api/health/ready`                                     | **200**                                                    |
| `GET /api/openapi.json`                                     | **200**, valid JSON, `openapi: 3.0.3`                      |
| `GET /api/docs`                                             | **200**, Swagger UI HTML                                   |
| `GET /api/health` via `172.20.1.52:4870` (negative control) | **000 / fail** — proves loopback-only bind, not app health |

Service `nlo` stayed `active` throughout; no restart at any point.

## 7. Internal-network tests (from this workstation, via SSH tunnel)

Prerequisite (one command, no server change):

```bash
ssh -N -f -L 14870:127.0.0.1:4870 s52
```

Then, from the local machine (PowerShell probe, 2026-10-28 ~17:22Z):

| Endpoint                                                | Status    | Latency |
| ------------------------------------------------------- | --------- | ------- |
| `http://127.0.0.1:14870/api/health`                     | **200**   | 62 ms   |
| `http://127.0.0.1:14870/api/health/ready`               | **200**   | 101 ms  |
| `http://127.0.0.1:14870/api/openapi.json`               | **200**   | 78 ms   |
| `http://127.0.0.1:14870/api/docs`                       | **200**   | 21 ms   |
| `http://172.20.1.52:4870/api/health` (negative control) | CONN_FAIL | —       |

OpenAPI fetched through the tunnel (validated with node):
`openapi=3.0.3`, `title="NotebookLM Orchestrator API"`,
`version=1.0.0`, **41 paths**, `servers=[{"url":"/api/v1"}]`.
Swagger HTML: 721 bytes, references both `swagger-ui` and `openapi.json`.

**Authorized API request, production (honest scope):** production runs in
**optional auth mode** with **0 tokens**, so a _token-authenticated_ request
against production is impossible until a token exists (§10, F2). What _was_
verified through the tunnel against production: v1 endpoints respond 200 in
optional mode (no-token path), matching the Phase C live acceptance.

## 8. HTTPS domain test (`https://nlo.ai.ismc.ir`)

- DNS: `nlo.ai.ismc.ir` → `80.191.92.189` (shared edge nginx).
- TLS handshake: the edge presents a Let's Encrypt certificate with
  **`CN=admin.ai.ismc.ir`** (wrong principal → `SEC_E_WRONG_PRINCIPAL` on
  the client), i.e. the request falls through to the **default vhost**.
- HTTP behavior: **307 → `/login`** (default-vhost app), not NLO.
- **There is no NLO server block / vhost / TLS cert / routing for
  `nlo.ai.ismc.ir` on that edge.**

This is a **blocked item, not a defect of NLO**: creating a vhost + issuing
a cert for the correct principal requires the proxy administrator's
authorization at `80.191.92.189`. Per the mission rules, no wide-effect
network change was attempted (§14, B1).

## 9. Swagger / OpenAPI results

- Spec: **OpenAPI 3.0.3**, 41 paths (52 operations per Phase C register),
  valid JSON, served at `GET /api/openapi.json` (exempt from auth).
- Swagger UI: `GET /api/docs` serves the Swagger UI page (references
  `swagger-ui` assets + `openapi.json`), verified 200 from s52 loopback and
  through the SSH tunnel.
- Contract correctness was additionally pinned by the committed test suite
  `apps/server/test/openapi-v1.test.ts` (24 tests — contract drift,
  auth modes, token lifecycle, rate limiting, idempotency, correlation,
  audit), green in §11.
- Known cosmetic finding carried from Phase C: **F1** — legacy OpenAPI
  `servers[0].url` is `/api/v1`; v1 spec itself is correct.

## 10. API auth / test-token results

**Production cannot demonstrate token auth** (0 tokens, optional mode — F2).
To keep the mission honest, token behavior was verified in an **isolated
local sandbox running the exact same code** (s52 tree `b5e9ad3` sources),
with `NLO_API_AUTH=true`, mock provider, isolated data dir, port 4871.
Two seeded tokens (admin: `jobs:read,write,cancel,download,meta:read,admin`;
reader: `jobs:read,meta:read`); plaintexts never stored (SHA-256 hash only),
values **redacted here**.

**Result: 29/29 checks PASS**, covering:

1. Enforcement mode: v1 non-exempt request **without** token → **401**
   (`auth_required` audited).
2. Scope enforcement: reader token on admin-only `GET /tokens` → **403**
   (`forbidden` audited).
3. Exemptions honored: `/health`, `/health/ready`, `/openapi.json`, `/docs`
   → **200** with no token.
4. Correlation ID: `x-correlation-id` echoed on every v1 response.
5. Idempotency: replay of `POST /jobs` with same `Idempotency-Key` →
   `x-idempotent-replay: true`, no duplicate job.
6. Mock job lifecycle: create → **SUCCEEDED** (`provenance: mock`), events +
   attempts queryable.
7. Artifact download via `GET /jobs/{id}/outputs` → 200, bytes on disk.
8. Audit hygiene: `api_audit_log` rows present by action
   (`request` 13, `forbidden` 119, `auth_required` 3, `rate_limited` 2,
   `auth_failed` 2, `token_created` 1, `token_revoked` 1 — verified by
   direct read-only `node:sqlite` inspection); **no plaintext token in any
   audited row** (redaction holds).
9. Token lifecycle: create → use → revoke → further use **401**.
10. Rate limiting: burst beyond `NLO_API_RATE_LIMIT_MAX=120/60s` → **429**
    with `retryAfterSeconds` (enforced _before_ scope check).
11. Legacy `/api/*` surface (pre-v1) remains intact and un-gated, per
    contract.
12. Documented third-party client [`docs/api/examples/client.ts`](../api/examples/client.ts)
    run against the sandbox: exit 0 — job created (with `Idempotency-Key`),
    polled to SUCCEEDED, artifact downloaded.

**Honest scope statement:** this proves the _deployed code_ implements
token auth correctly. It is **not** production-verified token usage, because
no production token exists (B2).

## 11. Regression results (local, current `main` = `9e3fc67` sources)

| Check                       | Result                                          |
| --------------------------- | ----------------------------------------------- |
| `npm test` (all workspaces) | **PASS 152/152** — shared 44, server 83, web 25 |
| `npm run typecheck`         | **clean** (shared, server, web)                 |
| `npm run build`             | **success** (vite, 14.5 s, 1852 modules)        |

Matches the Phase C acceptance baseline exactly. No test, lint, or type
regression introduced by this mission (no code was changed).

## 12. Local state (this workstation)

- Dev instance on `127.0.0.1:4870` (pid `8380`) **still running** — but it is
  a **stale pre-Phase-C build** (`/api/docs` and `/api/openapi.json` → 404).
  To get the current UI + Swagger locally: stop it and start the current
  code:
  - production-like: `npm run build && npm run start --workspace @nlo/server`
    → UI + API + `/api/docs` at `http://127.0.0.1:4870`
  - development: `npm run dev` → server `127.0.0.1:4870`, web
    `127.0.0.1:5173` (proxies `/api`).
    (Not restarted without approval — it is the user's running instance; §14 B4.)
- Sandbox fully torn down; port 4871 free; `tmp/sandbox-swagger` deleted.
- SSH tunnel on local port 14870 active (harmless; close with
  `ssh -O exit s52` or by killing the ssh process).
- Scratch scripts remain under gitignored `tmp/` for reproducibility.

## 13. Production state (s52, after this mission)

- Service `nlo`: **active**, single instance, **not restarted**,
  deployed commit unchanged: `b5e9ad3`.
- Bind unchanged: `127.0.0.1:4870` only. Auth mode unchanged: **optional**
  (`NLO_API_AUTH` unset), 0 tokens, 3 jobs.
- DB, sessions, vault, archives: untouched; backup pairs intact (§5).
- Pre-existing untracked leftovers on s52 noted for cleanup decision
  (`.bak-curlfix`, `.bak-e2efix`, `nul`) — not removed (out of scope, needs
  approval).

## 14. Blocked items (require authorization / external parties)

- **B1 — HTTPS domain `https://nlo.ai.ismc.ir` (BLOCKED).**
  Needs: (a) NLO server block on the shared edge nginx at
  `80.191.92.189` proxying to `172.20.1.52:4870`, (b) a TLS cert issued for
  `nlo.ai.ismc.ir` (current default-vhost cert is for `admin.ai.ismc.ir`),
  (c) decision on the auth model at the edge (proxy must authenticate —
  e.g. forward an API token — or stay internal-only). Requires the **proxy
  administrator's approval**. Not attempted per mission rules.
- **B2 — First production admin token (F2 bootstrap gap).**
  The API cannot create its first admin token (chicken-and-egg). Options:
  (a) out-of-band one-time seed via the documented bootstrap pattern on s52
  (same as Phase C), then `NLO_API_AUTH=1` deploy, or (b) add an
  explicitly-guarded one-time bootstrap endpoint. Needs user decision.
- **B3 — Live NotebookLM job.** Session/region gate (Phase C F7); unchanged
  by this mission; out of scope.
- **B4 — Stale local dev instance** on `127.0.0.1:4870` (pre-Phase-C).
  Recommend restart with current code when the user is done with the old
  instance.
- **B5 — s52 untracked leftovers** (`.bak-*`, `nul`) — cosmetic cleanup,
  needs approval to remove.

## 15. Final usable addresses + prerequisites

| Address                                                   | Where from                                                 | Prerequisite                                      | Status                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `http://127.0.0.1:14870/api/docs`                         | any machine with SSH access to s52 (e.g. this workstation) | run once: `ssh -N -f -L 14870:127.0.0.1:4870 s52` | **WORKING — verified 200 (21 ms)**                     |
| `http://127.0.0.1:14870/api/openapi.json`                 | same                                                       | same tunnel                                       | **WORKING — verified 200, valid 3.0.3, 41 paths**      |
| `http://127.0.0.1:14870/api/health` / `/api/health/ready` | same                                                       | same tunnel                                       | **WORKING — verified 200**                             |
| `http://127.0.0.1:4870/api/docs` (and the other three)    | **on s52 itself** (SSH console)                            | none                                              | **WORKING — verified 200**                             |
| `http://172.20.1.52:4870/...`                             | anywhere                                                   | —                                                 | **WILL NOT WORK** — loopback-only bind, by design (§1) |
| `https://nlo.ai.ismc.ir/...`                              | anywhere                                                   | B1 (proxy admin approval + vhost + cert)          | **BLOCKED** (§8, §14)                                  |
| `http://127.0.0.1:4870` (local dev)                       | this workstation                                           | restart local instance with current code (B4)     | currently **stale build**                              |

**The exact, testable address for the user right now:**
`ssh -N -f -L 14870:127.0.0.1:4870 s52`, then open
`http://127.0.0.1:14870/api/docs` (Swagger UI) — or
`http://127.0.0.1:14870/api/openapi.json` for the raw spec. Both verified
from the internal network in this report.

---

### Evidence index

- s52 live-state probes: `tmp/nlo-probe-s52.sh`, `tmp/nlo-s52-final.sh`,
  `tmp/nlo-s52-authcheck.sh`, `tmp/nlo-s52-tokens.sh`, `tmp/nlo-s52-repo.sh`
  (scp'd to `/tmp` on s52; read-only).
- Tunnel + endpoint probe: `tmp/nlo-tunnel-probe.ps1`, `tmp/nlo-final-probe.ps1`.
- Sandbox harness (token/API verification): `tmp/sandbox-bootstrap.ts`,
  `tmp/sandbox-test.mjs` (29 checks), `tmp/audit-inspect.mjs`.
- Committed test baseline: `npm test` 152/152 incl.
  `apps/server/test/openapi-v1.test.ts`.
