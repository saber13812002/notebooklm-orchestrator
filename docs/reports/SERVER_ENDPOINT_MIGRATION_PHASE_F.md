# Phase F — Server Endpoint Migration: Local Verification (4871)

**Date:** 2026-11-01 (UTC) · **Addendum phase:** F · **Approval:** user-approved
scope = push of Phase E commit `6b9a3ab` to `origin/main`, then Phase F
(local verification on 4871), stop before Phase G.

---

## 1. Executive summary

Verified the complete addendum tree (`3f796a6` + `30b03cd` + `6b9a3ab`,
all on `origin/main`) on the local 4871 dev server:

- 4871 restarted onto the Phase E tree (own process, verified by
  command line before termination);
- `/api/health` and `/api/health/ready` both pass
  (`ready:true`, provider `python-worker` configured, proxy runtime `xray`
  available, `liveTests:false`);
- web UI served (HTTP 200 on `/`);
- full regression re-run on the final tree: **175/175**;
- one diagnostic made during verification (transient worker
  spawn→SIGTERM on readiness) was investigated and confirmed to be the
  **designed lifecycle**, not a regression (see §5).

No production action taken. NLO is **still not deployed** on the new host
`172.30.0.133` — that is Phase G (hard approval gate). Live
`/v1/models` against the real LiteLLM proxy remains pending an LLM key
(secret store, out-of-band) — no live call was made in this phase.

## 2. Initial state

- `main` == `origin/main` @ `6b9a3ab` after the approved push
  (`30b03cd..6b9a3ab main -> main`, `0 0` in sync post-fetch).
- 4871 dev server running on the **pre-Phase-E tree** (PID 27528, plain
  tsx, log `tmp/dev4871-repro.log`); stale 4870 (PID 8380) untouched.
- Tracked tree clean; untracked scratch (`$out`, `HTTP`, `tmp/`) not staged.

## 3. Verification steps (goal + scope: prove the addendum tree runs locally)

| Step                                 | Result                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process identity check for PID 27528 | `node ... tsx ... apps/server/src/main.ts` from this workspace — **our own dev server**; safe to restart.                                                                                                                |
| Pre-restart health                   | `/api/health` → `{"ok":true,...}`; `/api/health/ready` → `ready:true`, `provider.python-worker configured`, `proxyRuntime xray available`, `liveDisabled:true`.                                                          |
| Restart 4871 onto Phase E tree       | `taskkill /PID 27528 /T /F` → SUCCESS (own process); relaunched `NLO_PORT=4871 npx tsx apps/server/src/main.ts` (log overwritten, same path).                                                                            |
| Post-restart health                  | Identical pre-restart results (`ready:true`, same provider/proxy state). Boot log: `listening on http://127.0.0.1:4871`, `provider=python-worker proxyRuntime=xray liveTests=false`, web UI served from `apps/web/dist`. |
| Web UI                               | `GET /` → HTTP 200 (490 bytes index).                                                                                                                                                                                    |
| Regression (final tree)              | **175/175** — shared 44 + server 106 + web 25.                                                                                                                                                                           |
| Stability re-check                   | Second `/api/health` + `/api/health/ready` after regression: still `ready:true`; log clean (see §5).                                                                                                                     |

## 4. Tests (level: **Unit/Integration** on the tree + **local process

verification**; NOT live)

- Full `npm test` on the final tree: **175/175** (second run after the 4871
  restart; identical to the Phase E run).
- `/api/health` + `/api/health/ready` on the running 4871 instance: pass.
- No live provider/egress calls; `NLO_LIVE_TESTS` remains `false`.

## 5. Diagnostic: worker "exited signal=SIGTERM" on readiness

The 4871 log shows, per readiness probe:

```
[nlo:worker] worker spawned pid=… python=…/data/venv/Scripts/python.exe
[nlo:worker] worker exited code=null signal=SIGTERM stderrTail=
```

**Diagnosis (verified, not a fault):**
[`validateConfiguration()`](../../apps/server/src/providers/python-worker/python-worker-provider.ts)
(lines 209–229) — invoked by `/api/health/ready` — creates a **transient**
`WorkerSupervisor`, pings it, then `await w.close()`, which terminates the
probe with SIGTERM. Empty `stderrTail` = clean exit, no worker errors.
Long-lived workers are spawned per job operation, not at boot
([`main.ts`](../../apps/server/src/main.ts) does not start workers).
The two long-lived `python.exe` processes observed on the machine
(created 2026-10-15) belong to the **stale 4870** instance (PID 8380) and
were left untouched per standing rules.

## 6. Live verification

**Not performed** (out of Phase F scope as approved). Live
`GET /v1/models` on `http://172.30.0.133:4000` still requires the LLM key
via secret store; recommend running it during Phase G pre-deploy checks.
Legacy host `172.20.1.52` remains unreachable (Phase B evidence stands);
no new probes to it were made.

## 7. Security

- All checks loopback-only (`127.0.0.1:4871`); no external exposure.
- No secrets in logs; worker stderr redaction path unchanged.
- No key was requested or accepted in chat/repo.

## 8. Deployment

- **No deployment action** (Phase G is the production-migration gate).
- `deploy/deploy.sh`, `nlo.service`, Dockerfile/compose unchanged.

## 9. Data safety

- `data/` untouched (DB, venv, sessions, vault); the 4871 restart used the
  same `dataDir` as before — no data loss, no migration.

## 10. Evidence & limitations

**Evidence:** push receipt `30b03cd..6b9a3ab`; health/ready JSON before and
after restart; boot log (`tmp/dev4871-repro.log`); regression transcript
175/175; web UI HTTP 200.

**Limitations:**

1. Live `/v1/models` on the real proxy still unverified (key pending) —
   mock-level only (Phase E).
2. NLO not on the new host yet — 4871 is the **local workstation**
   verification, not the production service.
3. Phase G specifics (systemd paths/user on new host, domain vhost/TLS,
   egress re-verification) remain open.

## 11. Blockers / required accesses (carried to G)

- New-host access: SSH to `172.30.0.133` (operator user, node path,
  `data/` placement) — needed for Phase G deployment.
- LLM API key via secret store (for the live `/v1/models` gate).
- Domain vhost/TLS for `nlo.ai.ismc.ir` on the new host.

## 12. Rollback

- 4871 restart is itself the rollback path: the previous-good commit
  (`30b03cd` or `3f796a6`) can be checked out and relaunched identically.
  No DB/schema change occurred.

## 13. Next phase proposal (Phase G — production migration)

**Hard approval gate.** Proposed G scope (each step separately approved):

1. Backup of current local `data/` before any infra work.
2. New-host prep: systemd unit paths/user, Node availability, `data/`
   placement (never in git).
3. `deploy/deploy.sh` run on the new host against a reviewed commit;
   post-deploy health/ready verification.
4. Domain vhost/TLS for `nlo.ai.ismc.ir`.
5. Live re-verification: health, egress, one mock job, and (with key)
   `/v1/models`.
6. DNS/announce only after 1–5 verified; then Phase H final audit.

## 14. Approval request

Requesting approval for: **(a)** push of the Phase F commit to
`origin/main`, and **(b)** entry to Phase G **planning only** (read-only
new-host recon) — with each production-mutating step in G requiring
separate, explicit approval before execution.
