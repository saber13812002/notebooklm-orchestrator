# NLO-P4 — Account, Session & Proxy Architecture

Mission: **NLO-P4-0**. Covers the **Google Account Manager**, **Session & Cookie security model**, and **Proxy Manager** target design (mission design work items 2, 3, 4).
Companion to **ADR-003** (accounts) and **ADR-004** (egress). Baseline: `main @ 76cd5f03`. Design document — no code changes.
Status labels as defined in [`NLO_P4_TARGET_ARCHITECTURE.md`](NLO_P4_TARGET_ARCHITECTURE.md).

---

## 1. Baseline (what exists, verified)

| Asset | Status | Evidence |
|---|---|---|
| `accounts` table (status 6-state, `is_default` single-default enforced in repo) | `IMPLEMENTED` / `UNIT_TESTED` | migrations 0001/0003; accounts.repo |
| `auth_sessions` (9-state machine, `UNIQUE(account_id, provider, profile)` after 0004 fix) | `IMPLEMENTED` / `UNIT_TESTED` | migrations 0002→0004; shared types |
| Per-account Playwright storage-state file (`sessionDir/nlo-<accountId>.json`, `0600`, atomic) | `IMPLEMENTED` | sessions repo audit |
| 10-minute verification TTL — usable only when freshly verified | `IMPLEMENTED` | admission logic |
| Vault AES-256-GCM (per-record nonce), key `0600` | `IMPLEMENTED` | vault module |
| Proxy node registry + staged A–E health + SSRF guard + fail-closed egress + xray runtime + curl-primary transport | `IMPLEMENTED` / `INTEGRATION_TESTED` / `LIVE_VERIFIED` | proxy/* (see [`NLO_PROXY_EGRESS_RESEARCH.md`](../research/NLO_PROXY_EGRESS_RESEARCH.md)) |
| Scheduled keepalive / multi-account rotation / credential kinds beyond storage-state | `NOT_IMPLEMENTED` | — |

## 2. Google Account Manager (target)

### 2.1 Ownership model: platform-owned credentials

Decision (ADR-003): **NLO is the platform owner of the Google session artifacts it stores.** Users *grant* credentials to NLO (login flow or import); NLO stores, verifies, keeps alive, and revokes them locally. The user's browser is only the *issuance* device — NLO never reads a live browser at request time (that is the browser-automation family's model, which NLO deliberately avoids).

Consequences:
- **Onboarding is a one-time grant per credential kind** (§2.4), not a per-session act.
- **NLO's data lifecycle owns the artifact**: deletion of an account removes its session file(s) and vault refs; the Google-side session itself is not revoked (no API for that — honest limitation).
- **User-owned alternative**: a *BYO-cookie* mode (user refreshes cookies externally, re-imports) remains supported as the `cookie_file` import path — for operators who want zero standing session in NLO.

### 2.2 Credential kinds (per account)

| Kind | Artifact | Issuance | Keepalive | Value/blast radius | Status |
|---|---|---|---|---|---|
| `storage_state` | Playwright storage-state JSON (0600) | interactive login in NLO | scheduled verification (NLO) | full product session | `IMPLEMENTED` |
| `cookie_file` | imported cookie export (processed to storage-state) | user exports + uploads | scheduled verification (NLO) | full product session; **domain-selection rule required** (prefer `.google.com` for SID-family — v0.16.5 ecosystem bug class) | `IMPLEMENTED` (import path) |
| `master_token` | notebooklm-py master token file (vault-stored) | one-time upstream CLI flow, dedicated account | **browser-free mint on demand** (upstream mechanism) | **full account credential — highest value** | `NOT_IMPLEMENTED` (P4-3; upstream `EXPERIMENTAL`) |
| `enterprise_sso` | storage-state against `notebook.cloud.google.com` + project context | org SSO login in NLO | scheduled verification (NLO) | org notebook access | `NOT_IMPLEMENTED` (P4-3; ecosystem evidence `EXPERIMENTAL`) |

Storage rules (extend, don't replace):
- Secrets (master token) → **vault** (AES-256-GCM, 0600 key) via `credentialRef = vault:<id>`; session files stay on disk `0600` under the session dir `0700` (existing pattern).
- The DB stores **refs and metadata only** — never the secret, never the cookie values (redaction invariants unchanged).
- One credential row per `(account, host_profile, kind)`; an account may hold consumer + enterprise credentials simultaneously.

### 2.3 Lifecycle states (policy layer over the existing 9-state machine)

The existing `AuthSessionState` machine is **unchanged**. The Account Manager adds a *credential-level* state derived from it:

```
credential.status ∈ active | degraded | needs_reauth | disabled
  active        = latest auth_session AUTHENTICATED within TTL and keepalive healthy
  degraded      = keepalive failing (backoff active) but last-known-good within cookie lifetime
  needs_reauth  = auth_session NEEDS_REAUTH / EXPIRED → jobs park in WAITING_FOR_ACCOUNT
  disabled      = operator-disabled (account retained, no routing)
```

**Scheduled keepalive** (new, P4-3):
- Timer (in-process; survives restart by recomputing from `lastVerifiedAt`): re-verify each `active` credential every **K = 240 min** (inside the 2–4-week cookie lifetime with wide margin; configurable).
- **Failure budget**: 3 consecutive keepalive failures → `degraded` + backoff (mirrors provider retry discipline: exponential, capped); browser-bound kinds may need a human when fully expired (documented per kind: `keepaliveMode: http | browser | master_token`).
- Keepalive emits job-independent **events** (`account_keepalive_ok|fail|exhausted`) → webhook outbox (existing dispatcher) so operators get alerts.
- **Job admission is unchanged**: a job still requires a session verified within the 10-min TTL *at admission*; keepalive's job is to make that true without an on-demand browser.

### 2.4 Onboarding (user-visible steps, per kind)

1. **Interactive login (default)** — NLO opens the browser flow (Chrome/Edge/Chromium); user signs in; NLO stores the storage-state, verifies, shows the resolved email + state. *Today's flow, unchanged.*
2. **Cookie import (advanced)** — user uploads an exported cookie file; NLO applies the **domain-selection rule** (narrowest covering domain for SID-family names), verifies, stores. Failure modes documented: mixed-domain exports, fully expired sessions.
3. **Master token (P4-3, advanced)** — one-time upstream CLI step (`notebooklm login --master-token`); NLO imports the token into the vault; from then on, cookies are minted on demand. **Dedicated Google account is a documented requirement** (upstream security guidance: the token is a full-account credential).
4. **Enterprise (P4-3, org)** — admin provides project ID/number + location (`global|us|eu`); NLO performs an isolated SSO login against the Enterprise host; credential bound to the project. *Live-verification against a real GCP project is a precondition for marking `IMPLEMENTED` (today: `NOT_TESTED`).*

### 2.5 Multi-account routing policy (the part that doesn't exist yet)

Current: `preferredAccountId` is a *hint* resolved ad-hoc. Target (P4-3): a **routing policy** evaluated at admission (`WAITING_FOR_ACCOUNT`):

```
select_account(job, provider):
  1. explicit:   job.preferredAccountId if present AND eligible
  2. affinity:   accounts with a stable (account↔node) pairing for this job's egress
                 (only if the session↔IP hypothesis is confirmed — else skip; see §4.3)
  3. quota:      eligible accounts ordered by remaining usage (usage.introspect when
                 available; else by recent-attempt success rate — honest fallback, no invented quotas)
  4. priority:   operator-pinned account order (accounts.priority, new column — data, not logic)
  5. rotation:   round-robin among the rest (roomi-fields pattern: pick up when a quota runs out)
  eligibility:   credential.status == active AND session verified within TTL AND provider.authRequirement satisfied
```

- **No routing happens inside a provider adapter** — the Account Manager returns a `CredentialRef`; the adapter receives it opaquely.
- Every attempt records which account+node served it (existing `job_attempts` columns) — rotation/affinity tuning is *data-driven after the fact*, not guessed.
- **Quota facts** (ecosystem VERIFIED): per-tier notebook/source/studio limits + rolling ~5h compute window + weekly cap (notebooklm-py quota docs; jacob-bd `nlm usage`). NLO must *read* these (`usage.introspect` capability) rather than assume numbers.

## 3. Session & cookie security (invariants, carried + extended)

1. **No secret in git / logs / chat / API responses** (existing redaction module covers SID-family, cookies, bearer — VERIFIED in [`packages/shared/src/redaction.ts`](../../packages/shared/src/redaction.ts)).
2. **Files**: session dir `0700`, files `0600`, vault key `0600`, xray configs `0600` (existing).
3. **Atomic writes** for storage-state (existing) — a crash mid-login never leaves a torn session file.
4. **Domain-selection rule** for cookie imports (new, §2.2) — validated at import, choice recorded (redacted) in metadata.
5. **Credential kind is never inferred** — kind changes are explicit operator actions (no silent upgrade of a cookie to a master token).
6. **TTL is the only "usable" definition** — 10-min verification for admission; keepalive freshness for routing. No session is "usable" by age alone.
7. **Deletion is local** — deleting an account removes NLO's artifacts; it does not revoke the Google-side session (no API exists). Documented, honest.
8. **Admin surface**: the web `/accounts` page already lists states; P4 adds credential-kind display + keepalive health + routing priority (UI over existing routes, no new auth mechanism).

## 4. Proxy Manager (target)

The proxy subsystem is NLO's strongest differentiator; P4 **adds a gateway boundary and routing policy, preserves all fail-closed semantics** (ADR-004).

### 4.1 Egress Gateway (new interface over the existing Proxy Manager)

```
EgressGateway:
  acquire(jobCtx, providerEgressPolicy) → EgressEndpoint
      // EgressEndpoint = { localPort, expectedEgressIp?, nodeId, evidenceRef }
      // policy must-tunnel  → healthy node required, else WAITING_FOR_PROXY (fail-closed)
      // policy tunnel-preferred → healthy node if available; else direct ONLY if
      //   NLO_ALLOW_DIRECT_EGRESS AND provider declares direct-allowed-acceptable
      // policy direct-allowed → direct (still recorded: nodeId=null, egressIp=host egress)
  release(nodeId)
  health(nodeId) → ProxyHealth (existing staged A–E, 10-min TTL)
```

- The Job Engine acquires at admission (state `WAITING_FOR_PROXY` → ready); the provider adapter receives the **endpoint descriptor** (loopback port + expected egress IP), never a tunnel object → **removes the `tunnelEnv` coupling** (current coupling point #1).
- **Mid-job node switch** is now expressible: on a `proxy`/`connectivity` failure, the engine may re-acquire a *different* node and continue — *but only if the op has no recorded external id yet*; if an external id exists, the job follows the UNKNOWN_EXTERNAL_STATE rule (ADR-007): resume on the *same* account, retry transport, never resubmit blindly.
- **Per-node concurrency cap** (new, data): `proxy_nodes.max_concurrent_tunnels` (default 1 today — one xray process per tunnel is the current reality); the gateway queues acquisitions.

### 4.2 Node selection policy (extends priority/preferred)

```
select_node(jobCtx, account):
  1. affinity:   node paired with the selected account (if §4.3 confirmed)
  2. preferred:  node.preferred flag (existing)
  3. priority:   ascending priority (existing)
  4. health:     healthy within TTL (existing); stale/unknown ⇒ probe-on-demand (stage D quick check)
  5. load:       tunnels-in-use < max_concurrent_tunnels
  else → no node ⇒ WAITING_FOR_PROXY (fail-closed; never implicit direct)
```

### 4.3 Account↔node affinity (conditional feature)

- **Hypothesis** (NOT_TESTED): Google session cookies may be sensitive to source-IP churn; a stable (account ↔ node) pairing reduces `auth`-class failures.
- **Design**: affinity is a *data* map (`account_node_affinity(account_id, node_id, confidence, last_confirmed_at)`) maintained by outcomes — an `auth` failure right after a node switch *raises* the affinity signal; repeated success on a pairing *confirms* it. The selector uses it only at confidence ≥ threshold (P4-tunable), and the operator can pin/clear pins.
- **Kill switch**: affinity off by default until a live A/B (same account, fixed vs rotating node) produces evidence. No behavior change on assumption.

### 4.4 Operations (procurement + runbook deltas)

- Node add/retire flows gain the gateway's acquisition stats (per-node: acquisitions, failures, egress-IP drift events from stage-D echo).
- Egress-IP **drift alerting**: when stage D observes a different egress IP than the node's recorded expected IP → event + health evidence (operator decides: update record or investigate node).
- Existing runbooks (`docs/operations/`) are extended, not rewritten, in P4-3.

## 5. Interaction matrix (admission sequence, P4)

```
job queued
 └─ VALIDATING: intake validated (format matrix vs PROVIDER capabilities)
 └─ QUEUED
 └─ admission:
     provider  = select_provider(job)            # registry: capabilities + status
     account   = select_account(job, provider)   # routing policy §2.5
        none eligible  → WAITING_FOR_ACCOUNT (park; keepalive/reauth will unblock)
     egress    = egress.acquire(job, provider.egressPolicy)   # §4.1
        no healthy node (must-tunnel) → WAITING_FOR_PROXY (park)
     account  verify within TTL? (10-min gate, existing)
        stale  → keepalive fast-path (http/master_token kinds) else WAITING_FOR_ACCOUNT
 └─ RUNNING (Ctx = {provider, creds, egress, signals})
 └─ outcome:
     SUCCEEDED  → artifacts, events, webhook
     FAILED     → failure-class policy (ADR-007): retry / failover / needs-attention
     CANCEL*    → existing cancel semantics (local kill; server-side op may complete)
 └─ release: egress.release(nodeId); account usage recorded (attempts table)
```

No new job statuses are introduced by P4 for any of the above — the existing 12-state machine (12 values incl. terminal) is sufficient; provider selection happens inside `VALIDATING`, account/egress waits use the existing `WAITING_*` states.

## 6. What is explicitly out of scope (honest)

- **Google account provisioning** (creating Google accounts) — operator task, not a platform feature.
- **Organization-wide SSO federation** (IdP integration) — beyond the Enterprise-SSO credential kind; would be P4+.
- **Multi-region egress orchestration** (picking nodes by geography) — data exists (evidence strings); policy is P4+ until needed.
- **Credential escrow/DR** (off-host backup of session files) — the P3 backup report covers DB+env; session files are local-runtime state (documented limitation; master-token kind improves recoverability because it is a single vault record).
