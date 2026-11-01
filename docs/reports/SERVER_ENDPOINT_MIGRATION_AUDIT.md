# Phase A — Server Endpoint Migration Audit (Read-Only)

**Date:** 2026-11-01 (UTC) · **Author:** automated (read-only) · **Addendum phase:** A
**Scope:** every reference in the repository to the legacy server s52 (`172.20.1.52`),
`52:4870`, `172.20.1.52:4870`, service name `nlo`, and the domain family
(`nlo.ai.ismc.ir`, `git.ai.ismc.ir`, `docs.ai.ismc.ir`, edge `80.191.92.189`),
classified for the migration to the new internal host `172.30.0.133`
(new API endpoint `http://172.30.0.133:4000/v1` — see Phase B for identity).

**Method:** 7 workspace-wide regex searches + targeted re-reads; every line cited below
was observed in this session. **No file, config, source, service, or proxy was changed.**

---

## 1. Executive summary

1. **The new host is not referenced anywhere yet** — `172\.30` returns **0 hits** in the
   whole repo. Phase C is therefore a pure _addition_ (new env var + doc edits), not a
   rewrite of an existing hardcoded value.
2. **~40 current operational references** to s52/4870 exist in governance docs,
   deployment docs, wiki pages, deploy scripts, Docker files, and code defaults.
   These form the **change list** for Phases C/D.
3. **All `docs/reports/*.md` + `CHANGELOG.md` + scratch scripts are historical
   records** — they must stay verbatim (they document what happened on s52 at the
   time it was written).
4. **`git.ai.ismc.ir` (GitLab) and `docs.ai.ismc.ir` (Wiki.js) references describe
   other services.** Phase B now proves these services were re-homed to
   `172.30.0.133` (DNS already moved) — their _service identities are unchanged_;
   only the host they live on changed. They must **not** be rewritten to
   `172.30.0.133:4000/v1` (that is a LiteLLM API, not GitLab/Wiki).
5. **Key discovery (Phase B, cross-referenced here):** `nlo.ai.ismc.ir` now resolves
   to `172.30.0.133`, the old host `172.20.1.52` is unreachable (timeouts), and
   **NLO is NOT yet running on the new host** (`:4870` refused). The endpoint
   `172.30.0.133:4000` is **LiteLLM v1.101.0** (OpenAI-format LLM proxy) — a new
   internal LLM API, not the NLO web address.

## 2. Initial state (read-only capture, 2026-11-01T20:06–20:07Z)

| Item                                      | Value                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Local branch / HEAD                       | `main` @ `bc2392026fb41760ab71291f101b8f3caf27ad41`                                   |
| Untracked (untouched)                     | `$out`, `HTTP`, `tmp/`                                                                |
| Remote `origin`                           | `https://github.com/saber13812002/notebooklm-orchestrator.git`                        |
| Port 4870                                 | PID 8380 — stale pre-Phase-C local instance (kept; `/api/health` 200)                 |
| Port 4871                                 | PID 23320 — current dev server (crashed at ~20:07Z; restarted §6)                     |
| Port 14870 (s52 SSH tunnel)               | **no listener** — tunnel to s52 no longer exists (s52 unreachable)                    |
| Old host `172.20.1.52` (:4870 / :81)      | **timeout** (6 s) from this workstation — old host is down/moved                      |
| New host `172.30.0.133` (:4000/:81/:8888) | reachable — see `SERVER_ENDPOINT_CONNECTIVITY.md`                                     |
| DNS `nlo.ai.ismc.ir`                      | **→ 172.30.0.133** (was 172.20.1.52 per Phase 0; was 80.191.92.189 per PHASE_A_AUDIT) |
| DNS `git.ai.ismc.ir` / `docs.ai.ismc.ir`  | → 172.30.0.133 (both; GitLab/Wiki.js re-homed with the host)                          |

## 3. Classification

Legend — **① CHANGE** (current operational fact about the NLO service host that is now
stale; update in Phase C/D), **② KEEP** (historical record), **③ DO-NOT-CHANGE**
(other service / app-own port / noise).

### 3.1 ① CHANGE — current operational references (stale after migration)

| File                                                                                                                                               | Line(s)                                | What it says                                                                                                    | Role                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`AGENTS.md`](../../AGENTS.md)                                                                                                                     | 7–8, 16                                | "operational service on `172.20.1.52` (service `nlo`, port `4870`)"; "GitLab (internal, on s52)"                | standing governance rule naming the production host                                          |
| [`README.md`](../../README.md)                                                                                                                     | 6, 129–142, 187–194                    | production on s52 `172.20.1.52` port 4870; deploy section; status table                                         | developer entry point                                                                        |
| [`docs/operations/README.md`](../operations/README.md)                                                                                             | 3–4, 9, 33                             | "production service runs on **s52** (`172.20.1.52`) … port 4870"; s52 Node path                                 | day-2 operations                                                                             |
| [`docs/deployment/s52-deploy.md`](../deployment/s52-deploy.md)                                                                                     | 3–4, 24, 63, 85–87, 95                 | target server s52 `172.20.1.52`; "deploy (on s52)"; host setup; `ssh -N -L 4870:… s52`                          | deploy runbook (filename itself contains `s52`)                                              |
| [`docs/wiki/14-deployment-operations.md`](../wiki/14-deployment-operations.md)                                                                     | 3, 13, 21, 61, 92                      | Persian ops page: server s52 `172.20.1.52`, tunnel command                                                      | customer wiki                                                                                |
| [`docs/wiki/13-developer-guide.md`](../wiki/13-developer-guide.md)                                                                                 | 18, 104, 121                           | "اسکریپت استقرار s52"; deploy only on s52; loopback of s52                                                      | customer wiki                                                                                |
| [`docs/development/quick-start.md`](../development/quick-start.md)                                                                                 | (s52/4870 mentions)                    | local dev quick start referencing s52 deploy                                                                    | dev docs                                                                                     |
| [`deploy/deploy.sh`](../../deploy/deploy.sh)                                                                                                       | 3, 31–33, 85                           | "run on the server, e.g. s52"; `PORT="${NLO_PORT:-4870}"` (port default is app-own — keep); target URL loopback | deploy script — server-name text stale; script logic host-agnostic                           |
| [`deploy/systemd/nlo.service`](../../deploy/systemd/nlo.service)                                                                                   | 1                                      | comment "s52 deployment"                                                                                        | systemd unit (port/host come from env — keep values)                                         |
| [`Dockerfile`](../../Dockerfile)                                                                                                                   | 2–3, 22–23, 58, 61                     | comment naming s52 context; `NLO_PORT=4870` ENV, `EXPOSE 4870`, healthcheck on 4870                             | **4870 = app-own container port → keep**; comment text stale                                 |
| [`docker-compose.yml`](../../docker-compose.yml)                                                                                                   | 4, 20–23, 36–37                        | comment; `"127.0.0.1:${NLO_PORT:-4870}:4870"`                                                                   | app-own port mapping → **keep**                                                              |
| [`.env.example`](../../.env.example)                                                                                                               | 11                                     | `NLO_PORT=4870`                                                                                                 | app-own port → **keep value**; Phase C adds `NLO_INTERNAL_API_BASE_URL`                      |
| [`apps/server/src/config.ts`](../../apps/server/src/config.ts)                                                                                     | 142                                    | `intEnv(env, "NLO_PORT", 4870)`                                                                                 | single source of app port default → **keep**; Phase C adds new env var here                  |
| [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)                                                                                         | 8                                      | `NLO_DEV_BACKEND ?? "http://127.0.0.1:4870"`                                                                    | local dev backend default (loopback) → **keep** (it is this machine, not s52)                |
| [`apps/server/scripts/e2e-live.ts`](../../apps/server/scripts/e2e-live.ts)                                                                         | 50                                     | default base `http://127.0.0.1:4870`                                                                            | loopback default → keep; add note                                                            |
| [`apps/server/scripts/_add-nodes.py`](../../apps/server/scripts/_add-nodes.py), [`_recheck-nodes.py`](../../apps/server/scripts/_recheck-nodes.py) | 11                                     | `BASE = "http://127.0.0.1:4870"`                                                                                | loopback scratch defaults → keep                                                             |
| [`docs/api/README.md`](../api/README.md)                                                                                                           | 296–298 + base-URL examples            | "OpenAPI/Swagger live on s52"; `127.0.0.1:4870` examples                                                        | API doc — s52 mention historical-flavored but in live doc → annotate; loopback examples keep |
| [`docs/api/examples/client.ts`](../api/examples/client.ts)                                                                                         | 8, 14                                  | `BASE_URL … ?? "http://127.0.0.1:4870"`                                                                         | loopback default → keep                                                                      |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md)                                                                                                         | 4, 54–55                               | s52/4870 mentions                                                                                               | contribution guide — text update                                                             |
| [`.gitlab-ci.yml`](../../.gitlab-ci.yml)                                                                                                           | 50–54                                  | docker smoke binds `127.0.0.1:4870`                                                                             | CI-local port → **keep**                                                                     |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)                                                                                       | 77–81                                  | docker smoke binds `127.0.0.1:4870`                                                                             | CI-local port → **keep**                                                                     |
| wiki `02/03/05/06/07/09`                                                                                                                           | various `127.0.0.1:4870` curl examples | loopback examples                                                                                               | **keep** (local usage) — add new-host context in 02/09 if desired                            |

**Summary:** the _server identity_ text (s52 / `172.20.1.52` as "the production
server") is what becomes stale. The `4870` number is overwhelmingly the **app's own
port** (config default, container, CI smoke, loopback examples) and stays.

### 3.2 ② KEEP — historical records (verbatim)

| File                                                                                                                                                                                                          | Why keep                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md`](P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md)                                                                                                                 | point-in-time audit of s52 reconciliation                                  |
| [`docs/reports/PHASE_0_RECONCILIATION.md`](PHASE_0_RECONCILIATION.md)                                                                                                                                         | records s52 state at `b5e9ad3`, old DNS                                    |
| [`docs/reports/PHASE_A_AUDIT.md`](PHASE_A_AUDIT.md)                                                                                                                                                           | records GitLab/Wiki on s52, old DNS table                                  |
| [`docs/reports/PHASE_B_ENGINEERING_GOVERNANCE.md`](PHASE_B_ENGINEERING_GOVERNANCE.md)                                                                                                                         | governance baseline                                                        |
| [`docs/reports/PHASE_1_GITHUB_PUBLICATION.md`](PHASE_1_GITHUB_PUBLICATION.md) / [`PHASE_1_LOCAL_SWAGGER.md`](PHASE_1_LOCAL_SWAGGER.md)                                                                        | publication + local swagger evidence                                       |
| [`docs/reports/PHASE_2_API_AUTHENTICATION.md`](PHASE_2_API_AUTHENTICATION.md) / [`PHASE_C_API_PRODUCTIZATION.md`](PHASE_C_API_PRODUCTIZATION.md) / [`PHASE_C_LIVE_ACCEPTANCE.md`](PHASE_C_LIVE_ACCEPTANCE.md) | auth + v1 + live acceptance on s52                                         |
| [`docs/reports/SWAGGER_ACCESSIBILITY_AND_DEPLOYMENT.md`](SWAGGER_ACCESSIBILITY_AND_DEPLOYMENT.md)                                                                                                             | documents why `172.20.1.52:4870` never worked remotely (loopback bind)     |
| [`CHANGELOG.md`](../../CHANGELOG.md)                                                                                                                                                                          | release history                                                            |
| `tmp/n0-staged-review.txt`, `tmp/p2-diff-review.txt`, `tmp/n2-preflight.sh`, `tmp/nlo-*.sh/.ps1`, `tmp/dev4871-repro.log`                                                                                     | scratch evidence artifacts (gitignored `tmp/`)                             |
| `data/tmp/s52-*.sh`, `p2-*.sh`, `p3-*.sh`                                                                                                                                                                     | probe scripts (gitignored `data/`)                                         |
| `.git/logs/*`                                                                                                                                                                                                 | git reflog (not text-searchable content)                                   |
| [`apps/server/src/providers/python-worker/nbl_worker.py`](../../apps/server/src/providers/python-worker/nbl_worker.py) line 516                                                                               | code _comment_ recording a live observation on s52 — historical note, keep |

### 3.3 ③ DO-NOT-CHANGE — other services / not this migration

| Reference                                   | Where (representative)                                                                                                             | Reason                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ai.ismc.ir` (GitLab CE)                | [`docs/operations/gitlab-sync.md`](../operations/gitlab-sync.md) 14, 29–36, 50, 96–97, 118–120; `AGENTS.md` 38; `.gitlab-ci.yml` 1 | **different service**. Phase B proves it is still GitLab, now hosted on `172.30.0.133` (DNS already moved; `:81` → sign-in 302). Identity/URL unchanged; only hosting host changed. Never rewrite to `:4000/v1`. |
| `docs.ai.ismc.ir` (Wiki.js 2.5.307)         | [`docs/wiki/README.md`](../wiki/README.md) 4; reports                                                                              | **different service**. Now on `172.30.0.133` (`:8888` → 200; DNS already moved). URL unchanged.                                                                                                                  |
| Edge `80.191.92.189`                        | reports only                                                                                                                       | shared nginx/Kong edge; `docs.ai.ismc.ir` used to resolve here — DNS now points at new host. Historical in reports; nothing in live docs references it as the NLO path.                                          |
| `jump53` / `172.20.1.53`                    | reports only                                                                                                                       | alternate server, historical context.                                                                                                                                                                            |
| `node_modules/**`, `package-lock.json` hits | —                                                                                                                                  | tooling noise (`errorCodes52`, `import_fs52`, …).                                                                                                                                                                |
| CI docker-smoke `127.0.0.1:4870`            | `.gitlab-ci.yml` 50–54, `.github/workflows/ci.yml` 77–81                                                                           | the **app's own port in a container**, not a server address.                                                                                                                                                     |

## 4. The new endpoint (cross-reference)

`172.30.0.133:4000` is **LiteLLM v1.101.0** (OpenAI-format LLM proxy; 618 OpenAPI
paths; Bearer auth; admin UI at `/ui`) — **not NLO, not its web address, not SSH,
not GitLab, not the reverse proxy**. Full evidence:
[`SERVER_ENDPOINT_CONNECTIVITY.md`](SERVER_ENDPOINT_CONNECTIVITY.md).

Consequences for this audit:

- The addendum's suggested env var `NLO_INTERNAL_API_BASE_URL` is **appropriate in
  name** (it _is_ an internal API) but must be documented as **the LLM proxy base
  URL** (`http://172.30.0.133:4000`, OpenAI-compatible), to be consumed by the
  prompt-engine phase — **not** as "the NLO server address".
- The _NLO service itself_ has **not** been re-deployed to the new host yet
  (`172.30.0.133:4870` refused). All ① items above become fully actionable only
  after Phase G (production migration). Until then, Phase D edits must be phrased
  as "new host, NLO pending deployment" to stay honest.
- `nlo.ai.ismc.ir` already points at the new host, but **no NLO vhost exists there**
  (`/api/health` → 404 "مورد مورد نظر یافت نشد" from the host's default vhost).
  Phase 3 (domain/HTTPS) work is still open, now against the **new** host.

## 5. Open questions / required accesses (for user decision)

1. **Is NLO going to be deployed on `172.30.0.133`** (systemd `nlo`, port 4870), or
   does the new host run NLO differently (different port/user)? → needed before
   Phase D wording and Phase G.
2. **LiteLLM API key**: to list models / validate an OpenAI-compatible call in
   Phase E, a key is required. **Provide via secret store / env file only — never
   in chat or repo** (per AGENTS.md §2/§7).
3. **SSH/console access to `172.30.0.133`** (user, host) — needed for Phase G
   preflight (equivalent of `tmp/n2-preflight.sh`).
4. **GitLab/Wiki.js** — confirm no further migration expected (their URLs are
   unchanged; only host IP changed) → if confirmed, their docs need at most a
   footnote, no rewrite.
5. **Old host `172.20.1.52`** — confirm it is decommissioned (all probes timed out);
   the stale local SSH tunnel concept (14870) is dead — remove that guidance in
   Phase D.

## 6. Side observation — local dev server crash (noted, not fixed)

During Phase B probing, the long-running 4871 dev instance (PID 23320) **crashed**
mid-`/api/health/ready` (curl 56 "Connection was reset", then process gone). A fresh
instance (PID 27528, same `NLO_PORT=4871`) is **stable**: `/api/health` 200 and
`/api/health/ready` 200 ×3 (provider `python-worker` `configured:true, issues:[]`,
proxyRuntime `{state:"available", name:"xray"}`), worker spawn/close cycles clean
(`tmp/dev4871-repro.log`). No `uncaughtException` handler exists
([`apps/server/src/main.ts`](../../apps/server/src/main.ts:84)), so an uncaught
exception would kill the process silently — **recommended hardening** (add a
logging `uncaughtException` handler + structured crash log) to be filed as a
follow-up, out of scope for A/B (no source changes allowed here).

## 7. Safety statement

- No source file, config, `.env`, deploy script, Docker file, CI file, production
  service, DNS, or reverse proxy was modified in this phase.
- All probes were GET/HEAD or method-not-allowed POSTs; **no mutating calls** were
  sent to the new endpoint; no tokens were requested, received, or printed.
- Local repo state unchanged: `main` @ `bc23920`, untracked `$out`, `HTTP`, `tmp/`.
- 4871 dev server restored (new instance) per user instruction to keep it running.

**Status:** Phase A **Complete — STOP, awaiting user approval for Phase C**
(Phase B completed as part of the same stop gate).
