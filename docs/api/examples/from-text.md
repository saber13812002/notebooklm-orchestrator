# H1 text-to-notebook — cURL examples

Runnable examples for **`POST /notebooks/from-text`** (H1). Base URL = a
running instance: local dev convention `http://127.0.0.1:4871`
(`NLO_PORT=4871`; see `README.md`), production `http://127.0.0.1:4870`. The
legacy surface (`/api/…`) is identical except `correlationId` is `null` and
`Idempotency-Key` is ignored; the examples below use the versioned surface
(`/api/v1/…`).

When auth is enabled (`NLO_API_AUTH=true`), every call needs the token:

```bash
export NLO_API_TOKEN='nlo_<64hex>'   # then add:  -H "Authorization: Bearer $NLO_API_TOKEN"
```

## 1) Submit a text job → `202`

```bash
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Authorization: Bearer nlo_...' \
  -H 'Idempotency-Key: memo-2026-08-01' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "جلسه ۱۴۰۴/۰۸/۰۱",
    "text": "بررسی بودجه و برنامه‌ی اجرایی سه‌ماهه‌ی اول؛ نتیجه: تصویب با دو اصلاح.",
    "metadata": { "language": "fa" },
    "summary": { "enabled": true }
  }'
# 202 {
#   "jobId": "j_ab12…", "status": "CREATED", "correlationId": "cr_…",
#   "createdAt": "2026-…", "statusUrl": "/api/v1/jobs/j_ab12…"
# }
```

- `text` is **required** (non-empty, ≤ `NLO_MAX_TEXT_CHARS`, default 200,000
  code points). `title` (≤200 chars) is optional — when absent it is derived
  from the first non-empty line of the text. `summary.prompt` is optional —
  when omitted the versioned master prompt (`v1`) is used; `summary.enabled`
  defaults to `true`.
- `Idempotency-Key` (8–128 chars of `[A-Za-z0-9._-]`) is honored **only with
  a token**; replay → `200` + `x-idempotent-replay: true` (no second job).
  Malformed key → `400 validation_error`.

## 2) Poll the job → `200`

```bash
curl -s http://127.0.0.1:4871/api/v1/jobs/j_ab12… \
  -H 'Authorization: Bearer nlo_...'
# {"id":"j_ab12…","status":"SUCCEEDED","progress":100,...}
# terminal statuses: SUCCEEDED | FAILED | CANCELLED | NEEDS_ATTENTION
```

## 3) Fetch the consolidated result → `200`

```bash
curl -s http://127.0.0.1:4871/api/v1/jobs/j_ab12…/result \
  -H 'Authorization: Bearer nlo_...'
# {
#   "jobId": "j_ab12…", "status": "SUCCEEDED",
#   "notebook": { "id": "nb-…", "title": "…", "url": null, "shareUrl": null },
#   "source": { "id": "src-…" },
#   "summary": { "text": "…", "promptVersion": "v1" },
#   "provenance": "mock"   # "mock" | "real" | "unknown"
# }
```

Before `SUCCEEDED`: `notebook`/`source`/`summary` are `null`,
`provenance: "unknown"`. Unknown job → `404 not_found`. `url`/`shareUrl` are
**never fabricated** — `null` until a real provider confirms them.

## 4) Validation errors → `400`

Verified **2026-11-06 against 127.0.0.1:4871** (read-only subtask — these
fail at validation: **no job is created, no provider is touched**):

```bash
# (a) empty text -> 400 validation_error
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Content-Type: application/json' -d '{"text":""}'
# {"error":{"code":"validation_error","message":"request validation failed",
#  "details":["String must contain at least 1 character(s)"]}}

# (b) whitespace-only text -> 400 validation_error
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Content-Type: application/json' -d '{"text":"   "}'
# {"error":{"code":"validation_error","message":"text is required"}}

# (c) body without `text` -> 400 validation_error
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Content-Type: application/json' -d '{}'
# {"error":{"code":"validation_error","message":"request validation failed",
#  "details":["Required"]}}

# (d) oversized text (> NLO_MAX_TEXT_CHARS, default 200000) -> 400 validation_error
node -e "require('fs').writeFileSync('big.json', JSON.stringify({ text: 'x'.repeat(250001) }))"
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Content-Type: application/json' --data @big.json
# {"error":{"code":"validation_error","message":"text exceeds maximum length",
#  "details":{"maxTextChars":200000,"charCount":250001}}}

# (e) malformed Idempotency-Key -> 400 validation_error (checked before any job)
curl -s -X POST http://127.0.0.1:4871/api/v1/notebooks/from-text \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: short' -d '{"text":"hello"}'
# {"error":{"code":"validation_error",
#  "message":"Idempotency-Key must be 8-128 chars of [A-Za-z0-9._-]"}}
```

Known quirk: a request with `Content-Type: application/json` but **no body at
all** returns `400` with
`{"error":{"code":"internal_error","message":"An unexpected error occurred."}}`
— Fastify's "Body cannot be empty" error is not mapped to `validation_error`.
It is still a 400; clients should treat it as a validation failure. The
envelope-code mapping is a server-side fix tracked separately.
