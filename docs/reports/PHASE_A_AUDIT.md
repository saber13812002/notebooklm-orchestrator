# Phase A — Audit Report (Governance & Productization Mission)

**Date:** 2026-10-27 (UTC) · **Auditor:** automated (read-only)
**Scope:** local repo (Windows dev), GitHub, s52 (`172.20.1.52`), jump53 (`172.20.1.53`), internal GitLab/Wiki.js, network/DNS, test state, API surface.
**Method:** every claim below is backed by a command output or file read executed on 2026-10-27. Nothing is assumed.

---

## 1. Repository state (local / GitHub / s52)

| | Local (Windows) | GitHub `origin/main` | s52 deployed |
|---|---|---|---|
| Branch | `main` | `main` | `main` |
| HEAD | `80a9e667b283f440cf7e69de159b91251b28df15` | `80a9e66…` (`git ls-remote` from s52) | `80a9e667…` |
| Working tree | **clean** (`git status`: "nothing to commit") | n/a | clean tracked; 2 untracked `.bak` files (leftover backups, harmless, git-ignored pattern already excludes them from commits) |
| Remotes | `origin` = `https://github.com/saber13812002/notebooklm-orchestrator.git` | — | same `origin` |

**Evidence:**
- Local: `git status` → clean; `git rev-parse HEAD` → `80a9e667b283f440cf7e69de159b91251b28df15`.
- GitHub: `git ls-remote https://github.com/saber13812002/notebooklm-orchestrator.git` (executed **on s52**, because the Windows workstation cannot reach `github.com:443`) → `HEAD 80a9e66…`, `refs/heads/main 80a9e66…`.
- s52: `git rev-parse HEAD` = same SHA; `data/deployed-commit` = `80a9e66`.

**Conclusion:** the three locations are **in sync**. No server-only or local-only commits exist. The single branch `main` is the only ref on GitHub.

> ⚠️ Network note: the Windows workstation currently **cannot reach github.com:443** (connection timeout). All GitHub checks were proxied through s52, which has direct GitHub access.

**Untracked on s52** (pre-existing, documented in P3 report):
- `apps/server/src/proxy/connect-proxy.ts.bak-curlfix`
- `apps/server/src/queue/job-runner.ts.bak-e2efix`

These are manual backup files; candidates for removal in Phase B (only after confirming content equivalence).

---

## 2. Live service state on s52

| Item | State | Evidence |
|---|---|---|
| systemd unit | `nlo.service` **active** since 2026-10-27 08:43 UTC, enabled at boot | `systemctl status nlo` |
| Port | `127.0.0.1:4870` listening (node pid) | `ss -ltnp` |
| `/api/health` | `{"ok":true,"service":"notebooklm-orchestrator",…}` | curl on s52 |
| `/api/health/ready` | `ready:true`, provider `python-worker` `configured:true, issues:[]`, proxyRuntime `{state:"available", name:"xray"}`, `liveDisabled:true` | curl on s52 |
| Provider | **real** python-worker (not mock) | ready endpoint |
| `liveDisabled` | `true` — because `NLO_LIVE_TESTS` is unset/false in `.env` (gate for live *tests*, per `apps/server/src/config.ts` `liveTestsEnabled: boolEnv("NLO_LIVE_TESTS", false)`) | code + env key list |
| Python worker env | `data/venv/bin/python` → Python 3.12.3 | s52 |
| Xray binary | `data/vendor/xray` present (+ geoip/geosite.dat, LICENSE) | `find data/vendor` |
| DB | `data/nlo.sqlite` (143 KB, active WAL) — jobs, accounts, proxies, sessions all populated (verified via API: 1 SUCCEEDED job with real audio + prompt, 1 ACTIVE account, 1 enabled VLESS node) | curl `/api/jobs`, `/api/accounts`, `/api/proxies` |
| Secrets | `data/vault.key` (0600) + `data/vault/` present | `ls -la data/` |
| Backups | 5 newest DB+env backups retained (per `deploy.sh` retention policy) | `ls data/backups` |
| Env keys on s52 | `NLO_HOST, NLO_PORT, NLO_PROVIDER, NLO_PYTHON_BIN, NLO_PROXY_RUNTIME, NLO_LOGIN_BROWSER, NLO_ALLOW_DIRECT_EGRESS` (values not read/logged) | `cut -d= -f1 .env` |

**Conclusion:** the production service is healthy and running the **real provider** (real NotebookLM + Xray egress, previously verified per P3/P2 evidence). Persistence (DB, vault, sessions, vendor) survives restarts via git-ignored `data/`.

---

## 3. Internal GitLab — EXISTS, reachable

| Item | Finding | Evidence |
|---|---|---|
| Instance | **GitLab CE 16.3.9** running in Docker on **s52** (containers `gitlab`, `gitlab-postgres`, `gitlab-redis`; all healthy, up 6 days) | `docker ps -a` on s52 |
| Internal address | `http://172.20.1.52:81` (HTTP) — sign-in returns **200** | curl on s52 |
| External URL (configured) | `https://git.ai.ismc.ir` (`external_url` in `/etc/gitlab/gitlab.rb`) | `docker exec gitlab grep gitlab.rb` |
| DNS | `git.ai.ismc.ir` → `172.20.1.52` | `getent hosts` on s52 |
| HTTPS external | `https://git.ai.ismc.ir/users/sign_in` → **200** (TLS working) | curl from s52 and jump53 |
| API | `GET /api/v4/version` → **401 Unauthorized** = API is live, **credentials required** (no token found on either host: no `~/.git-credentials`, no `~/.config/glab-cli`, no `GITLAB_*` env vars on s52/jump53) | curl + file checks |
| Git over SSH | port `2222` exposed (container 22→2222) | `docker ps` ports |
| Note | `gitlab.ismc.ir` (185.208.180.203) is a **different** nginx host (404/403, no GitLab) — do not use it | curl probes |

**Gaps:**
1. **No credentials** are available to this agent for the GitLab API (needs a project-level or personal access token, or an admin account).
2. No NLO project exists there yet (unverifiable without credentials — must be checked via API once a token is provided).
3. No `.gitlab-ci.yml` exists in the repository (verified: file absent).

---

## 4. Wiki.js — EXISTS, reachable

| Item | Finding | Evidence |
|---|---|---|
| Instance | **Wiki.js 2.5.307** (`requarks/wiki`) + `wikijs-postgres` on s52, healthy, up 6 days; port `0.0.0.0:8888→3000` | `docker ps -a` on s52 |
| Title (live) | «مستندات هوش مصنوعی» (Persian, RTL) | curl `http://127.0.0.1:8888/` |
| External URL | `docs.ai.ismc.ir` (og:url in site config) → resolves to `80.191.92.189` | HTML meta + `getent hosts` |
| Reachability | `https://docs.ai.ismc.ir/` → **200 from jump53** (also HTTP 301→HTTPS). **Not reachable over HTTPS from s52** (egress to that IP times out from s52) — so API-driven page publishing must run from a host that can reach it (e.g., jump53), or via local `8888` with the container's own API (which needs a local admin login) | curl from both hosts |
| Credentials | **None found** for the Wiki.js REST API (no tokens anywhere on either host). Wiki.js 2.5 API requires a local/remote account with API access (Settings → API). | file/env checks |

**Gaps:** Wiki.js API account/credentials needed; publishing path (jump53 → `docs.ai.ismc.ir`) must be documented.

---

## 5. DNS / reverse-proxy / external access

| Name | Resolves to | Status from s52 | Status from jump53 |
|---|---|---|---|
| `git.ai.ismc.ir` | 172.20.1.52 (s52) | 200 (GitLab sign-in), API 401 | 200 |
| `docs.ai.ismc.ir` | 80.191.92.189 | **timeouts (both 80/443)** | **200 HTTPS**, 301 HTTP |
| `wiki.ismc.ir` | 185.208.180.203 | 302 → `https://wiki.ismc.ir/` (then no TLS response observed) | — |
| `ai.ismc.ir` | 80.191.92.189 | timeouts | (wiki content served via `docs.ai.ismc.ir`) |
| `nlo.ai.ismc.ir` | **80.191.92.189 — DNS A record already exists** | timeouts (nothing yet listening/forwarded there for this host) | — |
| `gitlab.ismc.ir` | 185.208.180.203 | 404/403 from a generic nginx — **not** the GitLab instance | 000 |

**Key findings:**
- `nlo.ai.ismc.ir` **already has a DNS A record** pointing to `80.191.92.189` — the public edge IP (same as `ai.ismc.ir`). There is **no TLS termination / vhost for NLO yet** (no HTTP/HTTPS response). Phase F work = add a reverse-proxy route on the edge (likely the Kong cluster visible on s52: `kong-gw-*` containers + `kong-admin-auth-52`) forwarding to s52 `127.0.0.1:4870`, plus TLS and auth. **No changes made.**
- s52 hosts its own nginx (active) and a Kong gateway cluster (multiple `kong-*` containers). Any new public route must be coordinated with those — per mission rule, no network changes without full review.
- The current service binds **loopback only** on s52 (by design). External exposure will require either: (a) edge proxy → SSH tunnel, or (b) binding on the internal IP behind the edge. Decision belongs to Phase F.

---

## 6. Test & quality state (executed 2026-10-27)

| Suite | Result | Evidence |
|---|---|---|
| `apps/server` (vitest) | **59/59 passed** (5 files: accounts.repo, session-gate, fail-closed, job-lifecycle, api) | `npm test` on Windows, 11.3 s |
| `apps/web` (vitest) | **25/25 passed** (3 files: jalali, api client, utils) | same run, 21.7 s |
| `packages/shared` (vitest) | **44/44 passed** (6 files: redaction, ssrf, retry, safe-name, vless-uri, job-state) | `npx vitest run --root packages/shared` |
| Typecheck / lint / format | configured via `npm run typecheck` / `lint` / `format:check` (not re-run this session; scripts exist in root `package.json`) | `package.json` |
| CI pipeline | **NONE** — no `.github/` (no GitHub Actions), no `.gitlab-ci.yml` | directory checks |
| Live/E2E scripts | `apps/server/scripts/e2e-live.ts`, `verify-live.ts` exist (manual gate, never in CI — documented in README) | repo listing |

**Coverage gaps vs. mission (Principle 6):**
- No **contract/E2E** tests exercising the full REST surface (upload → job → poll → artifact download) against a real in-process app with mock provider — `api.test.ts` covers a subset.
- No CI at all → "Production deployment verified only by build success" risk is currently mitigated only by `deploy/deploy.sh` (which does run server tests on the server post-restart — good, but not a pre-deploy gate).

---

## 7. API surface (actual, from code)

Registered routes (Fastify, no version prefix, no OpenAPI):

| Area | Routes |
|---|---|
| Health | `GET /api/health`, `GET /api/health/ready`, `POST /api/health/account`, `POST /api/health/egress` |
| Jobs | `POST /api/jobs` (multipart: prompt/title/prefer + `audio` file), `GET /api/jobs` (filter+pagination), `GET /api/jobs/:id`, `…/events`, `…/attempts`, `…/artifacts`, `GET /api/jobs/:id/artifacts/:artifactId` (download), `GET /api/jobs/:id/audio`, `GET /api/jobs/:id/audio/download`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/requeue` |
| Accounts | `POST /api/accounts`, `GET /api/accounts`, `GET /api/accounts/:id`, `POST /api/accounts/:id/health`, (plus session/import routes in `sessions.ts`) |
| Proxies | `POST /api/proxies` (VLESS URI), `POST /api/proxies/manual`, `GET /api/proxies`, `POST /api/proxies/ping-all`, `GET /api/proxies/runtime` (+ health-check routes) |
| Settings/Secrets | `GET /api/settings`, `PUT /api/settings`, `GET /api/secrets` (redacted) |
| Provider | `GET /api/provider` |

**Gaps vs. mission (Principles 4–5, 9):**
1. **No `/api/v1` versioning** — all routes are unversioned `/api/*`.
2. **No OpenAPI/Swagger** anywhere (no `@fastify/swagger`/`swagger-ui` dependency; no spec file).
3. **No API authentication/authorization** — the trust model is loopback-only (documented; `cors` restricted to local origins; global rate limit 300/min). For third-party/external consumers, **token auth is required** (not present).
4. **No webhooks** (no webhook code in `apps/server/src`).
5. **No idempotency keys**, no correlation IDs.
6. Job lifecycle is otherwise solid: async jobs with ID `j_<hex32>`, state machine in `packages/shared/src/job-state.ts` (tested), events, attempts, cancellation, requeue.
7. No separate "outputs" endpoint — artifacts are per-job (`/api/jobs/:id/artifacts`), which is acceptable; just needs documenting.
8. Consistent error envelope exists (`ApiCodes` in `@nlo/shared`) — good base for spec.

---

## 8. Docker / deployment

| Item | State | Evidence |
|---|---|---|
| `Dockerfile` | exists (self-contained live-mode image; bakes venv to `/opt/nbl-venv`) | repo |
| `docker-compose.yml` | exists; loopback-only publish, `./data` volume, restart policy, env interpolation | repo |
| `.dockerignore`, `.env.example` | exist | repo |
| `deploy/deploy.sh` | reproducible git-based deploy with DB+env backup (retention 5), preflight, post-restart health+ready+port+journal checks, regression test run, rollback via `ROLLBACK=1` | repo + P3 evidence (executed twice successfully on s52) |
| Production run mode | **systemd + tsx** (NOT docker) — service unit `deploy/systemd/nlo.service`, tracked, secret-free | `systemctl status` cgroup shows `tsx src/main.ts` |
| Compose tested? | Not re-verified this session; P3 history indicates image build was part of earlier work. Compose is for "local single-user" runs; s52 runs the bare+systemd path | repo comments + service evidence |

**Gaps:**
- Compose does not include the proxy runtime as a container (xray runs as vendored binary on host/in-image) — acceptable, but Phase D must document which components may NOT be containerized (Playwright needs system deps; xray binary is a vendor drop-in).
- No healthcheck in compose service block (only `restart: unless-stopped`).

---

## 9. Governance artifacts (Principle 3)

| Artifact | State |
|---|---|
| `README.md` | exists (Persian, good dev entry) — but framed as **local single-user app**; needs expansion per mission (API, Swagger link, Wiki.js link, feature status matrix, contributing) |
| `CONTRIBUTING.md` | **missing** |
| `SECURITY.md` | **missing** (security content lives in `docs/security.md`) |
| `CHANGELOG.md` | **missing** (releases unmanaged; git history is the only record) |
| `AGENTS.md` | **missing** |
| `docs/architecture/` | flat `docs/` instead (architecture.md, security.md, deployment.md, quick-start.md, provider-evaluation.md, proxy-design.md, development-plan.md, reports/) — restructure or alias in Phase B |
| `docs/api/`, `docs/development/`, `docs/testing/`, `docs/operations/` | **missing** |
| Existing report | `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md` (prior phase evidence) |

---

## 10. Security posture snapshot (Principle 12)

Present and tested: fail-closed egress (17 tests), SSRF guard module (8 tests), secret redaction in logs (5 tests), vault AES-256-GCM + 0600 key, safe filename generation (7 tests), loopback bind, input validation (zod), rate limiting, `.env` git-ignored (verified: only `.env.example` tracked).

Gaps vs. mission: API auth for non-local consumers; access control on job/output reads (any local caller can read any job); no audit events for sensitive ops; no webhook signature/delivery model; no path-traversal test beyond `safe-name` unit coverage.

---

## 11. Gap summary (what exists / what's missing / what must be created)

| # | Capability | Exists | Missing | Must create |
|---|---|---|---|---|
| 1 | Git hygiene (local/GitHub/s52) | ✅ in sync at `80a9e66` | — | (Phase B: remove 2 `.bak` files; CI branch protection later) |
| 2 | Internal GitLab | ✅ instance on s52 (`git.ai.ismc.ir`) | NLO project, credentials, CI | Create project via API (needs token), mirror strategy (GitHub = public source of truth, GitLab = CI/internal), `.gitlab-ci.yml` |
| 3 | CI pipeline | ❌ none | lint/typecheck/test/build/OpenAPI-validate/docker-build | GitHub Actions + GitLab CI (Phase B) |
| 4 | OpenAPI + Swagger | ❌ none | spec from code, `/api/docs`, `/api/openapi.json` | fastify swagger (or @fastify/swagger) + schema-first generation (Phase C) |
| 5 | API auth for 3rd parties | ❌ loopback-only trust | token auth, per-consumer scoping | API key/bearer middleware + admin token issuance (Phase C) |
| 6 | Webhooks | ❌ none | delivery, signing, retry, event model | webhook engine (Phase C/G) |
| 7 | Versioning `/api/v1` | ❌ unversioned | v1 prefix strategy (deprecate old or alias) | route re-registration under `/api/v1` keeping backward compat (Phase C) |
| 8 | E2E/contract tests | ⚠️ partial (api.test.ts) | full upload→job→artifact flow test; OpenAPI contract test | e2e suite with mock provider (Phase C) |
| 9 | Docker Compose completeness | ⚠️ works for local; not the prod path | healthcheck, documented non-containerizable parts | Phase D |
| 10 | Wiki.js publishing | ✅ instance exists (`docs.ai.ismc.ir`, port 8888 local) | API account/credentials; NLO section; README links | credentials from user; Markdown-first pages; publish via API (Phase E) |
| 11 | Third-party SDK/samples | ❌ none | cURL examples, sample JSON, one SDK (Python or TS) | generated from OpenAPI + contract tests (Phase C/E) |
| 12 | Domain `nlo.ai.ismc.ir` | ⚠️ DNS A record already → 80.191.92.189 (edge) | TLS, vhost, proxy route to s52:4870, auth/rate-limit/CORS | edge (Kong/nginx) config + security review (Phase F) |
| 13 | Governance docs | ⚠️ partial docs/ tree | CONTRIBUTING, SECURITY, CHANGELOG, AGENTS.md, docs subfolders | Phase B |
| 14 | README productization | ⚠️ local-app framing | API-first framing, feature status, links | Phase B/C |

---

## 12. Recommended execution order (phases B–G inputs)

1. **Phase B (Governance):** create `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`; restructure `docs/` (architecture/development/deployment/api/testing/operations/reports); update README skeleton; set up GitHub Actions (lint/typecheck/test/build) + GitLab CI (requires **GitLab token from user**); document GitHub↔GitLab sync policy (GitHub = public truth; GitLab = internal CI/deploy mirror, one-way push).
2. **Phase C (API productization):** add `/api/v1` alias layer; wire `@fastify/swagger` → `/api/docs` + `/api/openapi.json`; token auth middleware (opt-in, backward-compatible for local UI); error/pagination/correlation-id standards; cURL + sample JSON + one sample client (Python, matching the worker stack) with contract tests; extend E2E to full job flow.
3. **Phase D (Deployment):** compose healthchecks + persistence matrix; document xray/Playwright containerization limits; re-run real `docker compose up` test on a non-prod host (jump53); keep s52 on systemd (no forced migration).
4. **Phase E (Customer docs):** write Markdown pages (14-section Wiki structure); publish to Wiki.js via API (**needs Wiki.js API account from user**); record real links in README.
5. **Phase F (External access):** after B–E; add edge route for `nlo.ai.ismc.ir` (Kong or nginx on the edge box) → s52, TLS, auth, rate limiting; no internal port exposure beyond the edge.
6. **Phase G (Product features):** Google Drive, DOCX, Studio outputs, Download Manager — only after the above gates pass.

**Access items to request from the user (only these):**
1. GitLab credentials/token (personal access token with `api` scope, or an admin account) for `git.ai.ismc.ir` — to create the NLO project and run CI.
2. Wiki.js API access (local account with admin + API enabled, on `docs.ai.ismc.ir` / s52:8888) — to publish documentation pages.
3. Confirmation of the edge reverse-proxy owner for `nlo.ai.ismc.ir` (Kong cluster on s52 vs. edge box at 80.191.92.189) before Phase F.

---

*No destructive changes were made during this audit. Two 0-byte stray files created accidentally on the Windows workstation by a malformed probe command were deleted the same session; `git status` confirms a clean tree at report time.*
