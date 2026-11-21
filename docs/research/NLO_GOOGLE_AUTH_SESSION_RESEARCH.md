# NLO-P4-0 — Google Auth & Session Research

Mission: **NLO-P4-0 — Universal Modular Architecture & NotebookLM Ecosystem Discovery**
Date accessed: **2026-11-15**. Source-first: NLO code at `main @ 76cd5f03` + ecosystem READMEs fetched 2026-11-15.
Status labels: `VERIFIED` (code read / doc fetched) · `PARTIAL` · `EXPERIMENTAL` · `UNSUPPORTED` · `UNKNOWN` · `NOT_TESTED`.

---

## 1. The credential spectrum (what actually exists)

Google does not expose an official API for NotebookLM/Gemini Notebook, so "auth" in this ecosystem is a spectrum of _session artifacts_, each with a different lifetime, value, and blast radius:

| #   | Artifact                                                                                        | What it is                                                                    | Lifetime                                                                             | Blast radius if leaked                                                                                  | Used by (evidence)                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Browser cookie set** (SID, HSID, SSID, APISID, SAPISID, OSID, `__Secure-*`)                   | Raw logged-in session for `notebook.google.com` / `notebook.cloud.google.com` | ~2–4 weeks (jacob-bd README: "Cookies ~2-4 weeks"); CSRF token ~minutes, per-session | Full account access to the product (create/read/generate/delete)                                        | all 5 ecosystem projects; NLO                                                                                                       |
| 2   | **Playwright storage-state file** (cookies + localStorage snapshot, JSON)                       | Serializable form of #1                                                       | same as #1                                                                           | same as #1                                                                                              | NLO (storage-state per account), notebooklm-py (`from_storage`), gemini-notebook-mcp-cli (saved profile)                            |
| 3   | **Cookie export file** (Netscape `cookies.txt` from a real browser)                             | Bulk import source                                                            | same as #1                                                                           | same as #1 (file may contain many domains)                                                              | gemini-notebook-mcp-cli (`nlm login --manual --file`), notebooklm-py (`login --browser-cookies`)                                    |
| 4   | **Master token** (persistent, mints short-lived web/mobile bearer tokens on demand)             | Higher-order credential: _can recreate_ #1 without a browser                  | durable until rotated/revoked                                                        | **Full account credential** — upstream says "use a dedicated account and protect the profile carefully" | notebooklm-py Android backend only (`master_token.json`)                                                                            |
| 5   | **Enterprise SSO session** (org account against `notebook.cloud.google.com`, project-qualified) | Same artifact class as #1–#2 but bound to a GCP project/deployment            | org policy dependent                                                                 | org notebook access                                                                                     | gemini-notebook-mcp-cli (EXPERIMENTAL, live-verified `global` deployment)                                                           |
| 6   | **Refresh token / OAuth**                                                                       | —                                                                             | —                                                                                    | —                                                                                                       | **Does not exist** for NotebookLM/Gemini Notebook (no official API → no OAuth grant for it). Every project in the sweep uses #1–#5. |

**Key negative finding (VERIFIED across the ecosystem):** there is _no_ refresh-token/OAuth flow for NotebookLM. "Refresh" everywhere means _re-extract cookies_ (browser) or _mint from master token_ (Android backend). Any NLO design that assumes an OAuth refresh token is wrong.

### Cookie-domain subtlety (a real failure mode)

gemini-notebook-mcp-cli **v0.16.5** (2026-11-14) fixed: _"cookie file imports prefer `.google.com` values… Previously the last entry won, so an 'export all cookies' file could save the `.youtube.com` values of `SID`, `HSID`, `SSID`, `APISID`, and `SAPISID`."_

→ **Rule for NLO session import:** when importing a cookie file, for each SID-family name **select the value whose domain is the narrowest that still covers the NotebookLM host** (`.google.com`), never "last one wins". NLO's importer should validate that imported SID-family values are present and `.google.com`-domain before accepting the file, and record which values were chosen (redacted) in the session metadata.

## 2. NLO's current auth/session model (code-verified at `76cd5f03`)

### 2.1 Storage & lifecycle

- One **Playwright storage-state file per account**: `sessionDir/nlo-<accountId>.json`, mode `0600`, written atomically (VERIFIED — sessions repo).
- `credentialRef` for an account is `session:<accountId>` — the DB stores a _reference_, not the secret.
- `auth_sessions` table (migrations 0002 → rebuilt in **0004** with `UNIQUE(account_id, provider, profile)`, fixing the "one account per profile globally" bug) with 9-state machine (`AuthSessionState` in [`packages/shared/src/types.ts`](../../packages/shared/src/types.ts)): e.g. `UNVERIFIED → VERIFYING → AUTHENTICATED | EXPIRED | NEEDS_REAUTH | …`.
- **Usability gate:** a session counts as `AUTHENTICATED` (usable) only within a **10-minute verification TTL** (`lastVerifiedAt`). The account eligibility check for a job consults this — no job runs on an unverified session.
- Reauth flow: interactive Playwright login writes a new storage-state; verification re-checks against the live product.

### 2.2 Secret handling around sessions

- **Vault:** AES-256-GCM per record (unique nonce), key from `NLO_VAULT_KEY` or `data/vault.key` (`0600`). Used for VLESS UUIDs today (`uuidSecretRef`); the same mechanism is the natural home for any _higher-value_ credential (e.g. a future master token).
- **Redaction** ([`packages/shared/src/redaction.ts`](../../packages/shared/src/redaction.ts)): SID/HSID/SSID/APISID/SAPISID/OSID/SAPISIDHASH/`__Secure-*`/cookie/password/token/bearer patterns redacted in logs, job events, webhook payloads.
- **Session files are never in git** (`.gitignore`); never in logs (redaction); session dir `0700`.

### 2.3 NLO API tokens (consumer auth — distinct from Google sessions)

`nlo_<slug>_<64-hex>` (32-byte CSPRNG), **SHA-256 hash stored**, one-time plaintext disclosure, 30 s `lastUsedAt` throttle, 6 scopes (`jobs:read|write|cancel|download`, `meta:read`, `admin`), append-only `api_audit_log`, token-scoped idempotency (partial unique index on `(token_id, idempotency_key)`). VERIFIED in [`apps/server/src/domain/api-tokens.repo.ts`](../../apps/server/src/domain/api-tokens.repo.ts) + migration 0005.

**Distinction that must stay sharp in P4 docs:**

- _Google session_ = NLO's credential **to** a content provider (per account).
- _NLO API token_ = a consumer's credential **to** NLO (per integration).
  P4's Google Account Manager manages the first; MCP server auth reuses the second.

## 3. Ecosystem auth patterns (what to adopt)

| Pattern                                                                                                                                                                                                         | Source (evidence)                                                               | NLO fit                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Three ways to get cookies**: interactive login / import from signed-in browser / master token                                                                                                                 | notebooklm-py README                                                            | NLO has #1 and #3 (browser import); #4 (master token) is the strategic addition — it enables **unattended, browser-free keepalive**                                                                                                                                       |
| **Master-token auth**: mints fresh web cookies on demand, no per-session browser; "the auth model for servers, CI, and remote connectors"; upstream warns it is a _full-account credential_ → dedicated account | notebooklm-py Android backend docs                                              | **Adopt in P4** as a per-account optional credential, stored in the vault (0600), with a `credentialKind` field (`session_state` \| `master_token`), and a dedicated-account requirement documented                                                                       |
| **`auth refresh --quiet`** scheduled keepalive (cron/launchd/systemd) so sessions never lapse unattended                                                                                                        | notebooklm-py, gemini-notebook-mcp-cli (`nlm auth refresh`, `--http-only`)      | NLO should have a **scheduled verification job** (in-process timer or cron via deploy script) that re-verifies each active account's session and transitions the `auth_sessions` state machine — partially exists (verification on demand); scheduled keepalive = P4 work |
| **Failure budget + per-process cooldown for auto-refresh** (avoids hammering Google when login is fully expired)                                                                                                | gemini-notebook-mcp-cli README (auth lifecycle)                                 | Adopt the _policy shape_: NLO's session verifier should back off after N consecutive failures (mirrors NLO's existing retry discipline for provider failures)                                                                                                             |
| **Encrypted-at-rest saved login with OS-keystore key** (opt-in "protected" storage)                                                                                                                             | gemini-notebook-mcp-cli README                                                  | NLO's AES-256-GCM vault already meets the property; OS-keystore key storage is a _convenience upgrade_, not a gap. Record as `PARTIAL → sufficient`.                                                                                                                      |
| **Auto CSRF/session refresh on request failure**                                                                                                                                                                | gemini-notebook-mcp-cli (v0.1.9+), roomi-fields (auto-reauth on session expiry) | NLO's worker already surfaces `needsReauth` from the provider; the _reactive_ refresh path exists. Document the flow; no new mechanism required.                                                                                                                          |
| **Auth health probe distinguishing "semi-stale" from "stale"** (multi-probe checker, PR #219 in gemini-notebook-mcp-cli credits)                                                                                | gemini-notebook-mcp-cli README                                                  | NLO's 10-min TTL + verification probe is simpler and honest; keep, but consider a two-tier probe (cheap HTTP probe → full verification) to reduce TTL pressure.                                                                                                           |
| **Multi-account = isolated credential subtree per account** (profile dir / named profile / account slug)                                                                                                        | all 5 projects                                                                  | NLO already does this (`nlo-<accountId>.json` per account) — parity achieved                                                                                                                                                                                              |
| **Unattended machines: browser-based refresh needs a saved Chrome profile; `NOTEBOOKLM_COOKIES` env var overrides saved credentials**                                                                           | gemini-notebook-mcp-cli README                                                  | NLO design note: env-var cookie override is a _dev/testing_ path only; production must use named account sessions (no ambient env credential)                                                                                                                             |

## 4. Target model for P4 — Google Account Manager (credential side)

(Design detail lives in `docs/architecture/NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`; this section fixes the credential facts.)

### 4.1 Credential kinds per account (schema intent, no migration in P4-0)

```
account_credentials (proposed, P4-3)
  account_id        -- FK accounts
  credential_kind   -- 'storage_state' | 'cookie_file' | 'master_token' | 'enterprise_sso'
  credential_ref    -- vault ref / session file ref (never the secret itself)
  host_profile      -- 'consumer' (notebook.google.com) | 'enterprise' (notebook.cloud.google.com)
  project_id        -- enterprise only (nullable)
  location          -- enterprise only: 'global'|'us'|'eu' (nullable)
  status            -- active | disabled
  last_verified_at  -- same 10-min TTL semantics as today
```

- `storage_state` and `cookie_file` are the same artifact class (#2/#3 above) with different provenance — keep one kind (`storage_state`) and record _import source_ in metadata.
- `master_token` is a **new, higher-value kind**: vault-stored, dedicated account required, browser-free keepalive. **NOT_TESTED** for NLO (upstream capability, not yet in NLO).
- `enterprise_sso` = storage-state against the Enterprise host + project context. **NOT_TESTED** for NLO.

### 4.2 Lifecycle states (extend the existing 9-state machine, do not replace it)

The existing `AuthSessionState` machine (VERIFIED in shared types) already covers the storage-state lifecycle. Additions for P4 are _credential-kind-agnostic policy layers_, not new states:

1. **Scheduled keepalive** (P4-3): timer re-verifies each `active` credential every `K` minutes (proposed K=240, inside the known 2–4 week cookie lifetime with wide margin); consecutive-failure backoff with a failure budget (≥3) before marking `NEEDS_REAUTH` and emitting an event + webhook.
2. **Verification TTL unchanged (10 min)** for _job admission_; keepalive keeps `lastVerifiedAt` fresh so the admission gate passes without an on-demand browser.
3. **Reauth remains human-initiated** (interactive login) — except master-token kind, which self-heals from the vault credential without human action (upstream behavior, VERIFIED in notebooklm-py docs).

### 4.3 User onboarding guide (facts for the P4 spec)

For each credential kind, the _user-visible_ steps:

1. **Browser session (default, what NLO has today):**
   - NLO opens a Playwright browser (or reuses Chrome/Edge) → user logs into Google → NLO stores `nlo-<accountId>.json` (0600) → NLO verifies → account usable.
   - Session lasts ~2–4 weeks (ecosystem evidence); NLO's keepalive refreshes it; on expiry the account shows `NEEDS_REAUTH` and jobs for it queue in `WAITING_FOR_ACCOUNT`.
2. **Cookie file import (advanced):**
   - User exports cookies from a signed-in browser (extension) → uploads the file → NLO extracts SID-family values **preferring `.google.com` domain** (rule §1) → verifies → same session file result.
   - Failure mode to document: mixed-domain exports (the v0.16.5 bug class).
3. **Master token (P4, advanced):**
   - One-time: `notebooklm login --master-token --account you@example.com` in a notebooklm-py CLI session (upstream flow) → NLO imports the master-token file into the vault → from then on, NLO mints cookies on demand; **dedicated Google account recommended** (upstream security guidance).
4. **Enterprise (P4, org):**
   - Org admin provides: GCP project ID/number, deployment location (`global`/`us`/`eu`), and an org SSO login → NLO performs an isolated login against `notebook.cloud.google.com` → stores as `enterprise_sso` credential bound to the project.
   - Evidence base is third-party (EXPERIMENTAL) — NLO must live-verify before marking IMPLEMENTED.

### 4.4 Security invariants (carried from `SECURITY.md`/AGENTS.md, unchanged)

- No Google credential in git, logs, chat, or API responses (redaction + vault).
- Session files `0600`, session dir `0700`, vault key `0600`.
- Credential kind is _never_ downgraded by inference (a master-token account is not silently "converted" to cookie-only).
- One session file per `(account, host_profile)` — an account can hold _both_ a consumer and an enterprise session (different hosts, different credential subtrees).

## 5. Open questions (honest, unresolved)

1. **Master-token durability** — upstream treats it as durable but it is an undocumented Google credential; NLO must design for silent revocation (verification fails → `NEEDS_REAUTH` with a master-token-specific message). **NOT_TESTED.**
2. **Enterprise host variants** (`notebooklm.cloud.google.com`, `vertexaisearch.cloud.google.com` legacy per jacob-bd) — NLO should make the host _configurable per credential_, not hardcoded.
3. **Cookie lifetime under Iranian egress** — NLO's production path goes through a VLESS tunnel; whether Google's session heuristics (IP-change sensitivity) interact with rotating tunnel exits is **NOT_TESTED** (evidence: NLO jobs do succeed live through the tunnel, but long-lived-session stability over weeks is unmeasured).
4. **PSIDTS/browser-bound cookies** — jacob-bd notes `--http-only` refresh "cannot renew browser-dependent PSIDTS cookies or revive a fully expired login"; NLO's keepalive must know when a credential _requires_ a browser refresh (a `keepaliveMode: http|browser|master_token` property per credential kind).
