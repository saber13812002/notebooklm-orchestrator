# راهنمای API با مثال‌های واقعی

Base URL (وضعیت فعلی): `http://127.0.0.1:4870` — فقط روی میزبان/شبکه‌ی
داخلی. دو سطح داریم:

- **قدیمی (loopback):** همه‌ی روت‌ها تحت `/api` — این بخش راهنما همین سطح
  را نشان می‌دهد و بدون تغییر کار می‌کند.
- **نسخه‌بندی‌شده (Phase C):** همان منابع تحت `/api/v1` + احراز هویت
  توکنی اختیاری + idempotency + correlation id. OpenAPI روی
  `/api/openapi.json` و Swagger UI روی `/api/docs` (و کپی‌های `/api/v1/...`).

Envelope خطا (یکنواخت در همه‌ی روت‌ها):

```json
{ "error": { "code": "validation_error", "message": "prompt is required" } }
```

کدهای رایج: `validation_error` (400)، `unauthorized` (401)، `forbidden`
(403)، `not_found` (404)، `conflict` (409)، `rate_limited` (429، همراه با
`details.retryAfterSeconds`)، `invalid_state_transition`،
`ssrf_blocked`، `internal_error` (500).

## 1) سلامت

```bash
curl -s http://127.0.0.1:4870/api/health
# {"ok":true,"service":"notebooklm-orchestrator","time":"..."}

curl -s http://127.0.0.1:4870/api/health/ready
# {"ok":true,"ready":true,"provider":{...},"proxyRuntime":{...},"liveDisabled":...}
```

## 2) ساخت job (multipart)

```bash
curl -s -X POST http://127.0.0.1:4870/api/jobs \
  -F "prompt=اعداد نام‌برده‌شده را به ترتیب لیست کن" \
  -F "title=تست اعداد" \
  -F "audio=@numbers.wav;type=audio/wav"
# 201 {"id":"j_ab12...","status":"CREATED"}
```

فیلدها: `prompt` (الزامی)، `title?`، `preferredAccountId?`،
`preferredNodeId?`، `audio?` (فایل).

## 3) وضعیت و پیگیری

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_ab12...          # وضعیت + progress + result
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../events   # timeline رویدادها
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../attempts # تلاش‌ها
```

## 4) فهرست با فیلتر و pagination

```bash
curl -s "http://127.0.0.1:4870/api/jobs?status=SUCCEEDED&limit=20&offset=0"
# فیلترهای مجاز: status, accountId, nodeId, search
```

## 5) خروجی‌ها و دانلود

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../artifacts
curl -s -OJ http://127.0.0.1:4870/api/jobs/j_ab12.../artifacts/<artifactId>
curl -s -OJ http://127.0.0.1:4870/api/jobs/j_ab12.../audio/download
```

## 6) لغو و بازآموزی

```bash
curl -s -X POST http://127.0.0.1:4870/api/jobs/j_ab12.../cancel
curl -s -X POST http://127.0.0.1:4870/api/jobs/j_ab12.../requeue   # فقط از NEEDS_ATTENTION
```

## 7) حساب‌ها و نودها (مدیریت)

```bash
curl -s http://127.0.0.1:4870/api/accounts
curl -s http://127.0.0.1:4870/api/accounts/<id>
curl -s -X POST http://127.0.0.1:4870/api/accounts/<id>/health
curl -s http://127.0.0.1:4870/api/proxies
curl -s -X POST http://127.0.0.1:4870/api/proxies \
  -H 'Content-Type: application/json' -d '{"uri":"vless://<uuid>@<node-host>:443?security=tls&type=ws&path=%2F<ws-path>&sni=<sni>"}'
curl -s -X POST http://127.0.0.1:4870/api/proxies/ping-all
```

> URI VLESS شامل UUID (secret) است؛ در پاسخ‌ها masked نمایش داده می‌شود.

## 8) نمونه‌ی کامل (upload → job → poll → download)

```bash
BASE=http://127.0.0.1:4870

ID=$(curl -s -X POST $BASE/api/jobs \
  -F "prompt=خلاصه کن" -F "audio=@a.wav;type=audio/wav" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

for i in $(seq 1 60); do
  ST=$(curl -s $BASE/api/jobs/$ID | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
  [ "$ST" = "SUCCEEDED" ] || [ "$ST" = "FAILED" ] && break
  sleep 10
done
echo "final: $ST"
curl -s $BASE/api/jobs/$ID/artifacts
```

## OpenAPI / Swagger

`/api/openapi.json` (OpenAPI 3.x) + Swagger UI روی `/api/docs` — هر دو
(و کپی‌های `/api/v1/...`) بدون احراز هویت سرو می‌شوند. قرارداد رسمی =
این spec، که با تست قرارداد (`openapi-v1.test.ts`) در هر دو جهت با روت‌های
زنده مقایسه می‌شود.

## سطح `/api/v1` (Phase C) — احراز هویت + idempotency

- توکن: `Authorization: Bearer nlo_...` (در حالت پیش‌فرض اختیاری؛ با
  `NLO_API_AUTH=1` اجباری برای روت‌های غیرمعاف).
- ساخت job با idempotency: هدر `Idempotency-Key` (فقط با توکن معتبر) —
  replay همان job اولیه را با `200` + `x-idempotent-replay: true` برمی‌گرداند.
- هر پاسخ `/api/v1` هدر `x-correlation-id` دارد (اشاره‌شده یا
  `cr_<32hex>` تولیدشده).
- مدیریت توکن‌ها: `POST/GET /api/v1/tokens`، `PATCH /api/v1/tokens/:id`
  (disable/enable)، `DELETE /api/v1/tokens/:id` (revoke) + audit روی
  `GET /api/v1/audit` — همه با scope `admin`.
- مثال‌های کامل cURL / TypeScript / Python: [`docs/api/README.md`](../api/README.md).
