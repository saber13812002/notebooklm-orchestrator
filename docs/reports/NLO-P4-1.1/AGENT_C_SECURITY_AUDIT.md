# Agent C — Security Audit (NLO-P4-1.1)

- **Agent role:** Security Auditor (DeepSeek)
- **Mode:** independent read-only audit; executed sequentially in a separate context (no true subagents
  in this harness — see CONSOLIDATED report §parallelism).
- **Executed:** 2026-11-17 ~15:55–16:30 UTC, repo HEAD `b833d89`.
- **Non-negotiables honored:** no secret value is printed or stored in this report except the
  already-public proxy client UUID, which is referenced by prefix only (`b625fad2…`) because the finding
  is *its presence in the public repo*, not its value. No secret rotation performed; no config changed.

---

## 1. Secret scan (CI script, independent run)

Both CI secret-scan implementations were extracted **verbatim** from the tracked CI files and executed on
this checkout (Agent D §6 has the extraction evidence; results cross-verified here):

| Script | Source | Result |
|---|---|---|
| GitLab `.gitlab-ci.yml` heredoc job | `secret-scan` job | self-test fixture **detected → removed**; working tree clean; **exit 0** |
| GitHub Actions `.github/workflows/ci.yml` `run:` block (L89–174) | `secret-scan` job | identical behavior; **exit 0** |

Patterns covered (both files, 8 patterns): vless:// URI, generic bearer tokens, private-key headers,
generic `key/token/secret/password` assignments above a length threshold, plus the planted
`vless://aaaa0000-b1b1-c2c2-d3d3-4e4e4e4e4e4e@scan-fixture.example:443#selftest` used to prove the
scanner detects before removing. **UNIT-VERIFIED / CODE-VERIFIED** (scripts executed live, exit 0).

### 1.1 The allowlist (4 files)

Both CI files allowlist exactly:

1. `apps/server/scripts/_add-nodes.py`
2. `apps/server/test/api.test.ts`
3. `.gitlab-ci.yml` (its own planted fixture)
4. `.github/workflows/ci.yml` (its own planted fixture)

The first two are real code that legitimately contains vless-shaped strings (fixture nodes in tests, the
historical node-import script). **CODE-VERIFIED.**

## 2. The production node UUID finding (re-verified, as ordered by the mission)

**Facts (CODE-VERIFIED, all read at HEAD / via `git log`):**

- `apps/server/scripts/_add-nodes.py` (140 lines) imports 52 real VLESS node URIs into the local NLO API
  at `http://127.0.0.1:4870` (lines 91–135: GET/POST/PATCH on `/api/proxies`, staged health checks,
  auto-disable of unhealthy nodes).
- All 52 URIs (lines 14–65) share a **single client UUID** (referenced here as `b625fad2…`, full value in
  the file). Hosts: `*.kelmora.ir`, `*.melqora.ir`, `*.zarveto.ir`, `*.torqena.ir`, `*.nelqora.ir`,
  `*.novrisa.ir`, `*.kafshora.ir`, `*.qemitra.ir`, `*.torvixa.ir`, `*.velnaro.ir`; paths
  `/happy-2026-fall` and `/happy-2026-winter`.
- The last commit touching the file is `14954c4` (2026-10-17, "feat(proxy): real xray tunnels verified
  against 52 live VLESS nodes"), which **is an ancestor of `origin/main`** — i.e. the UUID and all 52
  node endpoints are in the **public GitHub repository** (history included; the file is not in git-filter
  scope, and Agent A verified no history rewriting).
- The script never prints the UUID (it only prints node names/ids/egress IPs) — log exposure was handled
  at authoring time.

**Assessment (honest, no overclaim):**
- Is the VLESS client UUID a *credential*? In Xray/VLESS terms it is the client identifier that the
  server expects; rotation of the UUID typically invalidates existing clients. It is **lower-sensitivity
  than a password** (the transport is TLS-wrapped by the endpoint's own TLS/Reality layer), but for a
  shared residential-proxy pool it is the item an operator would rotate to revoke access.
- **Exposure:** public repo → anyone with GitHub access (the repo is public per the dual-repo policy)
  can read the UUID and the 52 endpoints.
- **Action required:** none technically urgent (proxy pool is for Google-egress, endpoints are
  residential and not a service endpoint); **decision required** from the owner: (a) accept the exposure
  and document it, or (b) rotate the pool UUID at the provider side and add the script to git-filter-repo
  history cleanup — a *history-rewriting* action that the mission's non-negotiables forbid without
  explicit approval. Recorded as backlog **C-BL-01 (P1, decision)**.
- No rotation was performed by this audit (non-negotiable).

## 3. `.env` / `.env.example` / vault

- **`.env.example`** (126 lines, read fully): contains **no real secrets** — all values are safe defaults
  or commented-out empty keys (`NLO_VAULT_KEY=`, `NLO_RADIO_TOKEN=`, `NLO_INTERNAL_API_BASE_URL=`,
  `NLO_PYTHON_BIN=`, `NLO_FFMPEG_BIN=` …). One internal IP appears as a *commented default*
  (`172.30.0.133:4000` for the LLM proxy; `172.20.1.53:8043` for radio RAG) — internal-network topology,
  not credentials; acceptable in an example file, noted for completeness. **CODE-VERIFIED.**
- **`.env`** (live, on workstation): git-ignored (`.gitignore:18`), exists, **not tracked**. Permissions
  (`icacls .env`): default inherited ACL — `s.tabatabaei:(F)`, `SYSTEM:(F)`, `Administrators:(F)`, plus
  the sandbox user `CodexSandboxUsers:(I)(RX)`. On Windows this is equivalent to "user-readable" and is
  fine for a single-user dev box; the 0600 convention is a POSIX thing and does not map 1:1. Note: the
  **sandbox user has read (RX) on `.env`** — a low-severity local hardening item (C-BL-05, P3).
- **Vault** ([`apps/server/src/secrets/vault.ts`](apps/server/src/secrets/vault.ts), read fully):
  AES-256-GCM, 12-byte random nonce per record, key = 64-hex from `NLO_VAULT_KEY` **or** auto-created
  `vault.key` (mode 0600 via `writeFileSync … {mode: 0o600}` + `chmodSync 0o600`). Key held in memory for
  process lifetime. `list()` returns refs/kinds only, **never values**. Documented threat model:
  protects against casual exposure/backup mistakes/accidental DB-file logging; full data-dir access
  decrypts everything (accepted, stated). **CODE-VERIFIED** + **UNIT-VERIFIED** (vault exercised through
  webhook/session tests in the server suite — Agent D §2).
- Webhook signing secrets live in the vault via `secretRef`; a missing/unreadable secret dead-letters the
  delivery rather than signing with a wrong key (dispatcher L245–257). **CODE-VERIFIED.**

## 4. Redaction (logs & payloads)

[`packages/shared/src/redaction.ts`](packages/shared/src/redaction.ts) (read fully, 47 lines):
- `vless://…` → `vless://[REDACTED]`
- bare UUIDs → first 4 chars + `…`
- cookie header values → `[REDACTED]`
- `cookie|password|pass|token|SID|HSID|SSID|APISID|SAPISID|OSID|SAPISIDHASH|__Secure-*` KV values →
  `[REDACTED]`
- `Bearer <16+ chars>` → `bearer [REDACTED]`
- `redactDeep()` applies recursively to JSON-able objects.

Application points verified in code: `webhooks/dispatcher.ts` (payload `errorMessage`, all `log()` calls,
network-error strings), `python-worker-provider.ts` (worker `cli_stderr` lines — "cookie dump errors,
storage paths, tokens"), `worker.ts` (python CLI stderr — "session paths, cookie errors,
credential-looking strings"). **CODE-VERIFIED** + **UNIT-VERIFIED** (`packages/shared/test/redaction.test.ts`,
part of the 128 shared tests — Agent D §2).
**Gap (minor, C-BL-06 P3):** redaction is pattern-based; a novel credential format not matching the five
patterns would pass through. Acceptable given the explicit "we redact what we handle" scope statement.

## 5. SSRF guard

[`packages/shared/src/ssrf.ts`](packages/shared/src/ssrf.ts) (read fully, 164 lines):
- Explicit `host[:port]` allowlist only; strict parser rejects URLs/queries/credentials (L144–163).
- Resolved IPs **re-checked** against `classifyIp` — defeats DNS-rebinding to private ranges (L121–137).
- Private/loopback/link-local/reserved **never** allowed unless the entry is explicitly
  `allowPrivate: true` (and link-local stays blocked even then — L129 allows only `private`/`loopback`).
- Applied to: proxy health-check targets and **every webhook delivery destination**
  (dispatcher L231–243; SSRF failure dead-letters immediately, no retry of a disallowed URL).
**CODE-VERIFIED** + **UNIT-VERIFIED** (`ssrf.test.ts`).

## 6. Webhook security

[`apps/server/src/webhooks/dispatcher.ts`](apps/server/src/webhooks/dispatcher.ts) (read fully, 321 lines):
- Outbox: `publish()` snapshots a payload from real DB rows, writes one pending delivery per matching
  enabled endpoint; **never throws**.
- Settlement exactly-once: state flips guarded by `WHERE status='pending'` (repo-level; tested in
  `webhooks.test.ts` — Agent D §2).
- Delivery: POST with `content-type: application/json`, `x-nlo-event`, `x-nlo-delivery-id`,
  `x-nlo-timestamp`, and `x-nlo-signature: t=<unix>,v1=hex(hmac-sha256(secret, t + "." + rawBody))`
  (L259–270). Raw body is the stored `payload_json`, so retries re-send **byte-identical** bodies — the
  HMAC stays verifiable across retries.
- Backoff: 2s base, ×2, cap 5 min; 2xx → delivered; 408/429/5xx/network → retry; other 4xx → dead
  (client rejected); attempts exhausted → dead letter; max 8 attempts by default (env-tunable).
- Fail-closed SSRF gate per §5; scheme restricted to `http:`/`https:`; 10 s request timeout with
  AbortController; body drained/cancelled on non-2xx.
- Loopback targets only with `NLO_WEBHOOK_ALLOW_LOOPBACK=true` (test receivers).
**CODE-VERIFIED** + **UNIT-VERIFIED** (full dispatcher coverage in the server suite).

## 7. API authentication & authorization

- **Tokens** ([`domain/api-tokens.repo.ts`](apps/server/src/domain/api-tokens.repo.ts) +
  `api/routes/tokens.ts`): plaintext `nlo_<slug>_<64hex>` from 32-byte CSPRNG (`randomBytes(32)`), stored
  as **SHA-256** (plaintext shown exactly once at creation), disable/re-enable, revoke, audit trail
  (limit capped at min(requested, 500)). Scopes: `jobs:read, jobs:write, jobs:cancel, jobs:download,
  meta:read, providers:read, admin` (7 entries; `admin` implies all via `hasScope` in `v1.ts`).
- **The `max(6)` finding — re-verified and RESOLVED** (mission requirement):
  `api/routes/tokens.ts` L22 today reads
  `scopes: z.array(z.enum(ALL_TOKEN_SCOPES)).min(1).max(ALL_TOKEN_SCOPES.length).optional()`.
  `git log -p` proves the history: commit `35998c1` (2026-10-28, Phase C) introduced the hardcoded
  `.max(6)`; commit `90f9619` (P4-1A) replaced it with the dynamic cap when `providers:read` was added as
  the 7th scope. The current cap is **correct and self-maintaining** (it tracks the tuple length).
  **VERIFIED** (code read + git history).
- **Auth modes:** default = optional (loopback callers work without a token; a valid token is
  attributed: scopes, rate limit, audit). `NLO_API_AUTH=1` → enforced (401 without token;
  health/openapi/docs GETs stay open). Legacy `/api` surface is never gated (documented, by design —
  single-user loopback model). Bootstrap admin token is minted **offline** on the host
  (`bootstrap:admin`), one-shot while any active token exists. **CODE-VERIFIED.**
- **CORS:** loopback origins only (`http://127.0.0.1:<port>` / `http://localhost:<port>`),
  `credentials: true` (`api/server.ts` L46–49). A browser on a different host cannot call the API —
  consistent with the loopback-only default bind. **CODE-VERIFIED.**

## 8. Rate limiting (two layers)

- **Global:** `@fastify/rate-limit` `global: true, max: 300, timeWindow: "1 minute"`, `allowList: () =>
  false` — i.e. *no* route is exempt, 429 in the standard error envelope
  (`api/server.ts` L51–59). **CODE-VERIFIED.**
- **Per-token:** sliding window, in-memory per process — `TokenRateLimiter` in `api/v1.ts` (L45+),
  defaults `NLO_API_RATE_LIMIT_MAX=120` per `NLO_API_RATE_LIMIT_WINDOW_MS=60000` (config.ts L236–237);
  429 + `retryAfterSeconds` + audit record `rate_limited` (v1.ts L229–240).
- Honest limitation: the per-token limiter is **in-memory per process** (stated in its doc comment) —
  fine for the single-instance model; multi-instance would need a shared store (noted in C-BL-07, P3).
**CODE-VERIFIED.**

## 9. Google session / cookie handling

- Sessions are Playwright storage-state files under `data/sessions/` (dir mode 0700 per AGENTS.md §7;
  the path is created by the session repo — spot-checked in `app-context.ts` wiring).
- **Cookie import** (`POST …/accounts/:id/import-cookies`, `api/routes/sessions.ts` L234–300): the browser
  cookie **jar is read from local disk** (Chrome/Firefox/Edge, allowlisted browser options validated by
  zod refine L265–267 — the client never chooses an executable). The route returns an explicit
  `routingNote`: "cookie jar read from your local browser (direct); the session verification and all
  NotebookLM requests use the configured tunnel" (L298–299). Honest about the one non-tunneled step.
- **Login:** Playwright Chromium launched with `proxy: EgressGateway.browserProxy(endpoint)` — Chromium
  ignores `HTTPS_PROXY` env, so the proxy is passed via the launch option (python-worker-provider.ts
  L331–356). Verification + all NotebookLM traffic tunnel. **CODE-VERIFIED.**
- Storage-state upload (`POST …/import-storage-state`) validates the JSON shape (must contain a
  `cookies` array) before accepting (sessions.ts L370–374). **CODE-VERIFIED.**
- Cookie material in logs: worker stderr explicitly redacted at the source (python-worker-provider.ts
  L402–405, worker.ts L370–372) per §4.

## 10. Egress / proxy credentials

- Proxy nodes are stored as vless URIs **in the DB** (imported via API), not in code — except the
  historical `_add-nodes.py` (see §2). The runtime keeps node config in SQLite; health-check results
  (egress IPs) are recorded as evidence refs.
- `xray` binaries are vendored under `data/vendor/` (git-ignored runtime dir) — not in git. **VERIFIED**
  (dir listing; Agent E confirms the runtime dir on the production host is BLOCKED without SSH).
- Fail-closed egress: job path refuses without an approved endpoint (python-worker-provider.ts L426–431,
  L628–633); auth ops fail closed when nodes are configured; `NLO_ALLOW_DIRECT_EGRESS=1` is the explicit
  dev override (default off, `.env.example` L55–57). **CODE-VERIFIED** + **UNIT-VERIFIED**
  (session-gate / conformance tests — Agent D §2).

## 11. Other checks

- **Uploads:** extension whitelist (`NLO_ALLOWED_AUDIO_EXTENSIONS=wav,mp3,m4a,ogg,flac`), size limit
  (`NLO_MAX_UPLOAD_BYTES` default 200 MB, also Fastify `bodyLimit` + multipart `fileSize`), server-generated
  safe names (`packages/shared/src/safe-name.ts`, unit-tested) — user path components never reach the
  filesystem. **CODE-VERIFIED.**
- **JWT:** none in use (stateless tokens are opaque `nlo_*` strings, not JWTs; Playwright storage-state
  is a JSON file, not a JWT cookie). No `jsonwebtoken` dependency. **CODE-VERIFIED.**
- **Error envelope:** consistent `{ error: { code, message } }` via `ApiCodes` (shared); validation
  errors 400, rate limit 429 with `retryAfterSeconds`; 404s on unknown jobs/artifacts. **CODE-VERIFIED.**
- **git `http.sslverify=false`** (workstation config): means git operations from this machine do not
  verify TLS — a workstation hardening item (C-BL-08, P2); it does not affect the service itself.

## 12. Findings summary (Agent C)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| C-BL-01 | P1 | Shared VLESS client UUID `b625fad2…` + 52 endpoints in **public** GitHub history (`_add-nodes.py`, since `14954c4`) | Owner decision: accept+document or rotate+history-repair (needs approval; no action taken) |
| C-BL-02 | INFO | `max(6)` scope finding **resolved** — dynamic cap in place since P4-1A; verified via code + git history | closed |
| C-BL-03 | INFO | Secret-scan (both CI variants) passes live, exit 0, self-test works | closed |
| C-BL-04 | P2 | `.env.example` exposes internal IPs as commented defaults (topology only, no credentials) | optional comment tweak |
| C-BL-05 | P3 | `.env` ACL grants sandbox user `CodexSandboxUsers` read (RX) | optional local hardening |
| C-BL-06 | P3 | Redaction is pattern-based; novel formats pass through (scope statement exists) | accept or extend patterns |
| C-BL-07 | P3 | Per-token rate limiter is in-memory per process | multi-instance follow-up |
| C-BL-08 | P2 | Workstation git config `http.sslverify=false` | local hardening |
| C-BL-09 | INFO | Webhook HMAC, outbox, backoff, SSRF, dead-letter all correct by code read + unit tests | closed |
| C-BL-10 | INFO | Vault AES-256-GCM correct; key-file 0600; `list()` never exposes values | closed |

## 13. What this agent did NOT do

- No rotation, no key change, no cookie capture, no browser launch, no production probe (production
  internals are Agent E's and are BLOCKED without SSH — see that report).
- No penetration testing; all findings are from code/config/git-history inspection and the CI scripts
  executed as-is.
