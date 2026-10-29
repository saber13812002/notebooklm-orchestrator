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

## توکن اول (bootstrap) — فقط آفلاین روی هاست (Phase 2)

چون خودِ ایجاد توکن نیاز به توکن `admin` دارد، توکن **اول** هیچ‌گاه از
مسیر شبکه ساخته نمی‌شود (نه endpoint عمومی و نه endpoint احراز‌شده):

```bash
npm run bootstrap:admin --workspace @nlo/server
```

- **یک‌بار مصرف:** اگر حتی یک توکن فعال (enabled و غیر-lغو) وجود داشته
  باشد، اجرا رد می‌شود. از آن پس، چرخه‌ی حیات توکن فقط از طریق API با
  scope `admin` است.
- **بازیابی (documented):** همه‌ی توکن‌های فعال را لغو کنید
  (`DELETE /api/v1/tokens/:id`) و CLI را دوباره اجرا کنید. اگر نام قبلی
  هنوز توسط رکورد لغوشده اشغال است، CLI خودکار پسوندد می‌زند
  (`first-admin-2`، …).
- **نظافت secret:** متن توکن فقط یک‌بار در ترمینال اپراتور نمایش داده
  می‌شود؛ فقط هش SHA-256 ذخیره می‌شود.
- **قابل‌ردیابی:** رویداد `first_admin_bootstrapped` (فقط id توکن، هرگز
  متن) در audit log ثبت می‌شود.

فعال‌سازی احراز اجباری: توکن را امن نگهداری کنید ← `NLO_API_AUTH=1`
در env سرویس ← restart. بازگشت: `NLO_API_AUTH=0` + restart.
جزئیات کامل: [`docs/api/README.md`](../api/README.md) (بخش «First token
(bootstrap)»).

## برای مصرف‌کنندگان بیرونی

مسیر رسمی (Phase C پیاده‌سازی شد؛ Phase F برای انتشار عمومی):

1. **API Token** — tokenهای با-scope برای هر مصرف‌کننده (create/list/
   disable/revoke)؛ صدور/لغو با توکن `admin` (خودِ توکن اول فقط با
   CLI آفلاین روی هاست — بخش بالا).
2. **Reverse proxy با TLS** روی زیردامنه‌ی سازمانی + `NLO_API_AUTH=1`
   پشت آن (binding غیر-loopback فقط با reverse proxy دارای احراز هویت).
3. **Rate limiting** بر پایه‌ی token (per-token sliding window).
4. **Correlation IDs** (`x-correlation-id`) و **idempotency**
   (`Idempotency-Key` روی `POST /api/v1/jobs`) برای عملیات ایمن.

جزئیات کامل + مثال‌های cURL/TypeScript/Python: [`docs/api/README.md`](../api/README.md)
و Swagger UI روی `/api/docs`.
