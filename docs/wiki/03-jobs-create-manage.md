# ایجاد و مدیریت Job

Job کوچک‌ترین واحد پردازش است: یک prompt + یک فایل صوتی (اختیاری) که به
NotebookLM ارسال می‌شود.

## ایجاد job

`POST /api/jobs` — فرمت **multipart/form-data**:

| فیلد                 | نوع  | الزامی | توضیح                                                            |
| -------------------- | ---- | ------ | ---------------------------------------------------------------- |
| `prompt`             | text | ✅     | دستوری که NotebookLM باید اجرا کند                               |
| `title`              | text | —      | عنوان اختیاری برای آرشیو                                         |
| `preferredAccountId` | text | —      | قفل روی یک حساب گوگل خاص (در غیر این صورت انتخاب خودکار)         |
| `preferredNodeId`    | text | —      | قفل روی یک نود VLESS خاص                                         |
| `audio`              | file | —      | فایل صوتی (whitelist پسوند: wav, mp3, m4a, ogg, flac؛ سقف 200MB) |

مثال:

```bash
curl -s -X POST http://127.0.0.1:4870/api/jobs \
  -F "prompt=اعداد نام‌برده‌شده را به ترتیب لیست کن" \
  -F "title=تست" \
  -F "audio=@recording.wav;type=audio/wav"
```

پاسخ `201`:

```json
{ "id": "j_ab12...", "status": "CREATED" }
```

شناسه‌ها server-generated هستند (`j_<hex32>`، `acc_...`، `node_...`)؛ هرگز
از ورودی کاربر ساخته نمی‌شوند.

## مدیریت

| عمل                               | Endpoint                                                      |
| --------------------------------- | ------------------------------------------------------------- |
| فهرست jobها (فیلتر + pagination)  | `GET /api/jobs?status=SUCCEEDED&limit=50&offset=0&search=...` |
| جزئیات                            | `GET /api/jobs/:id`                                           |
| timeline رویدادها                 | `GET /api/jobs/:id/events`                                    |
| تاریخچه تلاش‌ها                   | `GET /api/jobs/:id/attempts`                                  |
| لغو                               | `POST /api/jobs/:id/cancel` (فقط در حالت‌های فعال)            |
| بازآموزی بعد از `NEEDS_ATTENTION` | `POST /api/jobs/:id/requeue`                                  |
| ورودی صوتی (پیش‌نمایش)            | `GET /api/jobs/:id/audio`                                     |
| دانلود ورودی صوتی                 | `GET /api/jobs/:id/audio/download`                            |

## چرخه‌ی عمر (state machine)

```
CREATED → VALIDATING → QUEUED → WAITING_FOR_ACCOUNT → WAITING_FOR_PROXY
        → RUNNING → (RETRY_WAIT →) SUCCEEDED | FAILED | NEEDS_ATTENTION
RUNNING/RETRY_WAIT/WAITING_* → CANCEL_REQUESTED → CANCELLED
```

- `NEEDS_ATTENTION`: نتیجه مبهم (مثلاً worker وسط عمل قطع شده) — با retry کور
  پیش نمی‌رود؛ باید با `requeue` یا `cancel` توسط کاربر حل شود.
- هر job `resultProvenance` دارد: `real` (خروجی واقعی provider)، `mock`
  (شبیه‌ساز)، `unknown`. UI و گزارش‌ها ادعای «زنده» بدون این برچسب نمی‌کنند.
