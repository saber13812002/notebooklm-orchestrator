# Phase D — Server Endpoint Migration: Documentation Migration

**Date:** 2026-11-01 (UTC) · **Addendum phase:** D · **Approval:** user-approved
scope = push of Phase C commit `3f796a6` to `origin/main`, then Phase D
(documentation migration), stop before Phase E.

---

## 1. Executive summary

Migrated **all current operational references** to the legacy production host
s52 (`172.20.1.52`) across 12 tracked files, phrased honestly per the
verified migration state:

- legacy host s52 **decommissioned** (all probes time out — Phase B);
- **NLO is NOT yet running on the new host** `172.30.0.133`
  (`:4870` refused; domain vhost 404) — re-deployment is **pending, addendum
  Phase G**;
- GitLab (`:81`) and Wiki.js (`:8888`) are already re-homed on `172.30.0.133`;
- LiteLLM (`172.30.0.133:4000`, OpenAI-compatible) is the **internal LLM
  proxy — not NLO, not an SSH host, not a reverse proxy** (Phase C).

Dead guidance (standing s52 SSH tunnel, port 14870) was removed from the
deploy runbook and wiki. **Docs/comments only** — no code, config, or runtime
behavior changed. Full regression green (169/169); typecheck/lint/format/
build clean for phase files. Committed locally; **Phase D push NOT performed**
(only the Phase C push was approved).

## 2. Initial state

- Local `main` @ `3f796a6` (Phase C commit), 1 ahead of `origin/main`
  (`bc23920`); tracked tree clean (untracked scratch: `$out`, `HTTP`, `tmp/` —
  left alone).
- Phase C push approved: `bc23920..3f796a6 main -> main` — verified in sync
  (`git rev-list --left-right --count origin/main...HEAD` → `0 0` after fetch).
- Dev server 4871 running (PID 27528); stale 4870 (PID 8380) untouched.

## 3. Implementation (goal + scope: ① change-list, server-identity text only)

| File                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AGENTS.md`](../../AGENTS.md)                                                 | Mission context: host identity neutralized + status sentence (s52 decommissioned; re-deploy on `172.30.0.133` pending, Phase G). §1.1/§1.5/§8/§10: "s52" → "the production host". §2 GitLab row keeps `git.ai.ismc.ir` (class ③) — its host note was the only ① text and is now implied by the mission-context status.                                                                                                                                         |
| [`README.md`](../../README.md)                                                 | Intro status sentence (Persian): s52 decommissioned, NLO not yet on new host (Phase G). Deploy section retitled «استقرار روی سرور production» + status block; code comment «روی s52» → «روی سرور production». Feature-status table: git-based deploy row rephrased (verified 2026-10-28 on s52 = historical fact; re-deploy in Phase G). Env table row for `NLO_INTERNAL_API_BASE_URL` already present from Phase C.                                           |
| [`docs/operations/README.md`](../operations/README.md)                         | Intro: host-neutral + status blockquote (s52 decommissioned; NLO not yet on new host; GitLab/Wiki.js already live; procedures host-agnostic). Day-2 table unchanged (all commands host-agnostic). Node path note generalized.                                                                                                                                                                                                                                  |
| [`docs/deployment/s52-deploy.md`](../deployment/s52-deploy.md)                 | **Filename kept** (links from README, operations README, wiki 14, CONTRIBUTING, deploy.sh stay valid; renaming would break the public GitHub blob URL in wiki 14). Header: host-neutral target + status blockquote + filename-kept note. «Normal deploy (on s52)» → «(on the production host)». First-time setup marked as executed on legacy host. Security section: standing s52 tunnel (14870) declared dead; port-forward shown with `<host>` placeholder. |
| [`docs/wiki/13-developer-guide.md`](../wiki/13-developer-guide.md)             | (Persian) `deploy/` row: «اسکریپت استقرار s52» → «(هاست-مستقل)». Deploy rule + loopback limitation: s52 → «سرور production».                                                                                                                                                                                                                                                                                                                                   |
| [`docs/wiki/14-deployment-operations.md`](../wiki/14-deployment-operations.md) | (Persian) Intro status sentence; model table «سرور» row: new host `172.30.0.133` (NLO deploy in Phase G; s52 legacy); «استقرار معمول» heading host-neutral; access row: `<host>` placeholder + note that s52/14870 tunnel is retired; single-point-of-failure bullet updated.                                                                                                                                                                                  |
| [`deploy/deploy.sh`](../../deploy/deploy.sh)                                   | Header comment only: «run on the server, e.g. s52» → host-agnostic + s52 decommissioned note. **Script logic unchanged** (already host-agnostic: `NLO_SERVICE`/`NLO_PORT` env, repo-relative paths).                                                                                                                                                                                                                                                           |
| [`deploy/systemd/nlo.service`](../../deploy/systemd/nlo.service)               | Comment only: «s52 deployment» → «production deployment … host-agnostic — adjust paths/user per host». **Unit directives unchanged** (paths/user are host facts to be re-set in Phase G).                                                                                                                                                                                                                                                                      |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md)                                     | Deployment section: s52 removed; notes `s52-deploy.md` filename kept for historical continuity.                                                                                                                                                                                                                                                                                                                                                                |
| [`docs/api/README.md`](../api/README.md)                                       | §Contract & testing: «live on s52» annotated as the then-production host, since decommissioned 2026-11-01 (with pointer to the Phase A audit).                                                                                                                                                                                                                                                                                                                 |
| [`docs/ROADMAP_MASTER.md`](../ROADMAP_MASTER.md)                               | Addendum status table: C → ✅ done (pushed `3f796a6`), D → ✅ done; 14870 tunnel note struck through as removed.                                                                                                                                                                                                                                                                                                                                               |
| [`CHANGELOG.md`](../../CHANGELOG.md)                                           | New `[2026-11-01] — Phase D` entry (Changed / Unchanged / Notes).                                                                                                                                                                                                                                                                                                                                                                                              |

### Deliberately NOT changed (per ①/②/③ classification)

- **Class ② (historical, kept verbatim):** every `docs/reports/*` file, all
  historical `CHANGELOG.md` entries, `tmp/` scratch artifacts,
  `data/tmp/` probe scripts, `.git/logs`, and the
  [`nbl_worker.py`](../../apps/server/src/providers/python-worker/nbl_worker.py)
  line-516 observation comment.
- **Class ③ (other services, do-not-change):** `git.ai.ismc.ir` references
  (`docs/operations/gitlab-sync.md`, AGENTS.md §2, `.gitlab-ci.yml`),
  `docs.ai.ismc.ir` (`docs/wiki/README.md`), edge `80.191.92.189`, jump53.
- **App-own port `4870` everywhere:** [`config.ts`](../../apps/server/src/config.ts)
  default, [`Dockerfile`](../../Dockerfile)/[`docker-compose.yml`](../../docker-compose.yml)
  (their 4870 references are the container's own port — verified no `s52`
  text exists in either file), CI docker-smoke,
  [`vite.config.ts`](../../apps/web/vite.config.ts), live/e2e scripts.
- **No code or config change** — Phase D is documentation/comments only.

## 4. Git

- 1 local commit on `main` (message: `docs(endpoint-migration): Phase D —
migrate s52/172.20.1.52 operational references to post-migration host
identity (NLO re-deploy on 172.30.0.133 pending Phase G); docs/comments
only`) — SHA recorded at commit time.
- **Push: NOT performed** for the Phase D commit (only the Phase C push was
  approved in the current instruction).
- `origin` unchanged: `https://github.com/saber13812002/notebooklm-orchestrator.git`.

## 5. Tests (level: **docs-only — no new tests required; regression re-run**)

- `npm test` — **all workspaces green: shared 44, server 100, web 25 →
  169/169 pass** (identical to Phase C baseline — no source changed).
- `npm run typecheck` — clean (3 workspaces).
- `npm run lint` — clean for all tracked files. Pre-existing 6 × `no-empty`
  errors remain in untracked scratch `tmp/n1-auth-probe.mjs` (unchanged since
  Phase C; recommend a hygiene commit, needs approval).
- `npm run format:check` — clean for all phase-touched files
  (prettier `--write` applied to README.md, ROADMAP_MASTER.md, wiki 13/14
  after edits; table re-alignment in wiki 14 is formatting only).
- `npm run build` — success (web `✓ built in 6.46s`).

## 6. Live verification

None possible and none needed: no runtime change. The 4871 dev server
continued running throughout (no restart).

## 7. Security

- No secrets added, moved, or printed. All changes are prose.
- No credentials referenced; `<host>` placeholder used instead of any
  new address beyond the already-public `172.30.0.133` (internal, already in
  Phase A–C reports and `.env.example` comments).
- `.gitignore` boundary respected: only the 12 tracked phase files + report
  staged; `$out`, `HTTP`, `tmp/` remain untracked.

## 8. Deployment

- **No deployment performed.** No production change of any kind (nothing is
  deployed anywhere until Phase G, which is a hard approval gate).
- Docker/CI impact: none — no runtime files changed.

## 9. Data safety

- No DB, archive, vault, or session touch. `data/` untouched.
- No backup required (docs-only); none taken.

## 10. Evidence

- `git diff --stat` pre-commit: 12 files, +137/−58 (all reviewed line-by-line
  via two diff dumps; only ①-class text touched).
- Full-text grep re-verification (post-edit, in scope files): remaining
  `s52` mentions are intentional historical/status references
  («legacy host s52», «decommissioned», «verified on s52 2026-10-28») and
  the kept filename; remaining `172.20.1.52` mentions always appear as the
  legacy/decommissioned host; `14870` appears only as «dead/retired» notes
  outside `docs/reports/`.

## 11. Limitations

- `docs/deployment/s52-deploy.md` filename still contains `s52` (decision:
  keep — renaming breaks 4 inbound links incl. a public GitHub blob URL in
  wiki 14; a rename with redirects is a separate governance decision).
- The new production host's actual deploy details (repo path, Node path,
  user) are still the s52-era values in the runbook/`nlo.service` — they will
  be re-confirmed on the new host during Phase G.
- `docs/operations/gitlab-sync.md` still describes the GitLab container as
  being «on s52» — left as class ③ (GitLab is a different service and its
  re-homing details belong to a GitLab-side doc update, flagged in the Phase A
  open questions; not part of the NLO ① list).

## 12. Rollback

- Single commit; `git revert <sha>` restores every file byte-for-byte. No
  state outside git is affected.

## 13. Next phase proposal (Phase E — Integration tests)

Per the addendum: tests proving (a) no requests to the old IP, (b) the new
endpoint is used via `NLO_INTERNAL_API_BASE_URL`, (c) clean structured errors
when the endpoint is down, (d) secret redaction for any LLM key. **Blocker
carried:** needs an LLM API key via the secret store (never in repo) to
exercise `/v1/models`; mock-level tests can proceed without it.

## 14. Approval request (explicit STOP)

Phase D is complete and committed locally. **Not pushed.** Awaiting approval
for: (a) push of the Phase D commit to `origin/main`, and (b) starting
Phase E (integration tests).
