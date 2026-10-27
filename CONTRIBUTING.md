# Contributing — NotebookLM Orchestrator

Thanks for contributing. NLO is an **operational service** (production runs
on an internal server, `nlo.service`, port 4870), so the bar for "safe to
merge" is higher than for a hobby project. Read [`AGENTS.md`](AGENTS.md) —
it is the binding rulebook for every change, human or agent.

## How to submit a change

1. **Fork/branch from `main`** on GitHub
   (`https://github.com/saber13812002/notebooklm-orchestrator`).
2. Make a **small, single-purpose change** with a clear goal.
3. Run the full quality gate locally (see below) until green.
4. Push the branch and open a pull request against `main`.
5. CI (GitHub Actions) runs: lint → typecheck → tests → build. All must pass.
6. A maintainer reviews. Only reviewed code on `origin/main` is deployable.

Commit message convention (Conventional Commits):

```
type(scope): goal — one-line summary

body: scope of the change, why, what was tested, which docs updated
```

Examples: `fix(deploy): PATH-hardened dep install for non-interactive SSH`,
`docs: restructure docs tree by topic`.

## The quality gate (mandatory before merge)

```bash
npm run typecheck
npm run lint
npm run format:check
npm test            # all workspaces: server, web, shared
npm run build
```

Plus:

- **Tests proportional to risk.** Every behavioral change ships with tests
  (unit or feature/integration). Docs-only changes still need a proofread
  pass and a `docs:` commit.
- **Docs updated.** If behavior, env vars, or the API changed: README,
  relevant `docs/` page, and `CHANGELOG.md`.
- **No secrets.** Never commit `.env`, cookies, tokens, VLESS UUIDs, vault
  keys, or session files. `.gitignore` blocks the common cases; CI is the
  hard gate.
- **No destructive operations.** No force-pushes, no history rewrites, no
  unrelated refactors riding along.

## Deployment

Production (s52) deploys **only** from reviewed commits on `origin/main` via
`deploy/deploy.sh` — see [`docs/deployment/s52-deploy.md`](docs/deployment/s52-deploy.md).
Contributors do not deploy; maintainers do, with the script's built-in
backup/verify/rollback.

## Live-mode caution

Live operations (real Google accounts, real egress through VLESS nodes) are
a **manual gate**: `npm run verify:live --workspace @nlo/server`. Never run
live flows in CI, and never commit their artifacts (they contain real
content).

## Where things live

| Concern         | File                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Binding rules   | [`AGENTS.md`](AGENTS.md)                                             |
| Security policy | [`SECURITY.md`](SECURITY.md)                                         |
| Release notes   | [`CHANGELOG.md`](CHANGELOG.md)                                       |
| Developer guide | [`docs/development/quick-start.md`](docs/development/quick-start.md) |
| Architecture    | [`docs/architecture/overview.md`](docs/architecture/overview.md)     |
| Testing policy  | [`docs/testing/`](docs/testing/)                                     |
