# Phase C — Server Endpoint Migration: Centralized Config (Approved Scope)

**Date:** 2026-11-01 (UTC) · **Addendum phase:** C · **Approval:** user-approved
scope = config only (`NLO_INTERNAL_API_BASE_URL` in `config.ts` + `.env.example`),
stop again before Phase D.

---

## 1. Executive summary

Added the new env var **`NLO_INTERNAL_API_BASE_URL`** (default
`http://172.30.0.133:4000`) to the centralized config, documented explicitly as
the **internal LLM proxy (LiteLLM, OpenAI-compatible)** — not the NLO web
address, SSH host, or reverse proxy. Validation is fail-fast (http/https scheme
required, trailing slashes normalized). 5 unit tests added; full regression
green (169/169); typecheck/lint/format/build clean for changed files. **No
runtime consumer yet** (prompt-engine phase, roadmap Phase 9) and **no requests
are made** by this change. **No push performed** — local commit only (push is an
externally visible action requiring separate approval).

## 2. Initial state

- Local `main` @ `bc2392026fb41760ab71291f101b8f3caf27ad41`, in sync with
  `origin/main` (0/0 after fetch) — clean tracked tree (untracked scratch:
  `$out`, `HTTP`, `tmp/` — left alone).
- Dev server 4871 running (PID 27528); stale 4870 (PID 8380) untouched.
- Phase A+B reports committed to working tree (untracked at phase start).

## 3. Implementation (goal + scope: centralized config for the new internal API)

| File                                                                                                                                                                                               | Change                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/config.ts`](../../apps/server/src/config.ts)                                                                                                                                     | `AppConfig.internalApiBaseUrl: string` (documented as the internal LLM proxy base URL); parsed in `loadConfig` from `NLO_INTERNAL_API_BASE_URL`, default `http://172.30.0.133:4000`, trimmed + trailing-slash-stripped, validated `/^https?:\/\/[^\s/]+$/` → throws `invalid NLO_INTERNAL_API_BASE_URL` otherwise |
| [`apps/server/test/config-internal-api.test.ts`](../../apps/server/test/config-internal-api.test.ts)                                                                                               | **new** — 5 unit tests: default value, explicit override + trailing-slash normalization, https acceptance, missing-scheme rejection, non-http(s) scheme (`file://`) rejection; ambient-env-safe (saves/restores `process.env` var)                                                                                |
| [`.env.example`](../../.env.example)                                                                                                                                                               | new commented section: `# NLO_INTERNAL_API_BASE_URL=http://172.30.0.133:4000` with explicit "LLM proxy, NOT NLO web/SSH/proxy" note and key-handling warning (never in repo)                                                                                                                                      |
| [`README.md`](../../README.md)                                                                                                                                                                     | env-var table row for `NLO_INTERNAL_API_BASE_URL` (default + role, Persian, matching table language)                                                                                                                                                                                                              |
| [`CHANGELOG.md`](../../CHANGELOG.md)                                                                                                                                                               | new `[2026-11-01]` entry (Added + Notes: no consumer yet, evidence links)                                                                                                                                                                                                                                         |
| [`docs/ROADMAP_MASTER.md`](../ROADMAP_MASTER.md), [`SERVER_ENDPOINT_MIGRATION_AUDIT.md`](SERVER_ENDPOINT_MIGRATION_AUDIT.md), [`SERVER_ENDPOINT_CONNECTIVITY.md`](SERVER_ENDPOINT_CONNECTIVITY.md) | from Phase A/B (prettier-formatted); included in the same commit for phase coherence                                                                                                                                                                                                                              |

**Deliberately NOT changed (per approved scope):** no source consumer of
`internalApiBaseUrl` yet; no `.env` (real) edit; no deploy/Docker/CI changes;
no docs/wiki host-identity rewrites (that is Phase D); no production or
proxy change. All `4870` app-own-port references untouched.

## 4. Git

- 1 local commit on `main` (message: `feat(config): NLO_INTERNAL_API_BASE_URL for internal LLM proxy (endpoint-migration addendum Phase C) + Phase A/B reports`) — SHA recorded at commit time.
- **Push: NOT performed** (externally visible; requires explicit approval).
- `origin` unchanged: `https://github.com/saber13812002/notebooklm-orchestrator.git`.

## 5. Tests (level: **Unit** — config parsing only; no network, no live)

- `npm test` — **all workspaces green: shared 44, server 100 (incl. 5 new
  `config-internal-api.test.ts`), web 25 → 169/169 pass.**
- `npm run typecheck` — clean (3 workspaces).
- `npm run lint` — clean for all tracked files. Pre-existing errors remain in
  untracked scratch `tmp/n1-auth-probe.mjs` (6 × `no-empty`) — not part of this
  phase; recommend ignoring/removing scratch in a hygiene commit (needs approval
  since `tmp/` is untracked).
- `npm run format:check` — clean for all files touched by this phase
  (scratch `tmp/*` excluded from scope, untracked).
- `npm run build` — success (web bundle built).

## 6. Live verification

**Not performed and not applicable** — config-only change with no runtime
consumer; no network calls added. (Phase E will add endpoint integration tests
using the unauthenticated monitors `/health/liveliness` + `/health/readiness`,
and `/v1/models` once a key is provided via secret store.)

## 7. Security

- No secrets added anywhere; the LLM key is **not** part of this config (by
  design — key stays in env/vault, never repo/chat/logs).
- URL validation rejects `file://` and schemeless values (defense against
  accidental path injection into future HTTP clients).
- `.git` review of staged files: no runtime/secret files staged.

## 8. Deployment

**No deployment** (local commit only; production migration is Phase G behind
its own hard approval gate). The running 4871 dev instance predates the change
(additive field only — restart not required for correctness; will pick it up on
next start).

## 9. Data safety

No DB, `data/`, session, or vault interaction. Test suites use temp dirs only.

## 10. Known limitations

- `internalApiBaseUrl` has **no consumer yet** — it is configuration plumbing
  for roadmap Phase 9 (prompt engine). No OpenAPI change (no route change).
- The default points at `http://172.30.0.133:4000` (internal network only).
  Hosts without that route must set the env var; there is no fallback/feature
  detection by design (explicit config).

## 11. Blockers / required accesses (carried to D/E/G)

1. LLM API key for Phase E model listing — via env/vault only.
2. SSH/console access to `172.30.0.133` for Phase G preflight.
3. Decision: NLO deployment on the new host (Phase D wording depends on it).
4. Approval to **push** this commit (and the A/B reports) to `origin/main`.

## 12. Rollback

`git revert <commit>` (single commit, additive only) — no DB migration, no
runtime dependency; reverting removes the field with zero side effects.

## 13. Next phase proposal (Phase D — documentation migration)

Rewrite the ① change-list items (server-identity text only): `AGENTS.md`,
`README.md` deploy section, `docs/operations/README.md`,
`docs/deployment/s52-deploy.md` (+ rename decision), wiki 13/14, `deploy.sh`
comment, `nlo.service` comment, `CONTRIBUTING.md`; phrased honestly: "new host
`172.30.0.133`; NLO service deployment pending (Phase G); GitLab/Wiki.js
already re-homed; LiteLLM is the internal LLM API (not NLO)." Historical ② and
other-service ③ items untouched.

## 14. Approval request

**STOP.** Phase C (approved scope) is complete and tested locally. Awaiting
explicit approval for: (a) **push** of the local commit to `origin/main`, and
(b) **Phase D** (documentation migration).
