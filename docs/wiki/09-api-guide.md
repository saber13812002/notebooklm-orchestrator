# راهنمای API با مثال‌های واقعی

Base URL (وضعیت فعلی): `http://127.0.0.1:4870` — فقط روی میزبان/شبکه‌ی
داخلی. همه‌ی روت‌ها تحت `/api` هستند (بدون نسخه؛ `/api/v1` در فاز بعدی).

Envelope خطا (یکنواخت در همه‌ی روت‌ها):

```json
{ "error": { "code": "validation", "message": "prompt is required" } }
```

کدهای رایج: `validation` (400)، `notFound` (404)، `conflict` (409)،
`rateLimited` (429)، `tooLarge` (413).

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

**planned** (Phase C): `/api/openapi.json` + Swagger UI روی `/api/docs`.
تا آن زمان، قرارداد رسمی = کد روت‌ها + تست‌های `apps/server/test/api.test.ts`.
