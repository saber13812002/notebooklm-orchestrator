# API Authentication

## وضعیت فعلی (صادقانه)

مدل اعتماد پایه: سرور فقط روی `127.0.0.1` (loopback) گوش می‌کند — مرز اعتماد،
خودِ دستگاه/شبکه‌ی داخلی است. این طراحی برای **تک‌کاربر** است و «سرویس
داخلی» جایگزین کنترل دسترسی نیست.

**از فاز C به بعد، احراز هویت توکنی روی سطح `/api/v1` پیاده‌سازی و
تست‌شده است:**

- **حالت پیش‌فرض (اختیاری):** درخواست‌ها بدون توکن (loopback) مثل قبل کار
  می‌کنند؛ اگر هدر `Authorization: Bearer nlo_...` ارسال شود، درخواست به
  توکن مربوطه اسناد می‌شود (بررسی scope، rate limit، ثبت در audit log).
- **حالت اجباری (`NLO_API_AUTH=1`):** همه‌ی درخواست‌های غیرمعاف `/api/v1`
  بدون توکن معتبر با `401` رد می‌شوند (معاف‌ها: `GET /health`،
  `GET /health/ready`، `GET /openapi.json`، `GET /docs`). سطح قدیمی
  `/api` (بدون نسخه) هرگز گیت نمی‌شود.
- **Scopes:** `jobs:read`، `jobs:write`، `jobs:cancel`، `jobs:download`،
  `meta:read` و `admin` (شامل همه). مدیریت توکن‌ها همیشه scope `admin` می‌خواهد.
- **Rate limit هر توکن:** پیش‌فرض ۱۲۰ درخواست در دقیقه
  (`NLO_API_RATE_LIMIT_MAX` / `NLO_API_RATE_LIMIT_WINDOW_MS`).
- **حفظ امن:** فقط SHA-256 هش توکن ذخیره می‌شود؛ متن توکن یک‌بار هنگام
  ایجاد نمایش داده می‌شود و هرگز در لاگ/پاسخ‌ها ظاهر نمی‌شود.
- **Audit trail:** رویدادهای `request`، `auth_required`، `auth_failed`،
  `rate_limited`، `forbidden`، `token_created`، `token_revoked` از
  `GET /api/v1/audit` (admin) قابل‌استعلام‌اند. ترافیک بدون توکن ثبت نمی‌شود.

## برای مصرف‌کنندگان بیرونی

مسیر رسمی (Phase C پیاده‌سازی شد؛ Phase F برای انتشار عمومی):

1. **API Token** — tokenهای با-scope برای هر مصرف‌کننده (create/list/
   disable/revoke)؛ صدور/لغو با توکن `admin`.
2. **Reverse proxy با TLS** روی زیردامنه‌ی سازمانی + `NLO_API_AUTH=1`
   پشت آن (binding غیر-loopback فقط با reverse proxy دارای احراز هویت).
3. **Rate limiting** بر پایه‌ی token (per-token sliding window).
4. **Correlation IDs** (`x-correlation-id`) و **idempotency**
   (`Idempotency-Key` روی `POST /api/v1/jobs`) برای عملیات ایمن.

جزئیات کامل + مثال‌های cURL/TypeScript/Python: [`docs/api/README.md`](../api/README.md)
و Swagger UI روی `/api/docs`.
