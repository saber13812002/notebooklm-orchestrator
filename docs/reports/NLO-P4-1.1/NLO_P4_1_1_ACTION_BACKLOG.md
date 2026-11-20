# NLO-P4-1.1 — Consolidated Action Backlog (P0 → P3)

- **Source:** consolidation of the 7 agent reports in this directory (finding IDs cited per item).
- **Status at writing:** nothing in this backlog has been started (read-only mission).
- **Field key (every item):** Description · Evidence · Root cause · File/module · Production
  impact · Dependencies · Fix · Acceptance test · Story points · Prompt(s) needed · Model
  (Qwen/DeepSeek) · Owner approval? · Parallelizable.
- **Story points** are relative to this codebase's phase norms (a full P4 phase ≈ 8–13 pts).

---

## P0 — Critical (blocks production/live work)

### BL-P0-1 — Re-deploy NLO on the new production host (172.30.0.133)

- **Description:** No production instance of NLO exists anywhere: legacy s52 was decommissioned
  2026-11-01 and the new host has no service, no vhost, no TLS, port 4870 closed. Re-deploy
  (git-based `deploy/deploy.sh`) to `172.30.0.133` and bring up `nlo2.ai.ismc.ir` (staging,
  stageA) first, then `nlo.ai.ismc.ir` (stageB) per the permanent standard.
- **Evidence:** `AGENT_E_DEPLOYMENT_AUDIT.md` §1–§3 (port probes: :80 aaPanel default, :443
  closed, :4870 closed, :22 open); `AGENT_G_LIVE_READINESS.md` §1; `docs/deployment/s52-deploy.md`
  status block; CHANGELOG entry "deployed 2026-11-14" refers to the *s52* era.
- **Root cause:** s52 decommissioning happened without executing the Phase G endpoint-migration
  addendum; re-deploy is pending.
- **File/module:** `deploy/deploy.sh`, `deploy/systemd/nlo.service`, `deploy/nginx/*.tpl`,
  `docs/deployment/s52-deploy.md`.
- **Production impact:** total — every "production", "staging", and live-acceptance statement is
  currently undefined; no external consumer can reach NLO at all.
- **Dependencies:** BL-P1-6 (SSH credentials), BL-P1-7 (host prerequisites + `data/` migration).
- **Fix:** owner-approved deploy session on the new host: verify `/home/saber` paths, node22,
  clone repo, migrate/restore `data/` (DB, vault, vendor/xray, sessions, backups), install
  systemd unit with corrected paths, `deploy/deploy.sh` (backs up automatically), verify
  health/ready/port/journal, then stageA nginx for `nlo2.ai.ismc.ir`.
- **Acceptance test:** `https://nlo2.ai.ismc.ir/api/health` → `{"ok":true}` AND
  `/api/health/ready` → `ready:true`; `systemctl status nlo` active; `data/deployed-commit`
  written; rollback dry-run (`NLO_DEPLOY_DRY_RUN=1`) succeeds.
- **Story points:** 5.
- **Prompt(s) needed:** a dedicated **deployment prompt** (not a P4 code phase) — see
  `NLO_P4_1_1_NEXT_PROMPT_PLAN.md` §pre-work.
- **Model:** Qwen (mechanical infra).
- **Owner approval?:** YES (production change, restart, nginx, DNS-facing).
- **Parallelizable:** YES — with all P4-2 code work (disjoint surface).

### BL-P0-2 — *(reserved — none)*

No other P0 found. Local-vendor breakage (G-BL-01) is P1 because the mock path (the de-facto
development path) is fully healthy.

---

## P1 — High

### BL-P1-1 — Fix 36-file prettier drift so CI `format:check` passes on a fresh clone

- **Description:** Run `npx prettier --write` on exactly the 36 listed files (format-only, no
  semantic change) or extend `.prettierignore`; verify `npm run format:check` is green at HEAD.
- **Evidence:** `AGENT_D_TEST_CI_AUDIT.md` §7/§7.1 — all 36 fail at HEAD (proven by
  `git show HEAD:<f> | prettier --check`); drift predates P4-1 (blobs at `f07ac1f`/`90f9619`
  already failing). The full 36-file list is in that report §7.
- **Root cause:** prettier config introduced/changed at some earlier phase without a full
  reformat pass; no CI gate had ever run on a clean clone.
- **File/module:** the 36 files (docs + 2 orchestrator `.ts` files + 1 test); `.prettierrc.json`.
- **Production impact:** none directly; CI integrity (a fresh clone cannot pass the repo's own
  quality gate).
- **Dependencies:** none.
- **Fix:** `npx prettier --write <36 files>` → re-run `npm run format:check` → commit as a
  format-only change (message states goal + scope).
- **Acceptance test:** `npm run format:check` exit 0 at HEAD on a **fresh clone**; `npm test`
  still 515/515 (format-only guard).
- **Story points:** 1.
- **Prompt(s) needed:** one-line fix prompt (mechanical).
- **Model:** Qwen.
- **Owner approval?:** NO (format-only; still committed via the normal flow).
- **Parallelizable:** YES (fully independent).

### BL-P1-2 — Repair the local python worker venv (`0xC0000006` spawn failure)

- **Description:** `data/venv` is corrupt/incomplete on the workstation; `/api/health/ready`
  reports `provider.configured:false` — `worker start failed: python worker exited
  unexpectedly (code=3221225794)`. Recreate the venv per `docs/deployment/s52-deploy.md`
  first-time-setup step 3 / `npm run worker:setup`.
- **Evidence:** `AGENT_G_LIVE_READINESS.md` §2 (verbatim ready-probe JSON).
- **Root cause:** venv install incomplete or native-dep mismatch on this Windows machine
  (0xC0000006 = STATUS_INVALID_HANDLE at process startup — typical of broken venvs).
- **File/module:** `data/venv/` (git-ignored runtime dir), `apps/server/python-requirements.txt`.
- **Production impact:** none (local only); but it blocks **all local live acceptance** and
  any live runbook until fixed.
- **Dependencies:** none.
- **Fix:** delete `data/venv`, recreate with the pinned Python, `pip install
  notebooklm-py[browser]` (per s52-deploy §first-time-setup), then re-probe
  `/api/health/ready` → expect `provider.configured:true`.
- **Acceptance test:** ready-probe shows `provider.configured:true` with no worker-spawn issue;
  one **mock** job still passes (regression); live job only after BL-P2-9 session verification.
- **Story points:** 2.
- **Prompt(s) needed:** one-line fix prompt.
- **Model:** Qwen.
- **Owner approval?:** NO (local runtime dir only; `data/` is never committed).
- **Parallelizable:** YES.

### BL-P1-3 — Decide on the public VLESS client UUID (owner decision)

- **Description:** `apps/server/scripts/_add-nodes.py` (52 node URIs, shared client UUID
  `b625fad2…`) has been in the **public** GitHub repository since `14954c4` (ancestor of
  `origin/main`). Owner must choose: (a) **accept + document** (note the exposure in
  `SECURITY.md`/threat model; UUID is the rotation handle), or (b) **rotate at the provider side
  + history-repair** (git-filter-repo — a history rewrite, requires explicit approval) and update
  the script.
- **Evidence:** `AGENT_C_SECURITY_AUDIT.md` §2 (file read + `git log` ancestry check).
- **Root cause:** historical node-import script committed with live URIs (pre-governance).
- **File/module:** `apps/server/scripts/_add-nodes.py`, git history, `SECURITY.md`.
- **Production impact:** low-medium (shared residential proxy pool for Google egress; endpoints
  are not NLO service endpoints; transport is TLS-wrapped).
- **Dependencies:** owner decision; if (b): new URIs from the provider.
- **Fix (a):** document in `SECURITY.md` + threat model; optionally move URIs out of the script
  to a git-ignored import file. Fix (b): provider-side UUID rotation, git-filter-repo pass,
  force-push with owner approval, update script.
- **Acceptance test:** (a) doc entry exists + secret-scan still green; (b) new UUID not in any
  public ref; `_add-nodes.py` re-imports successfully against the rotated pool.
- **Story points:** 1 (a) / 3 (b).
- **Prompt(s) needed:** decision prompt (owner) → then one-line doc prompt or a
  history-repair prompt (owner-approved).
- **Model:** DeepSeek (security judgment) for the write-up; Qwen for mechanical execution.
- **Owner approval?:** YES for (b) (history rewrite + force-push); (a) is a doc change
  (normal flow).
- **Parallelizable:** YES (doc/decision track).

### BL-P1-4 — `refresh()` return ignored → stand down on lock loss (R-1)

- **Description:** `job-runner.ts` L181 discards `locks.refresh(jobId, ttl)`. If a job outlives
  the lock TTL and another holder steals, the original keeps driving the job (double-drive).
  Fix: on `refresh() === false`, treat as lock loss — stop the current attempt without side
  effects (no release — we are no longer owner; no re-submit; emit a `lock_lost` event and let
  the other holder proceed), mirroring the `acquire()` stand-down path (L155–159).
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-1; `job-runner.ts` L155–159 vs L181.
- **Root cause:** "fire and forget" on a return value that is the ownership signal.
- **File/module:** `apps/server/src/queue/job-runner.ts`, `apps/server/src/domain/jobs.lock.ts`.
- **Production impact:** latent (single-instance model: steal source is only a restarted
  self, whose refresh would no-op correctly); becomes real with any multi-instance attempt.
- **Dependencies:** none.
- **Fix:** check the boolean; on `false` abort the attempt cleanly + log (redacted) + emit
  event; add a unit test simulating a stolen lock mid-run (two `JobLocks` holders, same DB).
- **Acceptance test:** new unit test: holder A acquires, refresh expires (TTL 0 for test),
  holder B acquires (steals), A's next `refresh()` returns false → A stands down, job settles
  exactly once (settle-once suite stays green); `npm test` green.
- **Story points:** 2.
- **Prompt(s) needed:** one fix prompt (mechanical + test).
- **Model:** Qwen.
- **Owner approval?:** NO (code + tests, normal flow).
- **Parallelizable:** YES, but prefer same track as BL-P1-5 (same module).

### BL-P1-5 — Scope `resetAll()` or document the single-instance precondition (R-2)

- **Description:** Boot runs `DELETE FROM job_locks` (global) before `recoverInFlight()`.
  Correct for one process per `data/`, destructive if a second instance ever boots against the
  same dir. Fix (preferred, cheap): replace the blanket wipe with
  `DELETE FROM job_locks WHERE holder = ? OR expires_at < now` (own + stale only); or at
  minimum document "one process per data dir" as a stated deployment invariant.
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-2; `app-context.ts` L244–258.
- **Root cause:** boot order written for single-instance without a stated invariant.
- **File/module:** `apps/server/src/app-context.ts`, `apps/server/src/domain/jobs.lock.ts`
  (add a scoped `resetMine(staleOnly)` method), `AGENTS.md`/runbook doc.
- **Production impact:** none today (single systemd unit); pre-empts a future dual-boot incident.
- **Dependencies:** none (or pair with BL-P1-4 in one commit).
- **Fix:** implement scoped reset + unit test (two holders, boot-2 clears only its own +
  expired rows, live rows of holder-1 survive) + doc note in
  `docs/operations/JOB_RECOVERY_RUNBOOK.md` §5.
- **Acceptance test:** new unit test passes; `settle-once.test.ts` +
  `worker-queue-recovery.test.ts` stay green; runbook states the invariant.
- **Story points:** 2.
- **Prompt(s) needed:** one fix prompt (mechanical + test + doc).
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES — same track as BL-P1-4 (combine into one commit).

### BL-P1-6 — Obtain SSH credentials for the production host (access request)

- **Description:** Request from the owner: SSH access (key or credential) to `172.30.0.133`
  (user TBD — s52 used `saber`), read scope first, deploy scope for the BL-P0-1 session.
- **Evidence:** `AGENT_E_DEPLOYMENT_AUDIT.md` §3 (port 22 open, no local creds).
- **Root cause:** host migration; no key provisioned on the workstation.
- **File/module:** workstation ssh config / owner secret store (NOT the repo).
- **Production impact:** gates BL-P0-1 and every host-internal verification.
- **Dependencies:** owner action.
- **Fix:** provision a dedicated deploy key (or existing key) and record the access item in
  `docs/operations/` (no secrets in the repo — key path only).
- **Acceptance test:** `ssh <user>@172.30.0.133 'echo ok && systemctl list-units --type=service | grep nlo || true'`
  succeeds read-only.
- **Story points:** 1 (owner action, not code).
- **Prompt(s) needed:** access request (owner).
- **Model:** n/a (owner action).
- **Owner approval?:** YES (granting access).
- **Parallelizable:** YES (blocking for P0, not for code).

### BL-P1-7 — Verify/prepare new-host re-deploy prerequisites

- **Description:** On 172.30.0.133 (via BL-P1-6): confirm `/home/saber` (or equivalent) layout,
  Node 22 location, git clone presence, and — critically — whether s52's `data/` (DB, vault,
  vendor/xray, sessions, backups) was migrated; if not, plan the migration (DB restore from
  backups, vault.key move, xray binary, 3 session storage-states, `NLO_PYTHON_BIN` target).
- **Evidence:** `AGENT_E_DEPLOYMENT_AUDIT.md` §4.2 (unit pre-filled for s52 paths), §7
  (s52 `data/` migration NOT-VERIFIED); `docs/deployment/s52-deploy.md` first-time setup.
- **Root cause:** decommission happened before migration completed.
- **File/module:** new host filesystem (not the repo); `deploy/systemd/nlo.service` (paths).
- **Production impact:** determines whether re-deploy is a fresh start (loses accounts/sessions/
  history) or a true continuation.
- **Dependencies:** BL-P1-6.
- **Fix:** read-only inventory on the host (systemd, paths, `data/` presence, disk space), then
  a written migration checklist executed in the deploy session.
- **Acceptance test:** written host-inventory record + migration plan; after BL-P0-1:
  `data/deployed-commit` + `/api/health/ready` `ready:true` + DB row counts match the migrated
  source (accounts ≥3, proxies rows present).
- **Story points:** 3.
- **Prompt(s) needed:** included in the deployment prompt (NEXT_PROMPT_PLAN §pre-work).
- **Model:** Qwen.
- **Owner approval?:** YES (production session).
- **Parallelizable:** NO — sequential on the host; parallel with code work.

### BL-P1-8 — Build the MCP server (P4-5 scope; tracked here for four-path parity)

- **Description:** Implement the MCP server path: `/mcp` endpoint (Streamable HTTP), tool
  registry (the 9 designed tools: `list_providers`, `create_job`, `get_job`, `get_artifact`,
  `retry_job`, `list_templates`, `get_provider_health`, …), API-token auth with per-tool
  scopes, MCP client harness in the test suite.
- **Evidence:** `AGENT_F_FOUR_PATH_AUDIT.md` §1 (no route, no registry, no harness —
  NOT-IMPLEMENTED; only ADR-005/006 + OpenAPI `kind` enum + design docs).
- **Root cause:** planned phase not yet built (by design).
- **File/module:** new `apps/server/src/api/mcp/*`; `providers/registry.ts`;
  `api/routes/` wiring; tests.
- **Production impact:** 3 of 4 acceptance doors today; MCP-dependent consumers (agents)
  cannot connect.
- **Dependencies:** BL-P2-9 sessions not required (API-token auth); P4-2 templates improve
  `list_templates` later (soft).
- **Fix:** implement per ADR-005/006; mock-level client-harness tests for every tool; live
  gate manual.
- **Acceptance test:** MCP client harness (in-repo) passes all 9 tools against the in-process
  app (mock provider); auth: no token → error envelope; wrong scope → per-tool denial;
  four-path matrix MCP column flips from NOT-IMPLEMENTED to mock-verified.
- **Story points:** 8.
- **Prompt(s) needed:** the P4-5 prompt (NEXT_PROMPT_PLAN §P4-5).
- **Model:** DeepSeek (contract/design-heavy).
- **Owner approval?:** NO (normal flow).
- **Parallelizable:** partially — shares API wiring with other phases; sequence after P4-2/3/4
  per the plan.

---

## P2 — Medium

### BL-P2-1 — Type the gateway direct-fallback sentinel (R-3)
- **Description:** Replace the string match `/no enabled proxy node configured/` in
  `gateway.ts` with a typed sentinel error (`NoEnabledNodeError`) or a `listEnabled() === 0`
  precheck, so a wording change in `proxy-manager.ts` can't silently disable the dev direct path.
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-3 (both sides read).
- **Root cause:** error-message string as the only inter-module contract.
- **File/module:** `apps/server/src/proxy/gateway.ts`, `proxy/proxy-manager.ts`.
- **Production impact:** dev-mode convenience path only (default is fail-closed).
- **Dependencies:** none.
- **Fix:** typed error + unit test (fallback triggers iff zero enabled nodes AND
  `direct-allowed` AND `allowDirect`).
- **Acceptance test:** new/updated gateway tests green; existing egress tests green.
- **Story points:** 1.
- **Prompt(s) needed:** one-line fix prompt.
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P2-2 — Standing lint fixture for the boundary exception set (R-5)
- **Description:** Turn the planted `__boundary_probe.ts` mechanism into a permanent fixture
  (e.g. a test that runs eslint over probe files asserting the intended exception set), so the
  eslint boundary rules' exceptions are asserted, not just enforced.
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-5; `AGENT_D` §3 (lint green).
- **Root cause:** enforcement exists, but the *intended* exception set has no assertion.
- **File/module:** `eslint.config.js`, `apps/server/src/providers/__boundary_probe.ts`,
  a new lint-fixture test.
- **Production impact:** architectural guardrail durability.
- **Dependencies:** none.
- **Fix:** add probe files (allowed import → passes; disallowed → fails) and a test invoking
  the linter over them.
- **Acceptance test:** new test green; a deliberately widened regex makes it red (mutation check
  in the test).
- **Story points:** 2.
- **Prompt(s) needed:** one-line fix prompt.
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P2-3 — State worker egress as a boundary guarantee in the threat model (R-4)
- **Description:** Doc change: in `docs/security/threat-model.md` (and proxy-design.md §8),
  state explicitly that worker egress is an **NLO-level boundary guarantee** (approved endpoint
  + standard proxy env), not a machine-enforced firewall inside the child process.
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-4.
- **Root cause:** doc precision gap (code is correct for the stated model).
- **File/module:** `docs/security/threat-model.md`, `docs/architecture/proxy-design.md`.
- **Production impact:** none (clarity).
- **Dependencies:** none.
- **Fix:** doc edit.
- **Acceptance test:** doc review — the guarantee's scope is explicit.
- **Story points:** 1.
- **Prompt(s) needed:** doc prompt (foldable into any P4 prompt's doc step).
- **Model:** DeepSeek (writing) — or Qwen; low stakes.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P2-4 — `.env.example` internal-IP comments (topology only)
- **Description:** Optional: replace the commented internal IPs (`172.30.0.133:4000`,
  `172.20.1.53:8043`) with placeholders, or keep and note "topology only, not credentials".
- **Evidence:** `AGENT_C_SECURITY_AUDIT.md` §3.
- **Root cause:** convenience defaults left as examples.
- **File/module:** `.env.example`.
- **Production impact:** none (no credentials).
- **Dependencies:** none.
- **Fix:** doc tweak in the example file.
- **Acceptance test:** secret-scan green; example file self-describes.
- **Story points:** 0.5.
- **Prompt(s) needed:** fold into BL-P1-1's commit (format pass) or any doc prompt.
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P2-5 — Workstation git `http.sslverify=false` hardening
- **Description:** On the workstation, set `git config --global http.sslverify true` (or at
  least verify TLS for the two known remotes) so git operations verify certificates.
- **Evidence:** `AGENT_A_GIT_BASELINE.md` §1; `AGENT_C_SECURITY_AUDIT.md` §11.
- **Root cause:** workstation-level convenience setting.
- **File/module:** workstation git config (not repo).
- **Production impact:** none (service unaffected).
- **Dependencies:** none (check no MITM proxy depends on the setting first).
- **Fix:** config change + verify `git ls-remote` still works for both remotes when reachable.
- **Acceptance test:** `git config --get http.sslverify` → `true` (or unset); remotes reachable
  when network allows.
- **Story points:** 0.5.
- **Prompt(s) needed:** one-line ops prompt.
- **Model:** Qwen.
- **Owner approval?:** YES (touches how git talks to the org remotes).
- **Parallelizable:** YES.

### BL-P2-6 — Verify Docker image build on a daemon host
- **Description:** Run the CI `docker` job (or `docker build -f Dockerfile .`) on a host with a
  Docker daemon; confirm the image builds and `HEALTHCHECK` passes.
- **Evidence:** `AGENT_D_TEST_CI_AUDIT.md` §8; `AGENT_E_DEPLOYMENT_AUDIT.md` §5.3 (no daemon
  on the workstation).
- **Root cause:** no local daemon; CI docker job gated `BUILD_DOCKER=1`.
- **File/module:** `Dockerfile`, `docker-compose.yml`.
- **Production impact:** low (production is systemd; Docker is local single-user).
- **Dependencies:** a Docker host (new host after BL-P1-6, or any).
- **Fix:** build + `docker compose up` smoke (loopback 4870) + healthcheck green.
- **Acceptance test:** image builds; container `/api/health` → 200 via compose.
- **Story points:** 2.
- **Prompt(s) needed:** one-line ops prompt (can ride the deployment session).
- **Model:** Qwen.
- **Owner approval?:** NO (local/container only).
- **Parallelizable:** YES.

### BL-P2-7 — Align in-repo phase numbering to the owner's P4-2…P4-8 (doc-only)
- **Description:** Update `docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` and
  `docs/roadmap/NLO_P4_IMPLEMENTATION_PROMPT_ROADMAP.md` so capability→phase numbering matches
  the owner's mission (P4-2 intake/templates, P4-3 sessions, P4-4 failover, P4-5 MCP,
  P4-6 retry UI, P4-7 webhooks/delivery, P4-8 live acceptance). The owner's numbering is
  authoritative.
- **Evidence:** `AGENT_F_FOUR_PATH_AUDIT.md` §5 (discrepancy table).
- **Root cause:** docs written earlier with a different split.
- **File/module:** the two docs (optionally `docs/ROADMAP_MASTER.md`).
- **Production impact:** none (clarity for the next prompts).
- **Dependencies:** none.
- **Fix:** doc edit (mapping table above).
- **Acceptance test:** each capability appears under exactly one phase number matching the
  owner's mission; prettier green on touched files.
- **Story points:** 1.
- **Prompt(s) needed:** fold into the P4-2 prompt's doc step (first phase after this mission).
- **Model:** DeepSeek (writing) or Qwen.
- **Owner approval?:** NO (docs only).
- **Parallelizable:** YES.

### BL-P2-8 — Four-path matrix doc: fix UI auth wording + note capabilities view gap
- **Description:** In `NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md` §2, correct "session + token" to the
  accurate description (UI is token-less loopback single-user, legacy `/api` surface); record
  that P4-1A's `GET /api/capabilities` has no UI view (planned view = backlog, optional).
- **Evidence:** `AGENT_F_FOUR_PATH_AUDIT.md` §3 (F-1).
- **Root cause:** doc drift.
- **File/module:** `docs/testing/NLO_FOUR_PATH_ACCEPTANCE_MATRIX.md`.
- **Production impact:** none (clarity).
- **Dependencies:** none.
- **Fix:** doc edit.
- **Acceptance test:** doc matches observed code behavior (Agent F matrix §2/§3).
- **Story points:** 0.5.
- **Prompt(s) needed:** fold into BL-P2-7's edit (same doc area).
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P2-9 — Verify the 3 stored Google sessions before the first live job
- **Description:** For each storage-state in `data/sessions/` (3 accounts): run
  `POST /api/sessions/<acc>/verify` (or the accounts health endpoint) and record the outcome;
  re-auth any that fail. Do this **before** the first live job (Runbook B step 2).
- **Evidence:** `AGENT_G_LIVE_READINESS.md` §1 (files present, validity NOT-VERIFIED);
  `AGENT_C_SECURITY_AUDIT.md` §9.
- **Root cause:** sessions age; no auto-refresh job exists.
- **File/module:** `data/sessions/*` (runtime), accounts/sessions routes.
- **Production impact:** gates live acceptance quality (a stale session mid-job creates an
  ambiguous state — exactly what settle-once is designed to avoid).
- **Dependencies:** BL-P1-2 (worker must spawn) or a production instance (BL-P0-1).
- **Fix:** verify calls (read-mostly; no job consumed); re-login via UI/cookie-import for
  failures (owner-present step).
- **Acceptance test:** all 3 accounts report valid (or documented re-auth performed) with
  timestamps recorded.
- **Story points:** 2 (owner-present).
- **Prompt(s) needed:** live-acceptance prompt (P4-8) step 1; or a small ops prompt now.
- **Model:** Qwen (execution) with owner present.
- **Owner approval?:** YES (touches Google session state; live-adjacent).
- **Parallelizable:** NO (sequential, live-adjacent).

### BL-P2-10 — Update stale docs: ROADMAP_MASTER + NLO_MASTER_EXECUTION_STATUS (P4-1 done)
- **Description:** `docs/ROADMAP_MASTER.md` L105/L114 and `docs/reports/NLO_MASTER_EXECUTION_STATUS.md`
  L15–16 still call P4-1 "PROPOSED / awaiting approval". Update to completed (with commit list
  + report link).
- **Evidence:** `AGENT_A_GIT_BASELINE.md` §5.
- **Root cause:** docs not updated at P4-1 close.
- **File/module:** the two docs.
- **Production impact:** none (clarity).
- **Dependencies:** none.
- **Fix:** doc edit.
- **Acceptance test:** docs state P4-1 implemented+tested with the 5 SHAs; prettier green.
- **Story points:** 0.5.
- **Prompt(s) needed:** fold into BL-P2-7's doc edit.
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

---

## P3 — Low

### BL-P3-1 — Extract `EgressGateway.endpointEnv()/browserProxy()` to a narrow port (R-6)
- **Description:** DIP nit: the provider calls statics on the concrete `EgressGateway` class.
  Move the two pure helpers to `@nlo/shared` (or a small `EgressEnvSource` port) so the provider
  seam is fully type-level.
- **Evidence:** `AGENT_B_ARCHITECTURE_REDTEAM.md` R-6.
- **Root cause:** convenience statics on a concrete class.
- **File/module:** `proxy/gateway.ts`, `python-worker-provider.ts`, `@nlo/shared`.
- **Production impact:** none.
- **Dependencies:** none.
- **Fix:** refactor + keep conformance C1–C6 green.
- **Acceptance test:** conformance C1–C6 PASS; lint green (boundary rules still satisfied).
- **Story points:** 1.
- **Prompt(s) needed:** fold into a later phase's refactor step (not worth its own prompt).
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P3-2 — Remove sandbox-user read (RX) on the local `.env` (Windows ACL)
- **Description:** `icacls .env /remove:g CodexSandboxUsers` (workstation hardening).
- **Evidence:** `AGENT_C_SECURITY_AUDIT.md` §3.
- **Root cause:** inherited ACL on the sandbox profile.
- **File/module:** workstation ACL (not repo).
- **Production impact:** none.
- **Dependencies:** none (confirm the sandbox doesn't need the env for dev runs; if it does,
  accept and document).
- **Fix:** icacls change.
- **Acceptance test:** `icacls .env` shows no sandbox read; dev server still boots.
- **Story points:** 0.5.
- **Prompt(s) needed:** fold into a local-ops prompt with BL-P1-2.
- **Model:** Qwen.
- **Owner approval?:** NO (local).
- **Parallelizable:** YES.

### BL-P3-3 — Extend redaction patterns or document the scope statement
- **Description:** Either add patterns for any observed new credential shapes, or keep the
  "we redact what we handle" scope statement explicit in `docs/security/threat-model.md`.
- **Evidence:** `AGENT_C_SECURITY_AUDIT.md` §4.
- **Root cause:** pattern-based redaction (inherent).
- **File/module:** `packages/shared/src/redaction.ts`, threat model.
- **Production impact:** low (log hygiene).
- **Dependencies:** none.
- **Fix:** doc statement (preferred now); patterns when a concrete need appears.
- **Acceptance test:** threat model states the scope; redaction tests stay green.
- **Story points:** 0.5.
- **Prompt(s) needed:** fold into BL-P2-3's doc prompt.
- **Model:** Qwen.
- **Owner approval?:** NO.
- **Parallelizable:** YES.

### BL-P3-4 — Shared rate-limit store (only if multi-instance ever)
- **Description:** Per-token limiter is in-memory per process; move to a shared store (SQLite
  row or similar) **only if** a multi-instance deployment is approved. Track as follow-up.
- **Evidence:** `AGENT_C_SECURITY_AUDIT.md` §8.
- **Root cause:** single-instance model.
- **File/module:** `apps/server/src/api/v1.ts`.
- **Production impact:** none today.
- **Dependencies:** a multi-instance decision.
- **Fix:** later.
- **Acceptance test:** n/a until triggered.
- **Story points:** 3 (when triggered).
- **Prompt(s) needed:** none now.
- **Model:** Qwen (later).
- **Owner approval?:** YES (when triggered).
- **Parallelizable:** n/a.

### BL-P3-5 — Record a CI run when GitHub becomes reachable
- **Description:** When the workstation (or any runner) reaches GitHub, capture one green
  Actions run (quality/conformance/secret-scan) as evidence; optionally create the GitLab
  mirror project + runner so `.gitlab-ci.yml` executes.
- **Evidence:** `AGENT_D_TEST_CI_AUDIT.md` §7.2/§8; `AGENT_A_GIT_BASELINE.md` §3.
- **Root cause:** network block + no GitLab runner yet.
- **File/module:** GitHub/GitLab (not repo), `docs/operations/gitlab-sync.md`.
- **Production impact:** CI evidence completeness.
- **Dependencies:** GitHub reachability; for GitLab: PAT from owner (per `gitlab-sync.md` §3).
- **Fix:** run + record (one screenshot/log line + SHA in a short report note).
- **Acceptance test:** recorded run SHA with green quality+conformance+secret-scan; GitLab
  checklist (gitlab-sync.md §5) fulfilled if mirror created.
- **Story points:** 1.
- **Prompt(s) needed:** small ops prompt (owner present for the GitLab PAT).
- **Model:** Qwen.
- **Owner approval?:** YES for the GitLab mirror (per dual-repo policy: infrastructure changes
  need explicit authorization).
- **Parallelizable:** YES.

### BL-P3-6 — External monitoring/alerting (optional)
- **Description:** Add an uptime ping (e.g. Healthchecks.io or a cron ping to
  `/api/health`) for the production instance once re-deployed.
- **Evidence:** `AGENT_G_LIVE_READINESS.md` §5.
- **Root cause:** not in scope yet (single-user operational service).
- **File/module:** production host cron / external service (not repo).
- **Production impact:** availability awareness.
- **Dependencies:** BL-P0-1.
- **Fix:** cron + ping target; alert channel per owner preference.
- **Acceptance test:** kill the service → alert fires within the window.
- **Story points:** 2.
- **Prompt(s) needed:** fold into the deployment prompt (optional section).
- **Model:** Qwen.
- **Owner approval?:** YES (external service choice).
- **Parallelizable:** YES (after P0).

### BL-P3-7 — Set `NLO_FFMPEG_BIN` when MP3 output is wanted
- **Description:** Local `.env` has no `NLO_FFMPEG_BIN` → transcode status `not_configured`
  (original artifact stays canonical — documented non-fatal). Set it if MP3 delivery is wanted.
- **Evidence:** `AGENT_G_LIVE_READINESS.md` §1.
- **Root cause:** not installed/configured locally.
- **File/module:** local `.env`, ffmpeg install.
- **Production impact:** none (behavior is by design).
- **Dependencies:** none.
- **Fix:** install ffmpeg + set the key + re-run one mock audio job (transcode `succeeded`).
- **Acceptance test:** a mock audio job reports transcode `succeeded` with an MP3 artifact.
- **Story points:** 1.
- **Prompt(s) needed:** fold into BL-P1-2 (local env repair) or any live-runbook session.
- **Model:** Qwen.
- **Owner approval?:** NO (local).
- **Parallelizable:** YES.

### BL-P3-8 — Release tagging convention (governance, optional)
- **Description:** No tags exist. Optionally adopt `vNLO-<phase>` tags (e.g. `vNLO-P4-1`) at
  phase close to give deployment/rollback anchors.
- **Evidence:** `AGENT_A_GIT_BASELINE.md` §1 (A-7).
- **Root cause:** no convention yet.
- **File/module:** git (repo-level).
- **Production impact:** rollback ergonomics.
- **Dependencies:** none.
- **Fix:** document the convention in `CONTRIBUTING.md`; tag `b833d89` as the P4-1 anchor
  (tag push = small externally-visible action).
- **Acceptance test:** tag exists and points at the phase-close commit; convention documented.
- **Story points:** 0.5.
- **Prompt(s) needed:** one-line governance prompt.
- **Model:** Qwen.
- **Owner approval?:** YES (tag push is externally visible).
- **Parallelizable:** YES.

---

## Sequencing note (for the next prompts)

- **Track 1 — ops (parallel, owner sessions):** BL-P1-6 → BL-P1-7 → BL-P0-1 → (BL-P2-6,
  BL-P3-6, BL-P3-5 optional).
- **Track 2 — local unblock:** BL-P1-2 (+ BL-P3-2, BL-P3-7) → BL-P2-9.
- **Track 3 — repo hygiene (fast):** BL-P1-1, BL-P1-4 + BL-P1-5 (one commit), BL-P2-10 +
  BL-P2-7 + BL-P2-8 (one doc commit), BL-P2-3/BL-P3-3 (doc commit), BL-P2-4.
- **Track 4 — product phases (one at a time):** P4-2 → P4-3 → P4-4 → P4-5 (BL-P1-8) → P4-6 →
  P4-7 → P4-8. P4-8 requires Track 1 + Track 2 done.
- **Decision item, any time:** BL-P1-3 (UUID accept-or-rotate).
