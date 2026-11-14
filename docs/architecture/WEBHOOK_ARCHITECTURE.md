# Webhook Delivery Architecture (NLO-P2)

**Status:** implemented + unit/integration-tested (`apps/server/test/webhooks.test.ts`, 265/265 server tests green at implementation) · delivery is **INTEGRATION-VERIFIED** against a local test receiver (loopback opt-in); real external endpoints are **NOT TESTED** in this environment.

## 1. Principle

Webhooks are an **outbox**: job events are appended to a durable
`webhook_deliveries` table at publish time; a separate dispatcher drains due
rows on a timer. The publisher **never throws** and never does network I/O —
so a webhook can never delay, fail, or lose a job. Delivery is at-least-once
with exactly-once **settlement** (a delivery flips state at most once).

Webhook delivery is **independent** of any chat channel (Telegram/Bale). It
is a generic signed HTTP push, usable by the frontend, internal systems and
third-party applications alike.

## 2. Components

| Layer      | File                                      | Responsibility                                                                                           |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Domain     | `apps/server/src/domain/webhooks.repo.ts` | endpoints + deliveries rows; `enqueue`, `due`, exactly-once `settle*` (guarded `WHERE status='pending'`) |
| Dispatcher | `apps/server/src/webhooks/dispatcher.ts`  | outbox drain, SSRF guard, fetch, backoff/dead-letter, HMAC signing                                       |
| API        | `apps/server/src/api/routes/webhooks.ts`  | endpoint CRUD, secret rotation, delivery log, manual test delivery                                       |
| Wiring     | `apps/server/src/app-context.ts`          | builds the dispatcher from config, wires `publish` into job events, `start()` at boot                    |
| Schema     | migration `0006_audio_artifacts.sql`      | `webhook_endpoints`, `webhook_deliveries` + indexes                                                      |

## 3. Publish

`dispatcher.publish(jobId, eventType)` snapshots a **real** payload from the
DB (job status, error class/message redacted, notebook/source ids,
resultProvenance, artifact list) and enqueues one pending delivery per
**matching enabled endpoint**. Endpoints filter by `events` (empty = all).
It never throws.

Emit points (job lifecycle, see `WEBHOOK_EVENTS`): `job.created`,
`job.running`, `job.succeeded`, `job.failed`, `job.cancelled`,
`job.needs_attention`. A manual `webhook.test` event is enqueued by the
`POST /webhooks/:id/test` route.

## 4. Delivery (tick)

`tick()` drains up to 20 due rows. For each:

1. **SSRF guard (fail-closed).** The destination host must match the
   operator allowlist (`NLO_WEBHOOK_ALLOWLIST`) and resolve to a public
   address; loopback targets are allowed only with the explicit
   `NLO_WEBHOOK_ALLOW_LOOPBACK=1` opt-in (local test receivers). A
   resolution that fails the guard **dead-letters immediately** — we never
   retry a URL the operator did not allow.
2. **Fetch** with a hard timeout (`NLO_WEBHOOK_REQUEST_TIMEOUT_MS`,
   default 10 s).
3. **Settle** exactly once:
   - `2xx` → `delivered`;
   - `408`/`429`/`5xx`/network error → `pending` again with exponential
     backoff (base 2 s, ×2, cap 5 min) up to `NLO_WEBHOOK_MAX_ATTEMPTS`
     (default 8), then `dead`;
   - other `4xx` → `dead` (the client rejected the payload);
   - SSRF failure → `dead` (see 1).

Settlement is exactly-once because every state flip is guarded by
`WHERE status = 'pending'`; a crashed `tick` simply leaves the row pending.

## 5. Signing & headers

Each request carries:

```
x-nlo-signature: t=<unix>,v1=hex(hmac-sha256(secret, t + "." + rawBody))
x-nlo-event:       <eventType>
x-nlo-delivery-id: <deliveryId>
x-nlo-timestamp:   <unix>
```

`rawBody` is the **stored** `payload_json`, so retries re-send a
byte-identical body and the HMAC stays verifiable. The secret is written to
the vault under `webhook:<endpointId>` and returned **exactly once** (on
create or rotate). Views expose `hasSecret`, never the value.

## 6. API surface

Registered on **both** `/api` and `/api/v1` (the v1 group maps every route to
`admin` scope):

```
POST   /api/webhooks                 → 201 { view, secret }   (secret once)
GET    /api/webhooks                 → { items, total }
GET    /api/webhooks/:id             → view
PATCH  /api/webhooks/:id             → { view, [secret] }     (rotate → secret once)
DELETE /api/webhooks/:id             → 204                    (vault cleaned)
GET    /api/webhooks/:id/deliveries  → delivery log (no payloads, no secrets)
POST   /api/webhooks/:id/test        → 202 { ok, deliveryId } (manual synthetic delivery)
```

Validation (zod): `name` 1–64 (unique), `url` must be http(s), `secret`
16–128 chars (generated when omitted), `events` a subset of `WEBHOOK_EVENTS`.

## 7. Verification level

- **UNIT-VERIFIED**: repo (enqueue/due/settle exactly-once), dispatcher
  (SSRF, backoff, dead-letter, signing, byte-identical retry) with an
  injectable `fetchImpl`/clock — no real network.
- **INTEGRATION-VERIFIED**: full CRUD + rotation + delivery log + test
  delivery against the in-process app with a local loopback receiver.
- **LIVE-VERIFIED**: not yet — requires an external, allowlisted endpoint.
