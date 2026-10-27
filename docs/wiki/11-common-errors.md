# خطاهای متداول

Envelope خطا همیشه این شکل است:

```json
{ "error": { "code": "...", "message": "..." } }
```

| نشانه                                          | علت احتمالی                                          | اقدام                                                             |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `400 validation — prompt is required`          | فیلد `prompt` خالی/نبود                              | prompt بفرستید                                                    |
| `400 validation — unsupported audio extension` | پسوند خارج از whitelist (`wav,mp3,m4a,ogg,flac`)     | فرمت مجاز استفاده کنید (`.wav` تأییدشده)                          |
| `413 ... exceeds size limit`                   | فایل بزرگ‌تر از 200MB (پیش‌فرض)                      | فایل کوچک‌تر یا تنظیم `NLO_MAX_UPLOAD_BYTES` توسط مدیر            |
| `404 notFound`                                 | id اشتباه یا job حذف‌شده                             | id را از `GET /api/jobs` بگیرید                                   |
| `409 conflict`                                 | تکرار (مثلا‌ label account)                          | نام منحصربه‌فرد                                                   |
| `429 rateLimited`                              | بیش از 300 درخواست/دقیقه (پیش‌فرض)                   | polling را کندتر کنید                                             |
| job در `FAILED` با `errorClass: auth`          | session گوگل منقضی/نامعتبر                           | در UI، حساب را verify/refresh کنید                                |
| job در `FAILED` با خطای خروج                   | نود VLESS ناسالم                                     | `POST /api/proxies/ping-all` و نود سالم انتخاب کنید               |
| job در `NEEDS_ATTENTION`                       | قطع غیرمنتظره بدون نتیجه قطع‌المنازعه                | `requeue` (کوشش مجدد) یا `cancel` — retry کور انجام نمی‌شود       |
| `liveDisabled:true` در health/ready            | `NLO_LIVE_TESTS` خاموش است (فقط برای _تست‌های_ زنده) | با provider واقعی تداخل ندارد؛ provider در همان پاسخ گزارش می‌شود |

## اصول عیب‌یابی

1. `/api/health/ready` را ببینید — provider و proxyRuntime هرکدام صادقانه
   گزارش می‌دهند (`configured`/`issues`/`state`).
2. `events` و `attempts` job — محل دقیق خطا در timeline است.
3. `resultProvenance` — اگر `mock` دیدید، سرویس روی provider شبیه‌ساز است
   (`NLO_PROVIDER=mock`).
4. لاگ سرور (میزبان): `journalctl -u nlo` — secretها redact شده‌اند.
