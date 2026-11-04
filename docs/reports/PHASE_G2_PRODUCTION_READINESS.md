# Phase G2 — Production Readiness Audit (read-only)

**Date:** 2026-11-02 (UTC) · **Author:** automated (read-only) · **Addendum phase:** G2
**Baseline:** local `main` = `origin/main` = `0e5b8b8` (clean tree)
**Authorization boundary honored:** READ-ONLY. No SSH login attempted
(TCP banner read only), no production change, no `.env` change, no restart,
no deploy, no DNS/proxy/TLS change.

## 1. Mission

Audit production-readiness for the NLO re-deployment on the new host
`172.30.0.133`: host identity and access method, runtime prerequisites,
systemd/deploy paths, backups/rollback, worker+xray dependencies, network
access to the internal API endpoint, configuration compatibility, and
documentation consistency. **Do not assume the API endpoint is the SSH host;
do not guess credentials or paths** — where a fact is missing, it is listed
as a required input, not inferred.

## 2. Host identity — what is established, what is not

| Fact                                                  | State                                                                                                                                                                                          | Evidence                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `172.30.0.133:4000` = LiteLLM v1.101.0 (LLM proxy)    | **VERIFIED (live, this run)**                                                                                                                                                                  | `G1` report §3.2                                                                                                                                         |
| Same host runs GitLab (`:81`) and Wiki.js (`:8888`)   | established 2026-11-01                                                                                                                                                                         | `SERVER_ENDPOINT_CONNECTIVITY.md` (Phase B)                                                                                                              |
| `nlo.ai.ismc.ir` → `172.30.0.133` (A, TTL 600)        | **VERIFIED (this run)**                                                                                                                                                                        | `Resolve-DnsName`                                                                                                                                        |
| NLO **not** yet on new host (`:4870`)                 | **VERIFIED (this run)**                                                                                                                                                                        | TCP `:4870` refused (2193 ms)                                                                                                                            |
| SSH port 22 on new host open                          | **VERIFIED (this run)**                                                                                                                                                                        | TCP 22: `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20` (15 ms)                                                                                              |
| SSH **login** (user/key/password) to new host         | **NOT available** — no local ssh config entry, no `known_hosts` entry, no credentials                                                                                                          | local `~/.ssh/config` audit (only `jump53`, `s52`); `known_hosts` hosts: `172.20.1.52/53`, `172.22.6.21`, `172.22.188.80`, `git.ai.ismc.ir`, `127.0.0.1` |
| New host OS                                           | inferred **Ubuntu** (OpenSSH banner `Ubuntu-3ubuntu13.20`) — banner only, not a login fact                                                                                                     | G2 probe                                                                                                                                                 |
| Is the SSH host the same machine as the API endpoint? | **Likely the same host (172.30.0.133) — not assumed, only observed** that LiteLLM, GitLab, Wiki.js, DNS and SSH all share this IP. NLO deployment would therefore sit alongside LiteLLM on it. | G1+G2 probes + Phase B                                                                                                                                   |

### 2.1 Missing access facts — precisely required (G3 inputs)

1. **SSH user** for `172.30.0.133` (s52 used `saber` — **not assumed** here).
2. **Credential material**: key pair authorized for that user (public key
   placement on the host) or password via secure channel. Nothing requested
   in chat; provide through the same secure path used for other host secrets.
3. **Host facts to confirm on first authorized login** (no guesses):
   - project path (s52-era value `/home/saber/saberprojects/notebooklm-orchestrator`
     still referenced by [`deploy/systemd/nlo.service`](../../deploy/systemd/nlo.service)
     `WorkingDirectory`/`ExecStart` and by [`deploy/deploy.sh`](../../deploy/deploy.sh)
     PATH fallback — **both are s52-era and must be re-confirmed, not reused blindly**);
   - Node.js version (s52-era: Node 22 at `~/.local/node22`; Docker/CI pin `node:22`);
   - Python version for the worker venv (s52-era: 3.12.3);
   - whether `git` has GitHub fetch access from the host (s52 did; new host unknown);
   - presence/state of `data/` (DB, vault, sessions, vendor) — if any s52
     `data/` archive survived the host move it must be identified **before**
     first deploy so history/vault continuity is a decision, not an accident.

## 3. Deployment-path audit (repository side — all host-agnostic, verified)

| Item                                      | State                                                                                      | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy script                             | ✅ ready — [`deploy/deploy.sh`](../../deploy/deploy.sh)                                    | git-based, reviewed-commit-only, DB+`.env` backup (retention 5), preflight, post-restart health/ready/port/journal checks, server test run, `ROLLBACK=1` path, `NLO_DEPLOY_DRY_RUN=1` mode. Host-agnostic (SVC/PORT env; repo-relative).                                    |
| systemd unit                              | ✅ tracked, secret-free — [`deploy/systemd/nlo.service`](../../deploy/systemd/nlo.service) | `User=saber`, s52-era paths (re-confirm in G3 per §2.1), `NoNewPrivileges`, `PrivateTmp`, graceful 120 s stop.                                                                                                                                                              |
| Node/Python on new host                   | ❓ unknown                                                                                 | CI + Docker pin Node 22; worker needs a venv (deploy.sh syncs it when `python-requirements.txt` changes).                                                                                                                                                                   |
| Xray vendor                               | ❓ unknown on new host                                                                     | deploy.sh warns if `data/vendor/xray` missing; install per `docs/deployment/s52-deploy.md` §vendor.                                                                                                                                                                         |
| Python worker venv                        | ❓ unknown on new host                                                                     | `worker:setup` / deploy.sh venv sync; s52-era venv 3.12.3.                                                                                                                                                                                                                  |
| Database                                  | `data/nlo.sqlite` convention                                                               | new-host DB = fresh unless an s52 `data/` archive is restored (decision needed — §2.1).                                                                                                                                                                                     |
| Env config on new host                    | ❓ not present (no NLO on new host)                                                        | first deploy must create `.env` (0600) from `.env.example` + host facts; `NLO_INTERNAL_API_BASE_URL` may be omitted (default = the live-verified endpoint) or set explicitly.                                                                                               |
| Backups                                   | none exist yet on new host                                                                 | first deploy creates them automatically (DB + `.env`); retention 5.                                                                                                                                                                                                         |
| Rollback                                  | procedure ready, **nothing to roll back to yet**                                           | first deploy's previous-good = "service absent"; `deployed-commit` marker written on success; DB restore from `data/backups/`.                                                                                                                                              |
| Network access new-host → LiteLLM         | ✅ **expected excellent**                                                                  | LiteLLM is **on the same host** (172.30.0.133) → from the NLO process `http://127.0.0.1:4000` would be loopback (zero LAN exposure). The current default `http://172.30.0.133:4000` also works (G1 proved LAN reachability). **Optimization for G3 only — no change made.** |
| Network access new-host → GitHub/registry | ❓ unknown                                                                                 | needed by deploy.sh (`git fetch`) and `npm ci`; s52 had it.                                                                                                                                                                                                                 |

## 4. Configuration compatibility sweep

| Surface                                                                             | `NLO_INTERNAL_API_BASE_URL` handling                                                                                                                                                                                                                                               | Verdict                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`apps/server/src/config.ts:147`](../../apps/server/src/config.ts)                  | default `http://172.30.0.133:4000`; trim + trailing-slash normalize; http/https-only regex; fail-fast                                                                                                                                                                              | ✅ correct — default **is** the live-verified endpoint (G1 §3) |
| [`apps/server/src/internal-llm.ts`](../../apps/server/src/internal-llm.ts)          | only `/v1/...` paths; Bearer only when key provided; 15 s default timeout; error text never contains the key                                                                                                                                                                       | ✅ compatible with live behavior (G1 §5)                       |
| [`.env.example:68-74`](../../.env.example)                                          | documented with the "LLM proxy, not the web/SSH host" distinction + key rule                                                                                                                                                                                                       | ✅ consistent                                                  |
| Local `.env`                                                                        | variable **absent** → default used                                                                                                                                                                                                                                                 | ✅ (values never logged; names only audited)                   |
| [`docker-compose.yml`](../../docker-compose.yml) / [`Dockerfile`](../../Dockerfile) | **not forwarded** in compose `environment:`; `.env` is docker-ignored so the container runs the baked default. Correct **today** (default = live address); an explicit override for containerized runs would need an `environment:` addition — deferred, no change authorized here | ⚠️ gap noted (G3/ops decision)                                 |
| CI (`.github/`, [`.gitlab-ci.yml`](../../.gitlab-ci.yml))                           | no references — CI never calls the real endpoint                                                                                                                                                                                                                                   | ✅ by design (Phase E rule)                                    |
| Provider initialization ([`app-context.ts`](../../apps/server/src/app-context.ts))  | client **not yet wired** into any route (standalone module, Phase E scope) — zero runtime behavior change today                                                                                                                                                                    | ✅ intentional; wiring is a later product phase                |

**No configuration change was made.**

## 5. Documentation review (consistency of `172.30.0.133:4000/v1`)

- [`AGENTS.md`](../../AGENTS.md), [`README.md`](../../README.md),
  [`docs/operations/README.md`](../../docs/operations/README.md),
  [`docs/deployment/s52-deploy.md`](../../docs/deployment/s52-deploy.md),
  wiki 13/14: host identity migrated in Phase D; status sentences honest
  ("NLO not yet on new host — Phase G"). No edit needed this phase.
- [`docs/ROADMAP_MASTER.md`](../../docs/ROADMAP_MASTER.md) addendum: the
  endpoint is correctly described as the LiteLLM v1 API endpoint (not web/SSH
  address). **G1+G2 states to be recorded in H/final audit.**
- `docs/reports/*` + `CHANGELOG.md`: old addresses preserved verbatim
  (historical rule) — verified by search: every remaining `172.20.1.52`/`s52`
  mention is a historical/status reference; every `172.30.0.133` mention
  carries the correct "internal LLM proxy / new host" framing.
- One stale-text note (pre-existing, not fixed — needs G3 approval to edit):
  `docs/operations/gitlab-sync.md` still describes the GitLab container as
  "on s52" (GitLab-side fact; re-homed to the new host per Phase B evidence).

## 6. Tests (run this phase, from `0e5b8b8` tree)

| Suite                           | Result                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm test` (all workspaces)     | **175/175 PASS** — shared 44, server 106 (incl. `config-internal-api.test.ts` 5, `internal-llm.test.ts` 6), web 25 |
| Config unit tests               | ✅ default/override/normalization/fail-fast — **Unit level, no network**                                           |
| API client tests (internal-llm) | ✅ in-process mock HTTP — **Integration level, NOT live**                                                          |
| Live read-only connectivity     | ✅ **G1 probes** (separate from the suite, by design — the suite never touches the real endpoint)                  |

**Mock vs Live honesty:** Unit/Integration/E2E-mock = **passed**. Live
endpoint verification = **G1: TCP + unauthenticated HTTP + service ID
passed; authenticated `/v1/models` = NOT verified (key pending)**.

## 7. Rollback readiness & outstanding risks

**Rollback readiness:** procedure is complete and dry-run-capable
(`NLO_DEPLOY_DRY_RUN=1`), but on the new host the first deployment has no
previous-good commit — "rollback" means redeploying the previous commit per
`deploy.sh`, with DB restore from `data/backups/` if the first deploy wrote
state. **First deploy should therefore be a deliberate, backed-up event (G3).**

| Risk                                                         | Severity      | Mitigation                                                                                                 |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------- |
| SSH login to new host not yet available (no user/credential) | **blocks G3** | §2.1 provision list; nothing guessed                                                                       |
| s52-era paths in `nlo.service`/deploy.sh PATH fallback       | medium        | re-confirm on first authorized login; unit is host-agnostic otherwise                                      |
| `data/` continuity across the host move unknown              | medium        | identify any surviving s52 `data/` archive **before** first deploy (vault/sessions/DB history)             |
| LLM key absent → authenticated path unproven (G1 R2)         | medium        | secure provisioning (G1 §4); blocks "real LiteLLM" claim only                                              |
| Plain HTTP for LLM calls on LAN (G1 R3)                      | low-medium    | loopback base URL from same-host deploy (G3) reduces exposure; TLS decision with the domain/TLS workstream |
| Docker/compose does not forward the new env var              | low           | documented gap; default is correct today                                                                   |

## 8. Recommended next action (awaiting explicit approval)

1. Provision SSH access for `172.30.0.133` (§2.1) + LLM key (G1 §4) via
   secure channels.
2. G3 plan: authorized-login confirmation of host facts (§2.1) →
   `NLO_DEPLOY_DRY_RUN=1` → first deploy of `0e5b8b8` (or then-HEAD) via
   `deploy.sh` → health/ready/worker/xray verification → authenticated
   `/v1/models` smoke via the client. Each step behind its own approval.

## 9. Mandatory STOP

G2 is complete. **No SSH login was attempted, no production system was
touched, no `.env` was modified, nothing was deployed or restarted.**
Evidence presented; awaiting explicit approval before Phase G3.
