# محدودیت‌ها و قابلیت‌های پشتیبانی‌شده

## قابلیت‌ها (capability matrix — از کد provider)

عملیات‌ها را هر provider به‌صورت صریح اعلام می‌کند؛ اپلیکیشن هرگز عملیات
پشتیبانی‌نشده را «موفق» گزارش نمی‌کند.

| عملیات                | Provider واقعی (python-worker)                                      | Mock                          |
| --------------------- | ------------------------------------------------------------------- | ----------------------------- |
| validateConfiguration | implemented+tested                                                  | implemented+tested            |
| getAccountStatus      | live-verified (verify واقعی)                                        | implemented+tested            |
| login (برای ورود)     | live (Playwright تعاملی، روی میزبان)                                | implemented+tested            |
| submitAudioJob        | live-verified (آپلود + سؤال واقعی)                                  | implemented+tested            |
| retrieveResult        | live-verified (پاسخ grounded)                                       | implemented+tested            |
| retrieveArtifacts     | **unsupported** (این workflow فایل جدا نمی‌سازد)                    | implemented+tested (یک نمونه) |
| cancelJob             | experimental (worker قطع می‌شود؛ عمل در حال اجرا ممکن است کامل شود) | implemented+tested            |

## محدودیت‌های عملی

| محدودیت                                  | مقدار/توضیح                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| سقف آپلود صوت                            | 200MB (پیش‌فرض؛ `NLO_MAX_UPLOAD_BYTES`)                                            |
| پسوند تأییدشده                           | فقط `.wav` verify شده است                                                          |
| زمان‌بندی job                            | پیش‌فرض 30 دقیقه سقف (per job)                                                     |
| Rate limit API                           | 300 درخواست/دقیقه (کل سرور)                                                        |
| دسترسی                                   | loopback-only؛ بدون token (وضعیت فعلی)                                             |
| ورود تعاملی گوگل                         | فقط روی میزبان (خواندن profile مرورگر واقعی)؛ داخل container: storage-state upload |
| خروجی‌های Studio (پادکست/ویدیو)          | **planned**                                                                        |
| Google Drive / DOCX sources              | **planned**                                                                        |
| Webhooks / idempotency / correlation IDs | **planned**                                                                        |

## چیزی که نیست (برای جلوگیری از سوءتفاهم)

- سیستم چندکاربر نیست (نسخه‌ی فعلی).
- خروجی‌ها «ساختگی» نیستند و نمی‌شوند: فقط فایل‌های تولیدشده‌ی provider
  نمایش داده می‌شوند.
- ترافیک به NotebookLM **فقط** از مسیر پروکسیِ تأییدشده خارج می‌شود
  (fail-closed) — بدون tunnel، job می‌شکند، نه اینکه مستقیم برود.
