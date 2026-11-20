# Agent B — Architecture Red Team (NLO-P4-1.1)

- **Agent role:** Architecture Red Team (DeepSeek)
- **Mode:** independent read-only code audit; executed sequentially in a separate context (no true
  subagents in this harness — see CONSOLIDATED report §parallelism).
- **Executed:** 2026-11-17 ~16:00–16:25 UTC, repo HEAD `b833d89`.
- **Method:** full reads of the P4-1 surface (`jobs.lock.ts`, `gateway.ts`, `registry.ts`, `queue.ts`,
  `job-runner.ts` key sections, `app-context.ts`, `providers/types.ts`, `eslint.config.js`,
  `python-worker-provider.ts` egress sections, migration `0007`), then adversarial questioning of the
  P4-1 report's claims. Mock-provider test runs count as **MOCK-E2E-VERIFIED** only; nothing live was
  executed by this agent.

---

## 1. The 13 required questions

### Q1. Is the codebase genuinely modular after P4-1?

**Yes — at the module level, with enforced seams.** `providers/` no longer knows about proxy internals
(boundary rules in [`eslint.config.js`](eslint.config.js:1): `providers/**` may not import `domain/jobs*`,
`queue/*`, or `domain/stages.repo.js`; `queue/*` + `domain/jobs*` + `domain/stages` may not import `proxy/*`
except the two seams `proxy/gateway.js` / `proxy/egress.js`, enforced via negative-lookahead regex).
The seams are **type-level imports** (e.g. `python-worker-provider.ts` imports `EgressGateway` for its
static helpers `endpointEnv`/`browserProxy` and the `EgressEndpoint` type; the *instance* is injected
through the constructor in [`app-context.ts`](apps/server/src/app-context.ts)). The rules are enforced by
CI (lint job) and were verified to trigger on a planted probe file. **CODE-VERIFIED** (rule text) +
**UNIT-VERIFIED** (lint run, Agent D §3). Residual: enforcement is convention-by-linter, not by build —
a new import path added to the exception regex weakens the seam silently (see R-5).

### Q2. Is dependency inversion actually present?

**Mostly yes.** The job runner depends on the *interface* `NotebookLMProvider`
([`providers/types.ts`](apps/server/src/providers/types.ts)) plus an injected `JobLocks` and
`EgressGateway` — it never constructs a provider. `app-context.ts` is the composition root (explicit
selection: `config.provider === "python-worker" ? new PythonWorkerProvider({egressGateway: gateway, …})
: new MockProvider()`). The provider depends on the *abstraction* `EgressGateway` (static helpers +
injected instance), not on `ProxyManager`/`ProxyRuntime` (type-only re-exports from `gateway.ts` are the
declared boundary). **Inversion gap:** `PythonWorkerProvider` still calls `EgressGateway.endpointEnv()`
statically — a static call to a concrete class, which is a mild DIP violation (it couples the provider to
the *type* `EgressGateway` rather than a narrow `EgressEnvSource` port). Low severity; see R-6.

### Q3. Can a new provider be added without touching core (queue/runner)?

**Yes.** The runner talks to `ProviderJobRequest` / `ProviderJobResult` / `ProviderFailure` in
`providers/types.ts` and to the registry for the capability matrix. A new provider = new file under
`providers/` + registration at the composition root. The eslint boundary rules already cover
`providers/**` generically. **CODE-VERIFIED** by reading `app-context.ts` (single construction point) and
`job-runner.ts` (no provider-specific `instanceof` checks in the run path — failure classes come from the
provider's own `ProviderFailure.failureClass`). One caveat: `app-context.ts` itself is "core" and must be
touched to *select* the new provider (one line) — that is acceptable composition-root coupling, not a
leak.

### Q4. Is there a single egress path for provider traffic?

**At the NLO process level: yes.** All provider operations that need network go through
`EgressGateway.acquire()` → `selectAuto()` (proxy manager) → loopback xray tunnel; the worker process is
given `HTTP(S)_PROXY/ALL_PROXY = http://127.0.0.1:<localPort>` via
`EgressGateway.endpointEnv(endpoint)` (`python-worker-provider.ts` L288/L343/L394/L473/L649). No job-path
code opens a direct socket to the provider host: `runJob` **fails closed** when `req.endpoint` is null and
`allowDirect` is false (L426–431), and the runner acquires the endpoint *before* the provider call
(`job-runner.ts` L212–215). **CODE-VERIFIED.**
**But:** "single path" is enforced at the *orchestrator* boundary, not inside the worker: the Python worker
inherits the proxy env, yet a misbehaving library inside the worker that ignores `HTTPS_PROXY` would dial
directly (e.g. some HTTP clients). The env-var mechanism is the contract; it is not machine-enforced inside
the child process. This matches the documented threat model ("enforced at NLO level"), but it should be
stated as a **boundary guarantee**, not a process guarantee. See R-4.

### Q5. Can a job still dial directly (bypassing the tunnel)?

Three distinct direct-dial surfaces, each with a different gate — all **CODE-VERIFIED**:

1. **Jobs:** never, unless the operator sets `NLO_ALLOW_DIRECT_EGRESS=1` (then the gateway may hand out a
   `direct-allowed` outcome and `allowDirect` lets the runner proceed). Default = fail-closed.
2. **Gateway direct fallback:** `gateway.ts` downgrades to direct only when `policy === "direct-allowed"`
   **AND** the proxy-manager error message matches `/no enabled proxy node configured/` **AND**
   `allowDirect` is true. Fragile string coupling — see R-3.
3. **Auth ops (login/verify/cookie-import):** `python-worker-provider.ts` `acquireAuthEndpoint()` applies
   the same fail-closed rule; the *cookie-jar disk read* is documented as a direct local read (no tunnel)
   with an explicit `routingNote` returned to the API client (sessions route L298–299). Honest and
   documented.

### Q6. Is the job lock safe across processes (SQLite)?

**Yes for the acquire/steal semantics.** `acquire()` is a single atomic
`INSERT … ON CONFLICT(job_id) DO UPDATE SET … WHERE job_locks.holder = excluded.holder OR
job_locks.expires_at < excluded.acquired_at` followed by a read-back `this.holder(jobId) ===
this.holderId` ([`domain/jobs.lock.ts`](apps/server/src/domain/jobs.lock.ts)). SQLite serializes writers,
so the upsert + read-back pair is safe from two processes: exactly one read-back can see its own holder
(the loser's read-back returns the winner's holder → returns `false` → loser stands down;
`job-runner.ts` L155–159). `release()`/`refresh()` are owner-guarded
(`WHERE job_id=? AND holder=?`) so a slow old holder cannot delete or extend a lock it no longer owns.
The steal condition `expires_at < acquired_at(now)` means a lock is stealable only after TTL expiry.
**CODE-VERIFIED** + schema in `db/migrations/0007_job_locks.sql` (PK `job_id`, `ON DELETE CASCADE`,
index on `expires_at`).

### Q7. Is lock expiration/ownership correct?

Mechanically correct: TTL default 40 min (`DEFAULT_LOCK_TTL_MS`), `MIN_JOB_TIMEOUT_MS` 30 min,
`LOCK_MARGIN_MS` 10 min — the lock outlives the job by margin, so a *healthy* holder is never stolen
mid-job. Ownership is per-process `process:<pid>:<uuid>`, unique per boot. **However** two hazards
remain — see Q8/Q9 and R-1/R-2.

### Q8. Is crash recovery correct (restart with in-flight jobs)?

Boot order in [`app-context.ts`](apps/server/src/app-context.ts) L244–258:
`lock.resetAll()` → `jobs.recoverInFlight()` → `queue.start()`.
`recoverInFlight()` re-queues jobs stuck in non-terminal states (P1 behavior, existing), and
`resetAll()` clears all lock rows **before** the worker starts, so the recovering process can re-acquire.
For the **single-instance systemd model this is correct**: after a crash, the only process alive is the
restarting one, so wiping its (stale) locks and re-acquiring is safe. **CODE-VERIFIED.**
**Hazard (multi-instance):** `resetAll()` is `DELETE FROM job_locks` — it is *global*, not scoped to "locks
I own" or "locks expired". If a second instance ever boots against the same `data/` directory while the
first is still running, the second's boot wipes the first's live locks and both can drive the same job
(dual-run of one job = duplicate provider work, possible duplicate artifacts). See R-2. This does **not**
affect the current single-instance deployment (one systemd unit, one `data/`), but it must be a stated
precondition: **one process per data dir.**

### Q9. Is the fused/worker path honest (no silent mock fallback)?

**Yes — strongly.** `NLO_PROVIDER=python-worker` selects the python worker explicitly; `app-context.ts`
has no fallback branch to mock (the ternary is explicit; mock is the *default*, never a fallback).
Provenance is computed from the provider's own report: `sim === true ? "mock" : sim === false ? "real"
: "unknown"` (`job-runner.ts` L396) — an unknown simulation flag yields `"unknown"`, not `"real"`.
Mock provider is never *reported* as real (its descriptor name is `mock`, and the conformance runner
C-checks this). **CODE-VERIFIED** + **UNIT-VERIFIED** (conformance C1–C6, Agent D §4).

### Q10. Are responsibilities clear (no god modules)?

Largely yes. `job-runner.ts` (1226 lines) is the largest module and owns the full job lifecycle:
lock, gateway, provider call, retries, terminal emission. It is cohesive (one responsibility: "run one
job"), but dense. `app-context.ts` (290 lines) is the composition root and owns nothing else.
`gateway.ts` (174) owns acquisition only (release is idempotent via WeakSet). `queue.ts` (74) owns only
polling/dispatch. Repositories own only SQL. The web app talks only to `/api/*` (verified in Agent F).
**CODE-VERIFIED** by line-count + import inspection. Minor: `job-runner.ts` also handles artifact
validation orchestration — acceptable given artifact recording is part of "settling" a job, but it is a
candidate for extraction if P4-2 grows it.

### Q11. Circular dependencies?

**None in the P4-1 seam graph.** Direction of imports: `queue/ → providers/ (types only) + proxy/gateway +
domain/jobs.lock`; `providers/ → proxy/gateway (seam) + domain (repos via constructor injection in
app-context)`; `proxy/ → domain/proxies.repo` (manager persistence); `domain/ → db` only. The eslint
boundary rules exist *because* the graph was flattened to make it acyclic; the lint gate would catch a new
cycle that crosses a boundary (it catches cross-boundary cycles; a *within*-`queue/` cycle is not
covered — minor). **CODE-VERIFIED** (import inspection) + **UNIT-VERIFIED** (lint green, Agent D §3).

### Q12. Is this "real DDD" or a folder split?

**Honest answer: DDD-lite / modular monolith with a domain layer, not full DDD.** There is a
`domain/` of repositories with clear ubiquitous language (Job, Account, Artifact, WebhookEndpoint,
SecretVault), a state machine in shared (`job-state.ts`, unit-tested), and value objects in
`@nlo/shared` (safe names, retry policy, SSRF guard). What is *not* present: bounded-context modeling
with context maps, aggregates with invariant enforcement beyond the SQL layer, or domain events
(webhook "events" are outbox rows, not in-process domain events). Calling it "real DDD" would
overstate; calling it "folder split" would understate — the **enforced seams (eslint boundary rules +
type-level provider contract + composition root)** are the load-bearing architectural decision, and they
are real and tested. **Verdict: modular monolith, DDD-flavored, seam-enforced.**

### Q13. Red-team verdict on `resetAll()` / `recoverInFlight()` / `acquire()` / `release()`

Covered in Q6–Q8. Findings R-1…R-6 below.

---

## 2. Red-team findings

### R-1 (P1, design) — `refresh()` return value is ignored

`job-runner.ts` L181: `locks?.refresh(jobId, this.lockTtlMs());` — the boolean is discarded. Scenario: a
job runs past its 40-min lock TTL (possible: `NLO_JOB_TIMEOUT_MS` can be configured above the default
lock TTL if operator sets it, or a wedged provider call stalls the loop). Another instance acquires via
the steal condition; the *original* holder is still alive inside the loop and keeps driving the provider
call → **two holders for one job** (double-drive). In the current single-instance deployment the steal
source can only be the *same* holder after a restart — and a restarted process has a fresh holderId, so
its `refresh()` would fail the owner check (no-op, correct) — meaning the *current* holder, if the same
process, keeps its lock (owner match, refresh succeeds). The risk is therefore **latent, multi-instance
only**, but the ignored return is a classic "fire and forget" that should at minimum log a warning and
stand down (like `acquire()`'s `false` path does at L155–159).
**Evidence:** `job-runner.ts` L181 vs L155–159 (acquire's return *is* checked and acts as stand-down).
**CODE-VERIFIED.** Fix: on `refresh() === false`, treat as lock loss: stop the current attempt, emit
terminal/`RETRY_WAIT` without side effects, release nothing (not owner).

### R-2 (P1, design) — `resetAll()` is global, not scoped

`DELETE FROM job_locks` at every boot (`app-context.ts` L247). Correct today (single instance per
`data/` dir), destructive in a future multi-instance / dual-boot scenario (second boot kills the first's
live locks). **Prerequisite to document:** one process per data dir, or change boot to
`DELETE FROM job_locks WHERE holder LIKE 'process:<my-pid>:%'` (own locks) + `… WHERE expires_at < now`
(stale locks) instead of a blanket wipe. **CODE-VERIFIED** (read at L244–258).

### R-3 (P2, fragility) — gateway direct-fallback couples to an error *string*

`gateway.ts`: the downgrade to direct happens when the proxy-manager error **message** matches
`/no enabled proxy node configured/`. A wording change in `proxy-manager.ts` silently disables the
documented dev-mode direct path (or, worse, a new unrelated message could match if it reuses the phrase).
The string is the only contract between two modules. **CODE-VERIFIED** (both sides read; the message is
produced in `proxy-manager.ts`). Fix: a typed sentinel (e.g. `NoEnabledNodeError`) or an explicit
`listEnabled() === 0` precheck.

### R-4 (P2, boundary guarantee) — worker egress is env-var-enforced

`EgressGateway.endpointEnv()` sets `HTTP(S)_PROXY/ALL_PROXY`/`NO_PROXY` on the child worker
(`python-worker-provider.ts` L473 etc.). Inside the child, a library that bypasses proxy env vars would
dial direct. The guarantee is: **NLO never *gives* the worker a job without an approved endpoint
(fail-closed) and the standard proxy env is the routing contract.** This is documented and matches the
threat model; it is a boundary, not a machine-level firewall. Acceptable for v1; if strictness is needed
later, the worker could bind to the tunnel as its *only* egress (e.g. run under a `tproxy` namespace or
route through a local forward proxy it cannot disable). **CODE-VERIFIED.**

### R-5 (P2, seam maintenance) — exception regex in eslint boundary rules

`eslint.config.js` uses regex patterns with negative lookaheads to whitelist `proxy/gateway.js` /
`proxy/egress.js` as the only `proxy/*` imports allowed from queue/domain. Adding a new legitimate seam
file requires editing the regex; forgetting to add it fails the build (good), but a too-broad fix
(`proxy/*.js`) would silently widen the boundary. No test asserts the *intended* exception set (the
planted-probe file `providers/__boundary_probe.ts` used during P4-1D exists for this purpose and should
be kept in-tree or turned into a lint fixture test). **CODE-VERIFIED.**

### R-6 (P3, DIP nit) — static `EgressGateway.endpointEnv()` calls in the provider

`python-worker-provider.ts` calls `EgressGateway.endpointEnv(endpoint)` / `.browserProxy(endpoint)`
statically. These are pure functions on `EgressEndpoint`; they don't touch proxy internals, but they are a
compile-time dependency on the concrete gateway class. Extracting them to a small port (or to
`@nlo/shared` as pure helpers on the endpoint shape) would make the seam fully type-level. Low value,
low cost. **CODE-VERIFIED.**

---

## 3. Claim-by-claim adjudication of the P4-1 report

| P4-1 report claim | Adjudication |
|---|---|
| Provider registry isolates provider choice | **CONFIRMED** (composition root single point; Agent B Q3) |
| Single egress gateway, fail-closed | **CONFIRMED** with boundary caveat R-4 |
| Durable job locks, settle-once | **CONFIRMED** with R-1/R-2 latent multi-instance caveats |
| Boundary rules enforced in CI | **CONFIRMED** (lint green; probe-file mechanism) |
| "No direct dial in job path" | **CONFIRMED** at NLO boundary; env-contract inside worker (R-4) |
| Mock never masquerades as real | **CONFIRMED** (provenance ternary + conformance C-checks) |

No P4-1 architectural claim was found to be **false**; all caveats are latent/design-level, not current
misbehavior.

## 4. What this agent did NOT verify

- Live (real NotebookLM) behavior of the seams — not in scope (mock level only).
- Performance of the lock upsert under write contention (SQLite single-writer; contention unmeasured —
  no workload justifies measurement at current scale).
- The web app's internal layering (Agent F covers the API surface).
