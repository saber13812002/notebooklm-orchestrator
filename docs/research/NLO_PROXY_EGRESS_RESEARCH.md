# NLO-P4-0 — Proxy & Egress Research

Mission: **NLO-P4-0 — Universal Modular Architecture & NotebookLM Ecosystem Discovery**
Date: **2026-11-15**. Source-first: NLO code at `main @ 76cd5f03` (proxy subsystem read in full) + ecosystem READMEs fetched 2026-11-15.
Status labels: `VERIFIED` (code/doc read) · `PARTIAL` · `EXPERIMENTAL` · `UNSUPPORTED` · `UNKNOWN` · `NOT_TESTED`.

---

## 1. Why egress is a first-class concern for NLO (not an infra detail)

NLO's production host cannot (or must not) reach Google directly: traffic to `notebook.google.com` goes through a **verified VLESS tunnel** (xray). This makes egress a *security boundary with product behavior*, not plumbing:

- **Fail-closed by design:** there is no silent `direct` mode. If no tunnel is configured, the transport **throws** (`DirectEgressBlockedError`) unless the operator explicitly set `NLO_ALLOW_DIRECT_EGRESS` (and no nodes exist). VERIFIED: [`apps/server/src/proxy/egress.ts`](../../apps/server/src/proxy/egress.ts) — "This is the SECURITY BOUNDARY… If the tunnel is absent or broken, the transport REJECTS the request (throw)".
- **A job is only as good as its egress:** every job records which `node_id` served it (provenance column), so "which IP did Google see" is auditable per job.
- **Session stability couples to egress:** Google session cookies can be sensitive to source-IP change (unverified hypothesis, see §6 Q3) — egress choice is therefore an *account-compatibility* dimension, not only a network one.

## 2. NLO's current proxy subsystem (code-verified)

### 2.1 Node registry

`proxy_nodes` (migration 0001): each node = name, server, port, `uuidSecretRef` (vault), transport `tcp|ws|grpc`, security `none|tls|reality`, `sni`, `wsHost`, `wsPath`, `pbk`, `sid`, `spx`, `flow`, `encryption`, `alpn`, `extra` (JSON, **never silently dropped**), `priority` (lower = higher), `preferred` flag.
`validateConfig` (VERIFIED in [`proxy-manager.ts`](../../apps/server/src/proxy/proxy-manager.ts)): server/port/uuidSecretRef required; ws requires a path; grpc warns if `serviceName` missing in `extra`; reality requires `pbk`+`sid`+`sni`.

### 2.2 Runtime (per-tunnel xray process)

[`runtime.ts`](../../apps/server/src/proxy/runtime.ts) — `ProxyRuntime` contract (`startTunnel/stopTunnel/close/healthCheck`) with **injected** `fetchThrough` so tests can substitute the transport:

- **XrayProxyRuntime:** builds an xray config per tunnel — inbound `http` on `127.0.0.1:<pre-allocated port>`, outbound VLESS (tls/reality/ws/grpc stream settings), `freedom` fallback; config file `0600`; UUID validated from vault by regex before use; spawn `xray -c <cfg>` (detached on POSIX); **readiness = real TCP connect** on the local port (poll 150 ms, 10 s budget) — explicitly *not* log parsing (xray ≥26 does not log ephemeral ports); exit handler drops the tunnel entry and removes the config; shutdown = SIGTERM to process group → SIGKILL after 4 s.
- **Port pre-allocation:** a temp `net.Server` grabs the local port before spawning xray, so the tunnel's inbound port is known without parsing xray.
- **MockProxyRuntime:** 6 scenarios (`up` / `down` / `crash` / `wrong_egress` / `dns_fail` / `timeout`) on *real loopback TCP listeners* with `expectedEgress` — this is how CI exercises the whole staged-check pipeline without a real VLESS node.

### 2.3 Transport (curl primary)

[`connect-proxy.ts`](../../apps/server/src/proxy/connect-proxy.ts): production `fetchThrough` uses **curl as PRIMARY** and node:https+HttpsProxyAgent as fallback, **no direct fallback**.
Verified finding (in-code comment): *Google/Cloudflare actively reset (ECONNRESET) TLS from Node's BoringSSL client; curl's OpenSSL handshake gets a normal HTTP response (301) through the exact same tunnel.* `findCurl` probes each candidate binary with `--version` (the production host AI-TOOLS has a broken `/usr/bin/curl` — "symbol lookup error: curl_global_trace"). Browser UA pinned to a recent Chrome (131).

### 2.4 Staged health checks (stages A–E)

`ProxyHealth` (shared types): `egressIp`, `latencyMs`, `error`, `startedAt`, `target`, `category` (11 `HealthCategory` values), `evidence` (persisted strings). TTL **10 minutes** — a node is "healthy" only within TTL.
Stages (VERIFIED in `proxy-manager.ts`):
- **A config** — schema/validate errors fail fast.
- **B runtime** — xray process alive.
- **C listener** — local port accepting.
- **D transport/egress** — real fetch through the tunnel: to an IP-echo host (proves *which* IP egresses) and/or a real NotebookLM target. **Key rule:** for non-echo hosts, **ANY** HTTP response proves the route — *"A 403 'bot check' from Google IS a working route"* (comment VERIFIED).
- **E verdict** — combines echo IP match (when echo used), route proof, and runtime verdict; evidence strings persisted to `proxy_health` (+history table).
**SSRF guard:** `assertSafe` → DNS resolution → `assertAllowedDestination(allowlist)` **before dial** (public-IP check + allowlist), from [`packages/shared/src/ssrf.ts`](../../packages/shared/src/ssrf.ts).

### 2.5 Routing & self-heal (current behavior)

- Job admission: job in `WAITING_FOR_PROXY` picks a node (priority/preferred), opens a tunnel, and passes it into the Python worker as env (the current *coupling point* — see §5).
- Health checks run on a schedule; a failing node is marked unhealthy (TTL expires / explicit fail) and jobs route to the next candidate; if no node is healthy the job parks in `WAITING_FOR_PROXY` (it does **not** silently go direct).
- `recoverInFlight` (boot): jobs in any of 7 in-flight statuses → `QUEUED` + `restart_recover` event — tunnels are re-established on the next admission, never assumed.

## 3. Ecosystem survey: who else solves egress (and who doesn't)

| Project | Proxy/egress support | Evidence |
|---|---|---|
| notebooklm-py | **UNKNOWN** (no proxy *system*; env-level HTTP(S) proxy vars possible for its fetches; Android backend has its own network) | README sweep — no proxy section found |
| gemini-notebook-mcp-cli | **UNKNOWN** (env-based transport `NOTEBOOKLM_COOKIES`, CDP; no proxy registry found) | README sweep |
| PleasePrompto/notebooklm-mcp | **UNSUPPORTED** (Chrome per request; no proxy config found) | README |
| roomi-fields/notebooklm-mcp | **UNSUPPORTED** (no proxy keyword in README) | README fetch 2026-11-15 |
| abdallah-nasir/notebooklm-mcp | **UNSUPPORTED** | mirror of PleasePrompto v2 line |
| **NLO** | **VERIFIED — the only project in the sweep with a fail-closed, health-checked, per-job-attributed tunnel layer** | this repo |

**Differentiator:** in the whole ecosystem, NLO is the only system where "which IP reached Google" is a *persisted, per-job, per-node auditable fact* with staged evidence. No competitor even documents a proxy option.

## 4. Egress failure modes catalog (from NLO's own fault matrix + code)

| Failure | Detection (current) | Job outcome (current) | P4 requirement |
|---|---|---|---|
| No nodes configured | admission check | `WAITING_FOR_PROXY` (or direct if `NLO_ALLOW_DIRECT_EGRESS` and no nodes) | unchanged; policy must be explicit, never implicit |
| xray process dies mid-job | process exit handler drops tunnel | in-flight request → `connectivity`/`proxy` failure class → RETRY_WAIT (retryable per [`retry.ts`](../../packages/shared/src/retry.ts)) | failover to next node must preserve `external_operation_id` (resume-never-resubmit) |
| Tunnel up, wrong egress IP | stage D echo mismatch | node unhealthy; job re-routes | same; record `egressIp` evidence per attempt |
| Google resets Node TLS (BoringSSL) | curl primary absorbs it (301 path) | transparent | keep curl primary; document as known Google behavior |
| DNS fails through tunnel | stage D `dns_fail` | node unhealthy | SSRF allowlist evaluated pre-dial |
| Timeout (slow node) | stage D / request timeout | `proxy`/`connectivity` failure, retryable | per-node latency evidence in `proxy_health` history for operator tuning |
| Session invalidated by IP change (hypothesis) | provider `auth` failure (`needsReauth`) | account → NEEDS_REAUTH, job → `WAITING_FOR_ACCOUNT` | if confirmed, **pin a node per account** (account↔node affinity) — P4 routing policy item |
| All nodes down | no healthy candidate | jobs park in `WAITING_FOR_PROXY`; health endpoint reflects | operator webhook alert (outbox) — P4 |

## 5. Current coupling (to be broken in P4)

The tunnel is passed into the Python worker as **environment** (`tunnelEnv` in `python-worker-provider.ts`). Consequences:

1. Egress choice is made *inside* provider invocation, not by a routing layer → a job cannot switch nodes mid-life without a restart.
2. The worker re-implements the transport (curl/https) — egress knowledge is duplicated in two runtimes.
3. `MockProxyRuntime` scenarios test the *manager*, but the worker-side curl path is only integration-tested with a fake worker.

**P4 shape (design, no migration):** an **Egress Gateway** interface owned by the platform: `acquire(job) → { localPort, egressIp?, evidenceRef }`, `release`, `health(nodeId)`. The provider adapter receives an *egress endpoint descriptor* (loopback port + expected egress IP), not a tunnel object. Node selection policy (priority, preferred, affinity, quota, health TTL) lives in one place. This is a refactor of existing VERIFIED behavior — the staged checks, fail-closed semantics, and curl-primary transport are preserved, not rewritten (AGENTS.md §1.3).

## 6. Open questions (honest, unresolved)

1. **Node IP stability over time** — a VLESS node's exit IP can change at the provider; NLO's echo check catches drift *when a health check runs* (10-min TTL), but an in-flight job may have used the old IP. Acceptable for now; document. **NOT_TESTED** as a measured interval.
2. **Per-node Google behavior** — some exit IPs are more "bot-check" prone than others. No measurement exists; NLO records `evidence` per check, which gives the raw data to build this map later.
3. **Session ↔ egress coupling** (IP-change sensitivity of Google cookies) — hypothesis, **NOT_TESTED**. If confirmed, it drives account↔node affinity routing (P4-3).
4. **Multi-tunnel concurrency** — one xray process per (node, tunnel); the supervisor's tunnel map is in-memory. Boot recovery re-creates tunnels lazily. No evidence of a concurrency ceiling being hit in production. **NOT_TESTED** under load.
5. **Direct-egress policy for non-Google providers** — when P4 adds image/video providers that *can* reach Google directly (datacenter IPs), `NLO_ALLOW_DIRECT_EGRESS` (global) is too coarse. P4 needs *per-provider* egress policy (`must-tunnel` | `tunnel-preferred` | `direct-allowed`), defaulting to `tunnel-preferred` and **fail-closed**. Design item, `NOT_IMPLEMENTED`.

## 7. Procurement / operations checklist (carried into P4 spec)

For each new VLESS node to be added to NLO:

1. Server (IP, not CNAME), port, transport (tcp/ws/grpc), security (none/tls/reality) + all required params per `validateConfig`.
2. **Public** destination passing the SSRF allowlist (private/loopback/link-local rejected pre-dial).
3. Vault-stored UUID (`uuidSecretRef`) — never in the DB row, never in logs.
4. Priority + preferred flag; expected egress IP (for echo assertion) if the node's exit is known.
5. Run staged health (A–E) **before** marking the node `active`; persist evidence.
6. Verify at least one live job through the node with `egressIp` recorded (live gate, manual — never in CI).
7. Confirm curl on the production host is healthy (`findCurl` probe) — the AI-TOOLS `/usr/bin/curl` breakage is a documented prior failure.
