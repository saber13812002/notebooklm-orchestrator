# AGENTS.md — Permanent Development Rules (NLO)

This file is the **standing instruction set for every AI coding agent** (and human
contributor) working on the NotebookLM Orchestrator (NLO) repository. It is
binding for all future sessions; it is not a one-phase checklist.

Mission context: NLO is an **operational service** on `172.20.1.52` (service
`nlo`, port `4870`) with verified real NotebookLM connectivity and real
audio→text processing. The target state is an **API-first, deployable,
documented, testable product** consumable by the current frontend, internal
systems, and third-party applications.

## 1. Protect the operational system (before ANY change)

1. **Inspect before touching.** Check the local repository, the GitHub remote,
   and s52: branch, commit SHA, uncommitted changes, untracked files.
   Report them before proceeding.
2. **Inspect live state.** `systemctl status nlo`, `/api/health`,
   `/api/health/ready`, port binding, DB (`data/nlo.sqlite`), sessions,
   worker. Preserve existing working behavior.
3. **Never rewrite working operational capability** without a test and a
   stated technical reason.
4. **Back up before risky infrastructure changes** (`deploy/deploy.sh`
   already backs up DB + `.env` on every deploy; manual steps require an
   equivalent backup first).
5. **After every significant change:** run the regression suite
   (`npm test`), the health checks, and (on s52) verify the service is
   still active and ready.
6. **Ask, don't guess.** If access or information is missing (tokens,
   credentials, DNS, proxy ownership), request exactly that item from the
   user. Never invent an address, token, or setting.

## 2. Dual-repository policy (GitHub + internal GitLab)

| Repo                                               | Role                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| **GitHub** `saber13812002/notebooklm-orchestrator` | Public repository; source of truth for public code; collaboration. |
| **GitLab** `git.ai.ismc.ir` (internal, on s52)     | Internal CI/CD, organizational access control, deploy mirror.      |

- **One-way mirror:** GitHub is the source of truth. GitLab receives
  mirrored pushes (GitHub → GitLab). Commits are never created first on
  GitLab; GitLab is never pushed back to GitHub automatically.
- Never change the existing `origin` remote without verification and user
  approval.
- **No secrets ever in any repo:** no `.env`, cookies, tokens, VLESS UUIDs,
  vault keys, or session files. `.gitignore` enforces this; CI should
  enforce it (secret scan) as a hard gate.
- CI coordination: GitHub Actions runs on GitHub; GitLab CI runs the same
  checks internally (`.gitlab-ci.yml` mirrors the workflow). Do not create
  GitLab runners or change infrastructure without explicit authorization.

## 3. Mandatory rules for every change

Every change — human or agent — must:

1. Have a **clear goal and scope**, stated in the commit message.
2. Be **compatible with the existing architecture** (see
   [`docs/architecture/overview.md`](docs/architecture/overview.md)).
3. Include **tests proportional to its risk** (see §5).
4. **Update related documentation** (README / docs tree / CHANGELOG if user-visible).
5. **Update OpenAPI** if any API contract changes (OpenAPI is created in a
   later phase; until then the route code + tests are the contract).
6. **Review Docker/deployment impact** (`Dockerfile`, `docker-compose.yml`,
   `deploy/deploy.sh`) when runtime files change.
7. **Avoid unnecessary destructive changes.** No rewrites, no history
   rewrites, no force-pushes.
8. Be committed with a **clear message** after tests pass.

A change without tests or docs is **not complete**.

## 4. API-first architecture

- The REST API is the **primary contract** between all parts of the system.
  New capabilities must be reachable through the API; the frontend is just
  one consumer.
- Consumers: current frontend, internal systems, third-party applications,
  automation tools, future integrations.
- **The frontend must never** talk to the database, the Python worker, MCP,
  or provider details directly — only `/api/*`.
- Long operations are **asynchronous**: job creation returns a trackable ID
  (`j_<hex32>`); status, events, attempts, artifacts, and downloads are all
  queryable via API.
- Base capabilities (current → target): auth (target: API tokens), job
  create/status, task events, output listing, upload, download,
  cancel/requeue, webhooks (target), health/readiness, pagination,
  validation, consistent error envelope
  (`{ "error": { "code", "message" } }` — `ApiCodes` in
  `packages/shared/src/api-error.ts`), correlation IDs (target), idempotency
  (target).
- **Never report an unsupported operation as successful.** Provider
  capabilities are declared in a capability matrix
  (`providers/types.ts`); honor it.
- Separate native NotebookLM outputs from prompt-generated outputs; do not
  fabricate artifacts (the application only surfaces files the provider
  actually produced).

## 5. Testing is mandatory (proportional, honest)

- **Unit:** validation, job state machine (`packages/shared/src/job-state.ts`),
  redaction, SSRF guard, safe names, retry policy, provider capability mapping.
- **Feature/integration:** REST API surface (`apps/server/test/api.test.ts`),
  job manager, repositories, provider adapter (mock), download manager,
  authentication.
- **E2E:** full flows (upload → job → result → artifact download) against an
  in-process app with the **mock** provider.
- **Live:** `apps/server/scripts/e2e-live.ts` / `verify-live.ts` — **manual
  gate only, never in CI** (real Google accounts, real egress, cost).
- **Mock tests do not prove real NotebookLM execution.** Reports must state
  honestly which level was verified: `Unit/Integration/E2E passed` vs
  `Live verified` vs `Not tested`. Do not invent test counts.
- CI runs: lint, typecheck, unit + feature tests, build. (OpenAPI validation
  and docker build join when those exist.)

## 6. Documentation rules

- `README.md` = developer entry point (install, env vars, tests, deploy,
  API, docs links, feature status).
- `docs/` structure: `architecture/`, `development/`, `deployment/`,
  `api/`, `testing/`, `operations/`, `security/`, `reports/`, `wiki/`
  (customer docs, published to Wiki.js when credentials allow).
- **Customer documentation lives in `docs/wiki/`** as Markdown, one file per
  Wiki page, published to Wiki.js via its API when authorized.
- Never describe a planned capability as ready. Status must be honest
  (`implemented+tested` / `implemented+live-verified` / `planned`).
- Reports go to `docs/reports/`. Every phase ends with a report: evidence,
  changed files, commits, remaining limitations.

## 7. Security invariants (see also `SECURITY.md`)

- No secrets in logs (redaction module), no secrets in git, no secrets in
  images/Dockerfile/Compose.
- Loopback-only binding by default; any non-loopback bind requires an
  auth-capable reverse proxy in front (documented, reviewed).
- Fail-closed egress: provider traffic **never** goes direct without a
  verified proxy tunnel (tested).
- Input validation (zod) on all routes; file uploads: extension whitelist,
  size limit, server-generated safe names (no user path components);
  SSRF guards for URL-based ops; session files `0700`; vault `AES-256-GCM`
  with `0600` key.
- Treat "internal service" as **not** a substitute for access control.

## 8. Deployment rules

- Production path on s52: **git-based** via `deploy/deploy.sh` (systemd
  service `nlo`). Only commits reachable from `origin/main` are deployed.
- Never `git reset --hard` on s52 to a foreign tree; never delete `data/`.
- `data/` (DB, archives, vault, sessions, vendor binaries, venv) is
  git-ignored and must survive any container recreate / checkout.
- Docker Compose is for **local single-user** runs; s52 stays on
  systemd unless a migration is explicitly approved.
- Rollback must always be possible: previous-good commit is printed by the
  deploy script; DB restore is from `data/backups/`.

## 9. Phase discipline

- Work is executed in **phases** (A: audit, B: governance, C: API
  productization, D: deployment packaging, E: customer docs, F: domain/
  external access, G: product features).
- At the end of each phase: run tests, present evidence, report commits and
  changed files, state remaining limitations, and **wait for user approval**
  before starting the next phase.
- No destructive or externally visible action (push, publish, DNS, proxy)
  inside a phase that has not been approved for that action.

## 10. Pre-commit checklist (agent or human)

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `npm test` — all workspaces green (server, web, shared)
- [ ] `npm run build` succeeds
- [ ] No new secrets / runtime files staged (`git status` review)
- [ ] Docs updated where behavior changed
- [ ] CHANGELOG updated for user-visible changes
- [ ] Commit message states goal + scope
- [ ] Regression + health checks pass (on s52, after deploy)
