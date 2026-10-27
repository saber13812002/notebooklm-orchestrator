# شروع سریع

## ۱) اتصال

در وضعیت فعلی، سرویس روی سرور داخلی و فقط روی `127.0.0.1:4870` دسترس‌پذیر
است. دسترسی مستقیم از خارج شبکه داخلی **وجود ندارد** (در دست راه‌اندازی است؛
پیگیری از طریق مسئول عملیات).

پس از اتصال به محیط میزبان:

```bash
# سلامت سرویس
curl -s http://127.0.0.1:4870/api/health
# انتظار: {"ok":true,"service":"notebooklm-orchestrator",...}

curl -s http://127.0.0.1:4870/api/health/ready
# انتظار: "ready":true و provider/proxyRuntime پیکربندی‌شده
```

## ۲) اولین job

```bash
curl -s -X POST http://127.0.0.1:4870/api/jobs \
  -F "prompt=این صوت را خلاصه کن" \
  -F "audio=@demo.wav;type=audio/wav"
```

پاسخ:

```json
{ "id": "j_6568c109d989bc430be9453f7e9008f9", "status": "CREATED" }
```

## ۳) پیگیری

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_6568c109...
```

وضعیت‌ها: `CREATED → QUEUED → RUNNING → SUCCEEDED` (یا `FAILED`،
`CANCELLED`، `NEEDS_ATTENTION`). جزئیات: صفحه‌ی «دریافت وضعیت پردازش».

## ۴) دریافت پاسخ

وقتی job به `SUCCEEDED` رسید:

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_6568c109.../artifacts
curl -s -OJ http://127.0.0.1:4870/api/jobs/j_6568c109.../artifacts/<artifactId>
```

> **نکته صدا:** فرمت تأییدشده‌ی `.wav` است؛ `.mp3/.m4a/.ogg/.flac` از نظر
> extension مجازند اما روی provider واقعی **verify نشده**اند.
