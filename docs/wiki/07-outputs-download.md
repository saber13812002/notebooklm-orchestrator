# مشاهده و دانلود خروجی‌ها

وقتی job به `SUCCEEDED` رسید:

## پاسخ

پاسخ Markdown در جزئیات job (`GET /api/jobs/:id`) در بخش `result` موجود
است و در آرشیو روی `output/answer.md` ذخیره می‌شود.

## فایل‌های خروجی (artifacts)

فقط فایل‌هایی که **provider واقعاً تولید کرده** را می‌بینید — اپلیکیشن هیچ
خروجی ساختگی نمی‌سازد.

```bash
# فهرست
curl -s http://127.0.0.1:4870/api/jobs/j_ab12.../artifacts

# دانلود (فرمت content-disposition برای -OJ)
curl -s -OJ http://127.0.0.1:4870/api/jobs/j_ab12.../artifacts/<artifactId>
```

## نکته‌ی مهم درباره‌ی provider فعلی

روی provider واقعی (chat audio → answer)، خروجی **متن پاسخ** است؛ در این
روند عملیاتی، فایل downloadable جداگانه از NotebookLM برنمی‌گردد (capability
`retrieveArtifacts` روی provider واقعی `unsupported` اعلام شده و صادقانه
گزارش می‌شود). خروجی‌های Studio (پادکست/ویدیو/...) **planned** هستند
(Phase G).

## دانلود ورودی

فایل صوتی ارسالی هم قابل بازیابی است:

```bash
curl -s -OJ http://127.0.0.1:4870/api/jobs/j_ab12.../audio/download
```
