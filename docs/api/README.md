# API Documentation

Status: **no machine-readable OpenAPI specification exists yet.** The
authoritative contract is the route code in `apps/server/src/api/routes/`
plus the tests in `apps/server/test/api.test.ts`.

## What exists today (unversioned `/api/*`)

See the API table in the root [`README.md`](../../README.md) for the current
endpoint list. Error envelope: `{"error": {"code": <string>, "message":
<string>}}` — codes in `packages/shared/src/api-error.ts` (`ApiCodes`).

## Planned (Phase C)

- OpenAPI 3.x specification generated from route metadata (single source of
  truth), served at `/api/openapi.json`.
- Swagger UI at `/api/docs`.
- `/api/v1` versioned prefix (current routes stay working during migration).
- API-token authentication for non-local consumers.
- Webhook events, idempotency keys, correlation IDs.
- cURL examples + sample request/response JSON + a sample client (Python or
  TypeScript) with contract tests against the running API.

Until Phase C lands, third-party consumers should treat the REST surface as
**unstable** (loopback-only trust model — see `SECURITY.md`).
