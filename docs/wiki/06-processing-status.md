# دریافت وضعیت پردازش

همه‌ی پردازش‌ها **نوبتی (asynchronous)** هستند. بعد از `POST /api/jobs`
فقط شناسه دریافت می‌کنید؛ بقیه از طریق polling است.

## وضعیت‌ها

| وضعیت                            | معنا                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| `CREATED`                        | job ثبت شد                                                  |
| `VALIDATING`                     | اعتبارسنجی ورودی                                            |
| `QUEUED`                         | در صف انتظار                                                |
| `WAITING_FOR_ACCOUNT`            | در انتظار حساب گوگل سالم                                    |
| `WAITING_FOR_PROXY`              | در انتظار نود VLESS سالم                                    |
| `RUNNING`                        | در حال پردازش (progress 0–100)                              |
| `RETRY_WAIT`                     | قبل از تلاش دوباره                                          |
| `SUCCEEDED`                      | ✅ پایان موفق                                               |
| `FAILED`                         | ❌ پایان ناموفق (به‌همراه `errorClass`/`errorMessage`)      |
| `NEEDS_ATTENTION`                | ⚠️ نتیجه مبهم — نیاز به تصمیم کاربر (`requeue` یا `cancel`) |
| `CANCEL_REQUESTED` / `CANCELLED` | لغو                                                         |

## polling

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_ab12...
```

پاسخ شامل `status`، `progress` (در حالت `RUNNING`)، `attempt` (شماره‌ی تلاش)
و در صورت موفقیت `resultProvenance` (`real` / `mock` / `unknown`) است.

روند مراحل واقعی (روی provider واقعی):

```
opening_session (10) → selecting_notebook (20) → uploading_audio (30)
→ upload_done (50) → waiting_for_processing (55) → processing_done (75)
→ executing_prompt (80) → prompt_done (95)
```

**توصیه:** polling هر 5–15 ثانیه. سقف زمان پیش‌فرض هر job 30 دقیقه است.

## رویدادها و تلاش‌ها

```bash
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../events     # timeline
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../attempts   # هر تلاش + خطاها
```

## Webhook (planned)

دریافت push به‌جای polling (webhook) **هنوز پیاده‌سازی نشده** است؛ برای
اطلاعات صفحه‌ی Webhook را ببینید.
