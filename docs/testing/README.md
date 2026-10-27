# Testing

Policy: every change ships tests proportional to its risk. Honesty rule: a
report must state which level was verified — `Unit/Integration/E2E passed`
vs `Live verified` vs `Not tested`. **Mock tests do not prove real
NotebookLM execution.** Do not invent test counts.

## Levels

| Level               | What                                                                                       | Where                                               |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Unit                | job state machine, redaction, SSRF guard, safe names, retry, VLESS URI, capability mapping | `packages/shared/test/`                             |
| Feature/integration | REST API surface, repositories, queue/job lifecycle, fail-closed egress, session gate      | `apps/server/test/`                                 |
| Web                 | API client, utilities, date helpers                                                        | `apps/web/src/**/*.test.ts`                         |
| E2E (mock)          | full flows against an in-process app with MockProvider                                     | `apps/server/test/` (extend as flows grow)          |
| **Live**            | real Google accounts + real egress — **manual gate only, never in CI**                     | `apps/server/scripts/e2e-live.ts`, `verify-live.ts` |

## Commands

```bash
npm test             # all workspaces (unit + feature + web) — no network, no credentials
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## CI

- GitHub Actions: `.github/workflows/ci.yml` — lint → typecheck → test →
  build on push/PR to `main`.
- GitLab (internal): `.gitlab-ci.yml` — same stages for the mirrored repo.
- OpenAPI validation and Docker build join the pipeline when those exist
  (Phase C/D).

## Live verification (manual)

```bash
npm run verify:live --workspace @nlo/server    # on the live host, with credentials in place
```

Record live evidence in `docs/reports/` (what ran, commit SHA, outcome).
