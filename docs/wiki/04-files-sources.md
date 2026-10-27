# دریافت فایل و مدیریت Source

## آپلود فایل صوتی (Source)

فایل صوتی به‌عنوان **source** مستقیم با خود job آپلود می‌شود (فیلد `audio` در
`POST /api/jobs`). مراحل داخلی:

1. اعتبارسنجی پسوند (whitelist) و حجم (سقف 200MB پیش‌فرض، قابل تنظیم).
2. محاسبه‌ی SHA-256 و ذخیره در آرشیو job با نام امن تولیدشده‌ی سرور
   (نام اصلی فایل کاربر فقط در manifest نگهداری می‌شود — هیچ‌گاه به‌عنوان
   مسیر استفاده نمی‌شود).
3. ارسال به NotebookLM توسط provider (با عنوان منحصربه‌فرد برای جلوگیری از
   تکرار؛ idempotency anchor).

## فرمت‌ها

| پسوند                           | وضعیت                                                 |
| ------------------------------- | ----------------------------------------------------- |
| `.wav`                          | تأییدشده روی provider واقعی (live-verified)           |
| `.mp3`, `.m4a`, `.ogg`, `.flac` | مجاز از نظر extension؛ **verify نشده** روی NotebookLM |

## آرشیوی هر job

```
data/jobs/<job-id>/
  manifest.json          # snapshot پیکربندی + ورودی + hash فایل‌ها
  input/prompt.md
  input/original-audio   # نام ایمن روی disk
  execution/timeline.jsonl
  execution/attempts.json
  execution/errors.json
  output/answer.md
  output/artifacts/...
```

## منابع دیگر (Google Drive, DOCX)

**planned** — هنوز پیاده‌سازی نشده‌اند. تا آن زمان، تنها source ورودی،
آپلود مستقیم فایل صوتی با خود job است.
