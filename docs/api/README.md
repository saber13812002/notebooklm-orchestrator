# API Documentation

Status: **implemented + tested** (Phase C). The machine-readable contract is
served at **`/api/openapi.json`** and browsable at **`/api/docs`** (Swagger UI;
the same documents are mirrored at `/api/v1/openapi.json` and
`/api/v1/docs`). A contract test
(`apps/server/test/openapi-v1.test.ts`) asserts that the spec and the live
route table agree in **both directions** on every request, so drift fails CI.

Two surfaces exist:

| Surface              | Prefix      | Trust model                                  | Notes                                                                     |
| -------------------- | ----------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Legacy (unversioned) | `/api/*`    | Loopback-only (unchanged)                    | Never deletes or alters behavior; the web app still uses it.              |
| Versioned            | `/api/v1/*` | Token-aware (default: optional; enforceable) | The productized surface for external consumers. Identical resource model. |

Base URLs: `http://127.0.0.1:4870/api` (legacy) and
`http://127.0.0.1:4870/api/v1` (versioned).

## Resource overview

52 operations on `/api/v1` (jobs 11, sessions 8, accounts 7, proxies 11,
health 4, provider 1, settings 3, tokens 4, audit 1, contract 2).

- **Jobs** — `POST /jobs` (multipart), `GET /jobs` (filters
  `status,accountId,nodeId,search` + `limit/offset`), `GET /jobs/:id`,
  `GET /jobs/:id/events`, `GET /jobs/:id/attempts`, `GET /jobs/:id/artifacts`,
  `GET /jobs/:id/artifacts/:artifactId` (download),
  `GET /jobs/:id/audio`, `GET /jobs/:id/audio/download`,
  `POST /jobs/:id/cancel`, `POST /jobs/:id/requeue`.
- **Accounts** — create/list/get/patch/delete, `POST /accounts/:id/default`,
  `POST /accounts/:id/health`. `GET /accounts` returns a bare JSON array.
- **Sessions** — overview/get, `login`, `browser-import`, `import`,
  `refresh`, delete (per account).
- **Proxies** — create from VLESS URI / manual, list, get, patch, delete,
  `ping-all`, `validate`, `health`, `connectivity`, `runtime` status.
- **Meta** — `GET /health`, `GET /health/ready`, `POST /health/account`,
  `POST /health/egress`, `GET /provider`, `GET /settings`, `PUT /settings`,
  `GET /secrets` (redacted), `GET /openapi.json`, `GET /docs`.
- **Tokens & audit (v1-only)** — `POST /tokens`, `GET /tokens`,
  `PATCH /tokens/:id`, `DELETE /tokens/:id`, `GET /audit`.

Long operations are asynchronous: `POST /jobs` returns
`201 {"id":"j_<hex32>","status":"CREATED"}` and everything else is polled via
the API.

## Error envelope (both surfaces)

```json
{ "error": { "code": "not_found", "message": "job not found" } }
```

Codes (`packages/shared/src/api-error.ts`, `ApiCodes`): `validation_error`
(400), `unauthorized` (401), `forbidden` (403), `not_found` (404),
`conflict` (409), `rate_limited` (429), `invalid_state_transition` (409/422),
`ssrf_blocked` (400), `secret_not_found` (404),
`provider_unavailable` (503), `runtime_not_configured` (503),
`internal_error` (500, generic message — raw errors are never leaked).
`rate_limited` includes `details.retryAfterSeconds`.

## Authentication

### Default mode (optional, backward compatible)

The service remains a loopback single-user system. Without a token, requests
to `/api/v1/*` work exactly as before (loopback trust). **With** a valid
`Authorization: Bearer nlo_...` token, requests are attributed to that token:
scope-checked, rate-limited, and written to the audit log.

### Enforced mode (`NLO_API_AUTH=true`)

Non-exempt `/api/v1` requests **require** a valid token; anonymous requests
get `401 {"error":{"code":"unauthorized"}}` and an `auth_required` audit row.
Invalid/revoked/disabled tokens get `401` + `auth_failed` row.
Auth-exempt (always open, GET only): `/health`, `/health/ready`,
`/openapi.json`, `/docs`. The legacy `/api` surface is **never** gated —
deploy enforce mode behind an auth-capable reverse proxy for external access.

Token management (`POST /tokens`, …) is additionally **always**
token-gated with the `admin` scope, even in optional mode (defense in depth).

### Scopes

| Scope           | Grants                                                                         |
| --------------- | ------------------------------------------------------------------------------ |
| `jobs:read`     | `GET /jobs*` (list, details, events, attempts, artifacts listing)              |
| `jobs:write`    | `POST /jobs`, `POST /jobs/:id/requeue`                                         |
| `jobs:cancel`   | `POST /jobs/:id/cancel`                                                        |
| `jobs:download` | `GET /jobs/:id/artifacts/:artifactId`, `…/audio`, `…/audio/download`           |
| `meta:read`     | provider/health/settings reads + health probes                                 |
| `admin`         | everything above + accounts, sessions, proxies, `PUT /settings`, tokens, audit |

`admin` implies every other scope. Unknown `POST` paths require `admin`.

### Token lifecycle

```bash
# Create (plaintext is shown EXACTLY ONCE — store it now)
curl -s -X POST http://127.0.0.1:4870/api/v1/tokens \
  -H 'Authorization: Bearer nlo_admin_<64hex>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"svc-external","scopes":["jobs:read","jobs:write","jobs:download"]}'
# 201 { "token": { "id": "tok_<24hex>", "name": "svc-external", "scopes": [...],
#         "enabled": true, "lastUsedAt": null, "createdAt": "...", "revokedAt": null },
#       "plaintext": "nlo_svc-external_<64hex>",
#       "note": "Store the plaintext now: it is shown only once and cannot be read back." }

# Use
curl -s http://127.0.0.1:4870/api/v1/jobs -H 'Authorization: Bearer nlo_svc-external_<64hex>'

# Disable / re-enable (temporary)
curl -s -X PATCH http://127.0.0.1:4870/api/v1/tokens/tok_<24hex> \
  -H 'Authorization: Bearer nlo_admin_<64hex>' \
  -H 'Content-Type: application/json' -d '{"enabled": false}'

# Revoke (permanent)
curl -s -X DELETE http://127.0.0.1:4870/api/v1/tokens/tok_<24hex> \
  -H 'Authorization: Bearer nlo_admin_<64hex>'
```

Only the SHA-256 hash is stored. Tokens never appear in logs or responses
after creation (redaction is enforced in the shared redaction module).

### Per-token rate limiting

Sliding window per token: `NLO_API_RATE_LIMIT_MAX` (default 120) requests per
`NLO_API_RATE_LIMIT_WINDOW_MS` (default 60000). Over-budget →
`429 {"error":{"code":"rate_limited","message":"token rate limit exceeded","details":{"retryAfterSeconds":60}}}`
plus a `rate_limited` audit row. Anonymous (token-less) traffic is not
rate-limited per-token; the app-level limiter (300/min) still applies.

### Idempotent job creation

`Idempotency-Key: <8–128 chars of [A-Za-z0-9._-]>` on `POST /jobs` is honored
**only when a token is resolved** (the key is scoped per token). A replay
(same token + same key) returns the **original** job with
`200` + header `x-idempotent-replay: true` — no second job, no second
archive. Different tokens with the same key each get their own job. Malformed
keys → `400 validation_error`. The legacy surface ignores the header (always
a fresh job) — behavior unchanged.

### Correlation IDs

Every `/api/v1` response carries `x-correlation-id`: your value is echoed
(≤128 chars) or a `cr_<32hex>` is generated. The legacy surface does not set
this header.

### Audit trail

`GET /api/v1/audit?tokenId=&limit=&offset=` (admin scope; token-gated) →
`{"items":[{"id":1,"at":"...","tokenId":"tok_...","tokenName":"svc-external",
"action":"request","method":"GET","path":"/api/v1/jobs","status":200,
"detail":null,"ip":null}],"total":N}`.
Actions: `request` (any token-attributed request), `auth_required`,
`auth_failed`, `rate_limited`, `forbidden`, `token_created`,
`token_revoked`. Anonymous traffic is never audited. Token plaintexts never
appear in the log.

## Job creation (both surfaces)

Multipart form: `prompt` (required), `title?`, `preferredAccountId?`,
`preferredNodeId?`, `audio?` (file; extension whitelist
`wav,mp3,m4a,ogg,flac`, size limit `NLO_MAX_UPLOAD_BYTES`).

```bash
curl -s -X POST http://127.0.0.1:4870/api/v1/jobs \
  -H 'Authorization: Bearer nlo_svc-external_<64hex>' \
  -H 'Idempotency-Key: order-42-abc' \
  -F 'prompt=List the numbers spoken, in order' \
  -F 'title=demo' \
  -F 'audio=@numbers.wav;type=audio/wav'
# 201 {"id":"j_ab12...","status":"CREATED"}
```

Polling:

```bash
curl -s http://127.0.0.1:4870/api/v1/jobs/j_ab12... \
  -H 'Authorization: Bearer nlo_svc-external_<64hex>'
# {"id":"j_ab12...","status":"SUCCEEDED","progress":100,...,"resultProvenance":"mock"|"real"|"unknown",...}

curl -s http://127.0.0.1:4870/api/v1/jobs/j_ab12.../artifacts \
  -H 'Authorization: Bearer nlo_svc-external_<64hex>'
# [{"id":"art_...","filename":"answer.md","mediaType":"text/markdown","size":123,"source":"...","storageKey":"...","createdAt":"..."}]

curl -s -o answer.md 'http://127.0.0.1:4870/api/v1/jobs/j_ab12.../artifacts/art_...' \
  -H 'Authorization: Bearer nlo_svc-external_<64hex>'
```

## TypeScript client (runnable, no SDK dependency)

[`docs/api/examples/client.ts`](examples/client.ts) is a self-contained
client using only `fetch` — run it against a **real** running instance
(mock or live provider; no mocks inside the client):

```bash
npm run dev --workspace @nlo/server   # start the server (mock) in another shell
npx tsx docs/api/examples/client.ts http://127.0.0.1:4870
# with a token (optional in default mode):
NLO_API_TOKEN=nlo_... npx tsx docs/api/examples/client.ts http://127.0.0.1:4870
```

Core pattern (also embedded in the example file):

```ts
const base = "http://127.0.0.1:4870/api/v1";
const H = (token: string | null, extra: Record<string, string> = {}) =>
  token ? { Authorization: `Bearer ${token}`, ...extra } : extra;

const job = await (
  await fetch(`${base}/jobs`, {
    method: "POST",
    headers: H(token, { "Idempotency-Key": "order-42-abc" }),
    body: form, // FormData: prompt, title?, audio (File)
  })
).json(); // { id, status } — 200 + x-idempotent-replay on replay

// poll until terminal
while (true) {
  const cur = await (await fetch(`${base}/jobs/${job.id}`, { headers: H(token) })).json();
  if (["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"].includes(cur.status)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
```

## Python client (compact)

```python
import requests

BASE = "http://127.0.0.1:4870/api/v1"
TOKEN = "nlo_... "  # optional in default (loopback) mode

h = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}

r = requests.post(f"{BASE}/jobs", headers={**h, "Idempotency-Key": "order-42"},
                  data={"prompt": "List the numbers spoken"},
                  files={"audio": ("a.wav", open("a.wav", "rb"), "audio/wav")})
job = r.json()  # {"id": "j_...", "status": "CREATED"}

while True:
    cur = requests.get(f"{BASE}/jobs/{job['id']}", headers=h).json()
    if cur["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"):
        break
    ...
for art in requests.get(f"{BASE}/jobs/{job['id']}/artifacts", headers=h).json():
    open(art["filename"], "wb").write(
        requests.get(f"{BASE}/jobs/{job['id']}/artifacts/{art['id']}", headers=h).content)
```

## Contract & testing

- Spec: [`apps/server/src/api/openapi/spec.ts`](../../apps/server/src/api/openapi/spec.ts)
  (`buildOpenApiDocument`), served verbatim at `/api/openapi.json`.
- Contract + auth + idempotency tests:
  [`apps/server/test/openapi-v1.test.ts`](../../apps/server/test/openapi-v1.test.ts)
  (24 tests; bidirectional spec↔live drift check).
- Legacy surface regression: [`apps/server/test/api.test.ts`](../../apps/server/test/api.test.ts).
- Verification level: **Unit/Integration/E2E (in-process, mock provider)
  passed.** Live (`NLO_LIVE_TESTS`) remains a manual gate only.
