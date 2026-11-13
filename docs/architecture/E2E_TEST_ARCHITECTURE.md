# E2E Test Architecture (NLO-P1)

**Status:** implemented + unit-tested (`packages/shared/test/e2e-contract.test.ts`, 21 tests) · runner INTEGRATION-VERIFIED (executes, contract-checked) · LIVE **NOT TESTED** (no running NLO instance; see delivery report).

## 1. Principle

The E2E runner is an **external client**, not a second engine. It speaks HTTP only and observes the
existing pipeline. It never imports a repository, a queue, or a domain service of `apps/server/src`.

```
test operator ──► nlo-e2e (tsx scripts/nlo-e2e.ts)
                   │  HTTP (Bearer token from env)
                   ▼
             /api/v1  ──► Fastify routes ──► job-create* ──► queue ──► job-runner ──► provider
                   ▲                                                              │
                   └── jobs/{id}, /events, /attempts, /artifacts/{id} ◄──────────┘
```

## 2. Layering (as built)

| Layer          | File                                  | Responsibility                                                                                              |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Domain (pure)  | `packages/shared/src/e2e-contract.ts` | run/stage model, failure classification, artifact validation, acceptance verdict. No I/O, injectable clock. |
| Adapter (I/O)  | `apps/server/scripts/nlo-e2e.ts`      | HTTP calls, polling loop, digesting, report writing.                                                        |
| Contract guard | same script                           | fetches `/api/v1/openapi.json` and refuses to run if required paths are missing (`E2E_CONTRACT_MISMATCH`).  |

This keeps DDD direction correct: the adapter depends on the domain, the domain depends on nothing.

## 3. Why not a new orchestrator

The existing job engine already owns: state machine (`packages/shared/src/job-state.ts`), queue,
worker supervision, retries, recovery and artifact storage. The runner only _observes_ those through
documented endpoints, which is exactly what a third-party consumer sees.

## 4. Observable contract (verified from `apps/server/src/api/openapi/spec.ts`)

`POST /api/v1/notebooks/from-text` · `POST /api/v1/jobs` · `GET /api/v1/jobs/{id}` ·
`/result` · `/events` · `/attempts` · `/artifacts` · `/artifacts/{artifactId}` · `/audio/download` ·
`POST /jobs/{id}/cancel` · `POST /jobs/{id}/requeue` · `GET /api/v1/openapi.json` · `GET /api/docs`.

## 5. Truthfulness rules encoded in code

- `evaluateAcceptance` returns `PASS` **only** for `SUCCEEDED` + `resultProvenance === "real"` + all artifacts valid + all stages passed.
- a `mock` provenance run is always `FAIL` (never silently "PASS").
- `NEEDS_ATTENTION` maps to `BLOCKED`, not retried automatically.
- artifact acceptance requires a real download (`2xx`), non-zero size, MIME type, and (when expected) a digest match.
