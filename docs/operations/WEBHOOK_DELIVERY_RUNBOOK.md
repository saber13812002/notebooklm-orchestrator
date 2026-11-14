# Webhook Delivery Runbook

Scope: operating the outbound webhook delivery system (independent of
Telegram/Bale notifications). Related:
`docs/architecture/WEBHOOK_ARCHITECTURE.md`.

## 1. Configuration (environment)

| Variable                         | Meaning                                                  | Default |
| -------------------------------- | -------------------------------------------------------- | ------- |
| `NLO_WEBHOOK_ALLOWLIST`          | Comma-separated URL prefixes allowed as endpoint targets | empty   |
| `NLO_WEBHOOK_ALLOW_LOOPBACK`     | Allow `http://127.0.0.1`/`localhost` targets (testing)   | `false` |
| `NLO_WEBHOOK_MAX_ATTEMPTS`       | Delivery attempts before dead-lettering                  | `8`     |
| `NLO_WEBHOOK_INTERVAL_MS`        | Outbox drain interval                                    | `5000`  |
| `NLO_WEBHOOK_REQUEST_TIMEOUT_MS` | Hard timeout per delivery request                        | `10000` |

Egress is **fail-closed**: a delivery whose URL fails the SSRF check
(allowlist + public-IP resolution; loopback only with the opt-in) is
dead-lettered **immediately** — the service never retries a URL the operator
did not allow.

## 2. Endpoint lifecycle (API)

```bash
# create (the secret is returned EXACTLY ONCE — store it now)
curl -s -X POST "$NLO_API_BASE/api/v1/webhooks" \
  -H "Authorization: Bearer $NLO_API_TOKEN" -H "content-type: application/json" \
  -d '{"name":"ci","url":"https://example.com/hooks/nlo","events":["job.succeeded","job.failed"]}'

# list / get / patch (rename, url, events, enabled; name unique — 409 on clash)
curl -s   "$NLO_API_BASE/api/v1/webhooks"
curl -s   "$NLO_API_BASE/api/v1/webhooks/<id>"
curl -s -X PATCH "$NLO_API_BASE/api/v1/webhooks/<id>" -d '{"enabled":false}'

# one-shot test delivery (202; synthetic "webhook.test" event)
curl -s -X POST "$NLO_API_BASE/api/v1/webhooks/<id>/test"

# delivery history + delete (204; vault entry cleaned)
curl -s "$NLO_API_BASE/api/v1/webhooks/<id>/deliveries"
curl -s -X DELETE "$NLO_API_BASE/api/v1/webhooks/<id>"
```

- Routes exist on both `/api` and `/api/v1` (v1 requires the admin scope).
- Secrets live in the vault under `webhook:<endpointId>` (AES-256-GCM); views
  expose only `hasSecret`. Rotating the secret returns a new one exactly once.
- `events`: one of `job.created`, `job.running`, `job.succeeded`, `job.failed`,
  `job.cancelled`, `job.needs_attention`; **empty list = all events**.
- Validation (zod): name 1–64, secret 16–128, URL must match `https?://`.

## 3. Delivery semantics (what the operator can rely on)

- **Outbox design**: job state changes enqueue delivery rows; the publisher
  never touches the network and never throws. A crashed server loses no
  enqueued event.
- **At-least-once delivery, exactly-once settlement**: settlement updates
  `WHERE status='pending'`, so a row is settled at most once even under
  double-drain.
- Per-tick the dispatcher drains ≤20 due rows.
- Settlement rules: 2xx → `delivered`; 408/429/5xx/network error → retry with
  exponential backoff (base 2 s ×2, cap 5 min) up to `NLO_WEBHOOK_MAX_ATTEMPTS`
  → `dead`; other 4xx → `dead` immediately (retrying a rejected payload is
  futile); SSRF check failure → `dead` immediately.
- Retries send a **byte-identical** body (the stored `payload_json`), so
  signature verification is stable across attempts.

## 4. Payload and signature verification

Headers: `x-nlo-event` (event type), `x-nlo-delivery-id`, `x-nlo-timestamp`,
and:

```text
x-nlo-signature: t=<unix-seconds>, v1=hex(hmac_sha256(secret, t + "." + rawBody))
```

Receiver check (pseudocode):

```js
const [t, v1] = sig.split(", ").map((s) => s.split("="));
const expect = crypto
  .createHmac("sha256", secret)
  .update(t + "." + rawBody)
  .digest("hex");
// require v1 === expect and |now - t| within tolerance (replay window)
```

Payload is a JSON snapshot taken at publish time: `{event, jobId, status,
errorClass, errorMessage (redacted), notebookId, sourceId, resultProvenance,
artifacts:[{id, filename, mediaType, size}], occurredAt}`. `errorMessage`
passes through the secrets redactor.

## 5. Troubleshooting

| Symptom                         | First checks                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| No delivery rows appear         | endpoint `enabled`? event filter matches the event? (empty = all)                                                |
| Row dead with SSRF error        | URL prefix in `NLO_WEBHOOK_ALLOWLIST`? loopback without opt-in?                                                  |
| Row dead after 8 attempts       | receiver logs; last HTTP status in `last_status`/`last_error`                                                    |
| Row dead immediately with a 4xx | receiver contract (path/auth on the receiver side); test with `POST …/test`                                      |
| Signature mismatch on receiver  | receiver using the **current** vault secret after a rotation; body must be the raw bytes, not re-serialized JSON |
| Delays > expected               | `NLO_WEBHOOK_INTERVAL_MS` (default 5 s) + backoff cap 5 min; ≤20 rows/tick                                       |

## 6. Verification level

Dispatch, settlement, backoff, dead-lettering, signing, SSRF gate, and the
API surface are **UNIT/INTEGRATION-VERIFIED** (`apps/server/test/webhooks.test.ts`).
Delivery to a live external receiver: **NOT TESTED** (needs an external
endpoint; run `POST …/test` as the manual check).
