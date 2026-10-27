# Webhook Integration

> **وضعیت: planned — هنوز پیاده‌سازی نشده است.** این صفحه طرح مورد نظر را
> توصیف می‌کند؛ از این قابلیت استفاده نکنید.

## طرح (Phase C/G)

وقتی job به وضعیت پایانی رسید (یا رویدادهای دیگر)، سرور یک POST JSON به
URL ثبت‌شده‌ی مصرف‌کننده ارسال می‌کند:

```json
{
  "event": "job.succeeded",
  "jobId": "j_ab12...",
  "status": "SUCCEEDED",
  "occurredAt": "2026-10-27T12:00:00Z",
  "signature": "sha256=..."
}
```

- **امضا:** HMAC (کلید secret هر webhook) در هدر — مصرف‌کننده **باید**
  امضا را verify کند.
- **retry:** با backoff برای چند دقیقه/ساعت؛ بعد از کوشش‌های ناموفق،
  webhook به `failed` می‌رود و قابل مشاهده است.
- **rota رویدادها (پیشنهادی):** `job.created`, `job.running`,
  `job.succeeded`, `job.failed`, `job.cancelled`, `job.needs_attention`.
- **ایمنی:** URL webhook باید HTTPS باشد (SSRF-guard روی آدرس‌های
  loopback/داخلی اعمال می‌شود).

## جایگزین فعلی

Polling روی `GET /api/jobs/:id` (هر 5–15 ثانیه) — تنها روش رسمی امروز.
