# Changelog

All notable changes to the NotebookLM Orchestrator are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is commit-based (no semantic versions yet — tags are the next
step in the API productization phase).

Honesty rule: an entry may say "implemented" only with tests; "live-verified"
only with a recorded live run; otherwise "planned".

## [Unreleased]

### Added (governance & documentation)

- `AGENTS.md` — permanent development rules for all agents/contributors.
- `CONTRIBUTING.md` — how to propose and land changes.
- `SECURITY.md` — security policy + vulnerability reporting channel.
- `CHANGELOG.md` — this file.
- `docs/` restructured by topic: `architecture/`, `development/`,
  `deployment/`, `security/`, `api/`, `testing/`, `operations/`, `reports/`,
  `wiki/`.
- `docs/wiki/` — customer documentation source (Markdown; published to
  Wiki.js when API credentials are authorized).
- CI: GitHub Actions workflow (lint, typecheck, tests, build) and a ready
  `.gitlab-ci.yml` for the internal GitLab (`git.ai.ismc.ir`).

### Unchanged (explicit non-goals of this change)

- No API changes: no versioning, no new auth, no webhooks — those are Phase C.
- No production restart; s52 continues serving from its current commit until
  a reviewed deploy is requested.

## [2026-10-27] — P3 (repository & deployment audit)

### Added

- `deploy/deploy.sh` — reproducible git-based deployment with DB+env backup
  (5 retained), preflight checks, post-restart health/ready/port/journal
  verification, regression test run, and `ROLLBACK=1` rollback.
- `deploy/systemd/nlo.service` — secret-free production unit (tracked).
- `docs/deployment/s52-deploy.md` — canonical deployment procedure.

### Fixed

- `deploy.sh`: PATH-hardened dependency install + repo-local vitest for
  non-interactive SSH shells.

### Removed

- Tracked Python bytecode cache (`__pycache__/*.pyc`) — regenerable artifact.

## [2026-10-26] — P2 (deployed & live-verified)

### Fixed

- Proxy: probe curl candidates at startup so a broken distro curl is skipped.
- Runner: clear stale error fields when a job succeeds; cancel-vs-late-success
  race; worker cancel/redaction; Windows worker stdin.
- Worker: honor shutdown via stdin EOF + loop signal handlers.

### Verified

- Real NotebookLM job (audio → grounded answer) executed end-to-end through
  the Python worker and Xray tunnel (live-verified; evidence in
  `docs/reports/P3_REPOSITORY_AND_DEPLOYMENT_AUDIT.md`).

## [2026-10-25] — P1 (foundation, deployed)

### Added

- Monorepo (npm workspaces): `apps/server` (Fastify + node:sqlite),
  `apps/web` (React + Vite, Persian RTL), `packages/shared`.
- Job state machine (shared, tested), durable queue with restart recovery,
  job archives (manifest, timeline, attempts, artifacts).
- Provider abstraction: `NotebookLMProvider` interface; MockProvider
  (default) + PythonWorkerProvider (explicit opt-in) with capability matrix.
- Proxy runtime: VLESS URI parser, masking, MockRuntime + Xray adapter;
  fail-closed egress guard (tested).
- Secrets: file vault AES-256-GCM (0600 key), log redaction, safe names,
  SSRF guard (all unit-tested).
- REST API: jobs (create/list/get/events/attempts/artifacts/cancel/requeue),
  accounts + sessions, proxies, settings, secrets (redacted), provider,
  health/readiness.
- Docker: `Dockerfile` (self-contained live-mode image) +
  `docker-compose.yml` (loopback-only, `./data` persistence).
