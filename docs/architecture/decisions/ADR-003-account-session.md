# ADR-003: Account Manager Owns Google Credentials (kinds, keepalive, routing)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md`](../NLO_ACCOUNT_SESSION_PROXY_ARCHITECTURE.md), research [`NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md)

## Context

NLO already stores Google sessions as Playwright storage-state per account (`nlo-<accountId>.json`, `0600`, atomic writes) behind a 9-state `AuthSessionState` machine, with a 10-minute verification TTL, vault-backed secrets, and redaction. Research established two facts that shape this ADR: (1) **no OAuth/refresh-token exists for NotebookLM** — the credential *is* a cookie/storage-state/master-token artifact; (2) the ecosystem's durable-credential patterns (nblpy **master token** = self-healing, cookie-free at request time; gemni-nbl **protected login storage** in an OS keystore; roomi **multi-account rotation**) are all *better* than raw storage-state alone.

The mission requires **multiple Google accounts** with **multi-account routing** and **failover**. The open questions: who owns the credential lifecycle; what credential *kinds* exist; how do we keep sessions alive; and how is an account *chosen* for a job.

## Decision

1. **NLO is the platform owner of the Google session artifacts it stores.** Users *grant* credentials to NLO (login flow or import); NLO stores, verifies, keeps alive, and revokes them locally. The user's browser is only the *issuance* device — NLO never reads a live browser at request time (the browser-automation family's model, which NLO deliberately avoids).
2. **Four credential kinds** (a `kind` column on the account credential row; the storage artifact and its issuance differ per kind):
   | Kind | Artifact | Keepalive | Blast radius |
   |---|---|---|---|
   | `storage_state` | Playwright storage-state JSON (0600) | scheduled re-verify | per-account cookies |
   | `cookie_file` | imported cookie set | scheduled re-verify | per-account cookies |
   | `master_token` | nblpy master token (mints short-lived bearer, cookie-free at request time) | self-healing (re-mint) | one token |
   | `enterprise_sso` | Workspace/Enterprise SSO profile (+ `NOTEBOOKLM_PROJECT_ID`, `LOCATION`) | SSO-managed | org-scoped |
   *`master_token` and `enterprise_sso` are `PROPOSED` (P4-3); `storage_state`/`cookie_file` are `IMPLEMENTED`/`PARTIAL` today.*
3. **Scheduled keepalive + failure budget:** a keepalive tick (default **K=240 min**) re-verifies each enabled account; a **failure budget of 3** consecutive failures moves the account to `degraded`→`needs_reauth` and raises an event → webhook. Keepalive is *scheduled*, not on every job.
4. **Routing policy (5 steps, deterministic, logged):** explicit `preferredAccountId` → account↔provider **affinity** → **quota** eligibility → **priority** → **rotation**. Eligibility rules: only `active` accounts with a *recently verified* session (TTL) are eligible; a job may request a preferred account but the policy may override for quota/failure reasons (recorded in an event).
5. **Session security invariants preserved:** 0600 artifacts, vault refs (never raw secrets in DB rows), redaction in all derived text, the `.google.com` cookie-domain preference rule (the v0.16.5 last-entry-won bug class), and "a DB status flag is never evidence of auth — only a recent live `AUTHENTICATED` verification is."

## Rationale
- **Platform ownership** is what allows multi-account routing + failover: if the user's browser owned the session, NLO couldn't pick/rotate/keep-alive accounts. It also matches how NLO already stores storage-state.
- **Credential kinds** future-proof against the single biggest fragility of raw cookies (they expire in ~2–4 weeks). The master token (self-healing, cookie-free) is the ecosystem's most durable pattern and is directly adoptable via the already-pinned nblpy 0.8.5.
- **Scheduled keepalive + budget** converts silent session death (the #1 mid-job surprise) into an *early, observable* degraded state — feeding ADR-007's failover policy.
- **Deterministic, logged routing** makes account choice auditable and testable (no hidden randomness in who serves a job).

## Consequences
**Positive:** multi-account routing + failover become expressible; session death is early-observable; master-token durability is adoptable; the 9-state machine is *preserved* (a lifecycle policy is layered over it, not replacing it).
**Negative / risks:** master-token durability under Iranian-egress IP sensitivity is `NOT_TESTED` (a hypothesis, gated by a live run before it's relied on for routing); the enterprise-SSO path is `EXPERIMENTAL` in the ecosystem (gemni-nbl) and must pass a live gate before admission; keepalive adds scheduled load (bounded, per-account).

## Alternatives considered
- **User-owned browser sessions (browser-automation family):** rejected — NLO can't route/rotate/keep-alive; couples NLO to a live browser at request time.
- **One credential kind (storage-state only), no routing:** rejected — blocks multi-account + failover; fragile cookie expiry.
- **Adopt the OS-keystore protected storage (gemni-nbl):** *partial* — the keystore idea is noted for the master-token kind's local key, but NLO's existing vault (`AES-256-GCM`, `0600`) already meets the bar; no new keystore dependency in P4.

## Evidence
- Storage-state + 9-state machine + TTL: [`apps/server/src/domain/auth-sessions.repo.ts`](../../../apps/server/src/domain/auth-sessions.repo.ts), [`AuthSessionState`](../../../packages/shared/src/types.ts:34); migration 0004 (UNIQUE account/provider/profile).
- Vault + redaction: [`packages/shared/src/redaction.ts`](../../../packages/shared/src/redaction.ts).
- Ecosystem credential patterns: [`NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md) §1 (credential spectrum), §3 (adopt table).
- Quota facts (rolling ~5 h window + weekly cap by tier): [`NLO_GOOGLE_AUTH_SESSION_RESEARCH.md`](../research/NLO_GOOGLE_AUTH_SESSION_RESEARCH.md) §1.
