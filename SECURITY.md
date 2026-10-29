# Security — NotebookLM Orchestrator

This file is the **policy** (what must always hold). The detailed threat
model, decisions, and evidence live in
[`docs/security/threat-model.md`](docs/security/threat-model.md). The binding
rules for agents are in [`AGENTS.md`](AGENTS.md) §7.

## 1. Trust model (current)

- **Local single-user.** The server binds to `127.0.0.1` by default. The
  trust boundary is the machine; there is **no user system**.
- **Scoped API tokens for `/api/v1`.** Token auth is optional by default
  (loopback trust preserved) and enforced with `NLO_API_AUTH=1` (401 for
  non-exempt v1 routes; health/openapi/docs GETs stay open). The legacy
  `/api` surface is never gated. The **first** (bootstrap) token can only be
  minted by an **offline host CLI**
  (`npm run bootstrap:admin --workspace @nlo/server`); there is no
  unauthenticated — or any — network endpoint that can create it, and the
  CLI refuses to run while any active token exists (one-shot; recovery =
  revoke all active tokens, re-run). See
  [`docs/api/README.md`](docs/api/README.md) § "First token (bootstrap)".
- **The frontend only talks to `/api/*`.** It never reaches the database,
  the Python worker, MCP, or provider internals.
- **Fail-closed egress.** Provider traffic goes out only through a verified
  proxy tunnel (Xray). Without one, the job fails — there is no silent
  direct egress. This is enforced in code and covered by tests
  (`apps/server/test/fail-closed.test.ts`).

External/remote consumers (third-party systems) are **not** supported in the
current trust model; enabling them requires API authentication plus a
reverse proxy (planned, not yet implemented).

## 2. Invariants (must never regress)

1. **No secrets in the repository.** No `.env`, cookies, tokens, VLESS
   UUIDs, vault keys, session files, or storage-state JSON may ever be
   committed. `.gitignore` blocks them; CI secret-scan is the hard gate.
2. **No secrets in logs.** All logging passes through the redaction module
   (`packages/shared/src/redaction.ts`, tested).
3. **No secrets in images.** `Dockerfile`/compose must never embed
   credentials; the vault key is a host file (0600) or env-provided.
4. **Loopback-only by default.** Binding to any non-loopback address is an
   explicit, documented, reviewed decision and requires an auth-capable
   reverse proxy in front.
5. **Uploads are validated.** Extension whitelist, size limit, non-empty
   check; stored under a **server-generated safe name** — user-supplied
   filenames are never used as paths (no path traversal).
6. **URL-based operations are SSRF-guarded**
   (`packages/shared/src/ssrf.ts`, tested; allowlist-driven health targets).
7. **Sessions and vault are private.** Session files `0700`; vault records
   are AES-256-GCM encrypted with a 0600 key.
8. **"Internal" is not "authorized".** Internal-network visibility never
   substitutes for access control.

## 3. Reporting a vulnerability

1. **Do not** open a public issue.
2. Contact the maintainer directly (repository owner: `saber13812002`) with a
   private description and reproduction steps.
3. The maintainer will confirm, fix, and disclose with the reporter's
   consent.

Until a formal disclosure process exists, private contact is the channel.

## 4. What we do NOT protect against (honest scope)

- A compromised host: if the `saber` user / Docker daemon is owned, the
  application-level controls do not save you (host-level hardening is
  separate).
- Live Google credential theft from a **host** browser profile: the worker
  reads session state from disk; host compromise = credential compromise.
- Abuse by the single local user (there is no user system to arbitrate).

These are tracked in the threat model as accepted risks or future work.
