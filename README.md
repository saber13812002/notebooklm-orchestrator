# NotebookLM Orchestrator (NLO)

اپلیکیشن **تک‌کاربر** (loopback) برای مدیریت درخواست‌های «صوت + دستور» به NotebookLM،
مدیریت حساب‌های گوگل و نودهای VLESS، اجرای نوبتی کارها، آرشیو و نمایش فارسی RTL.

سرویس عملیاتی روی سرور داخلی s52 (`172.20.1.52`، سرویس `nlo`، پورت `4870`) با
اتصال واقعی NotebookLM و پردازش واقعی صوت به متن **live-verify شده** است.
هدف: محصول **API-First**، قابل‌استقرار، مستند و قابل‌اتصال به سامانه‌های ثالث.

## مستندات

- قوانین دائمی توسعه (مربوط به همه Agentها): [`AGENTS.md`](AGENTS.md)
- مشارکت: [`CONTRIBUTING.md`](CONTRIBUTING.md) · امنیت: [`SECURITY.md`](SECURITY.md) ·
  تغییرات: [`CHANGELOG.md`](CHANGELOG.md)
- شروع سریع (نصب + mock + حالت زنده + Docker): [`docs/development/quick-start.md`](docs/development/quick-start.md)
- معماری: [`docs/architecture/overview.md`](docs/architecture/overview.md)،
  [`proxy-design.md`](docs/architecture/proxy-design.md)،
  [`provider-evaluation.md`](docs/architecture/provider-evaluation.md)
- استقرار: [`docs/deployment/s52-deploy.md`](docs/deployment/s52-deploy.md)
- امنیت (threat model): [`docs/security/threat-model.md`](docs/security/threat-model.md)
- برنامه توسعه: [`docs/development/plan.md`](docs/development/plan.md)
- گزارش‌های بازرسی: [`docs/reports/`](docs/reports/) — شامل
  [`PHASE_C_LIVE_ACCEPTANCE.md`](docs/reports/PHASE_C_LIVE_ACCEPTANCE.md)
  (پذیرش زنده‌ی فاز C: استقرار `b5e9ad3` روی s52 در ۲۰۲۶-۱۰-۲۸T13:43Z؛
  OpenAPI/Swagger + auth + idempotency + نمونه‌های cURL/TS/Python تأیید شدند؛
  **شغل زنده‌ی NotebookLM انجام نشد** — دروازه‌ی region خروجی، گزارش §8.2/F7)
- مستندات مشتری (Wiki): [`docs/wiki/`](docs/wiki/)
- مستندات API (OpenAPI/Swagger/`/api/v1`/Token Auth):
  [`docs/api/README.md`](docs/api/README.md) — spec روی `/api/openapi.json`،
  Swagger UI روی `/api/docs`، مثال‌های cURL/TypeScript/Python.
- Wiki.js سازمانی: **در دست ساخت** — صفحات Markdown در `docs/wiki/` آماده
  هستند و پس از صدور دسترسی API منتشر می‌شوند (لینک واقعی پس از انتشار در
  همین فایل ثبت می‌شود).
- مخازن مرجع (فقط مرجع، اجرا نمی‌شوند): `../research/`

## معماری (سطح بالا)

```
apps/web (React+Vite, RTL) ──HTTP──▶ apps/server (Fastify + node:sqlite)
                                          │  API (zod, rate-limit, loopback)
                                          ├── domain: jobs / accounts / proxies / queue / archive
                                          ├── providers: Mock (default) | PythonWorker (live)
                                          └── proxy: EgressGuard → Xray → VLESS → NotebookLM
```

- Queue پایدار بر پایه SQLite (jobهای ناقص بعد از restart به `QUEUED` برمی‌گردند).
- Provider به‌صورت interface کپسوله شده؛ جزئیات Playwright/Python Worker هرگز
  به API و Frontend نریزیده.
- جزئیات: [`docs/architecture/overview.md`](docs/architecture/overview.md)

## پیش‌نیازها

| چیز                   | نسخه   | لازم برای                             |
| --------------------- | ------ | ------------------------------------- |
| Node.js               | ≥ 22.5 | همه (سرور + وب)                       |
| Python 3              | 3.10+  | فقط حالت زنده (venv جدا: `data/venv`) |
| Chrome/Edge روی سیستم | —      | فقط ورود تعاملی حساب گوگل             |
| Docker                | —      | جایگزین نصب Node/Python (اجرای محلی)  |

## اجرا

**ساده‌ترین راه (Docker):**

```bash
docker compose up --build -d     # UI روی http://127.0.0.1:4870
```

**بدون Docker:**

```bash
npm install
npm run build
npm run start --workspace @nlo/server   # UI + API روی http://127.0.0.1:4870
```

server همان `apps/web/dist` را با SPA fallback سرو می‌کند (یک پورت برای همه:
API + وب). مسیرهای /api در 404، envelope JSON نگه می‌مانند.
حالت پیش‌فرض **mock** است؛ حالت زنده (حساب گوگل واقعی + پراکسی Xray) در بخش
زیر و در [`docs/development/quick-start.md`](docs/development/quick-start.md) توضیح داده شده.

**توسعه:**

```bash
npm run dev          # server روی 127.0.0.1:4870 + web روی 127.0.0.1:5173 (proxy /api به server)
```

## تنظیم Environment Variables

فایل نمونه: [`.env.example`](.env.example) (کپی به `.env` برای override).
مهم‌ترین‌ها:

| متغیر                          | پیش‌فرض                | توضیح                                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `NLO_HOST`                     | `127.0.0.1`            | binding؛ غیر-loopback فقط پشت reverse proxy با احراز هویت          |
| `NLO_PORT`                     | `4870`                 | پورت HTTP                                                          |
| `NLO_DATA_DIR`                 | `./data`               | SQLite + آرشیو jobها + vault + sessionها                           |
| `NLO_PROVIDER`                 | `mock`                 | `mock` (پیش‌فرض امن) یا `python-worker` (live، صریح)               |
| `NLO_PROXY_RUNTIME`            | `mock`                 | `mock` یا `xray` (نیاز به `data/vendor/xray`)                      |
| `NLO_PYTHON_BIN`               | `python3`              | python venv کارگر برای حالت زنده                                   |
| `NLO_VAULT_KEY`                | —                      | کلید vault (hex 64 کاراکتر)؛ در نبودش فایل `0600` ساخته می‌شود     |
| `NLO_MAX_UPLOAD_BYTES`         | `209715200`            | سقف حجم آپلود صوت                                                  |
| `NLO_ALLOWED_AUDIO_EXTENSIONS` | `wav,mp3,m4a,ogg,flac` | whitelist پسوند                                                    |
| `NLO_LIVE_TESTS`               | `0`                    | درگه تست‌های زنده (فقط توسعه)                                      |
| `NLO_ALLOW_DIRECT_EGRESS`      | `0`                    | **فقط توسعه**: رفع fail-closed — در عملیات نگه‌دارید               |
| `NLO_API_AUTH`                 | `0`                    | `1` = اجبار توکن برای روت‌های غیرمعاف `/api/v1` (پیش‌فرض: اختیاری) |
| `NLO_API_RATE_LIMIT_MAX`       | `120`                  | سقف درخواست هر توکن در هر پنجره (per-token)                        |
| `NLO_API_RATE_LIMIT_WINDOW_MS` | `60000`                | طول پنجره‌ی rate limit (ms)                                        |

هیچ مقدار واقعی Secret نباید در `.env` commit شده یا در کد قرار بگیرد.

## تست‌ها

```bash
npm test             # همه workspaces (server, web, shared) — بدون شبکه، بدون Google
npm run typecheck    # بررسی تایپ همه‌ی workspaces
npm run lint         # eslint
npm run format:check # prettier
npm run build        # build وب + typecheck سرور
```

سطح‌ها: Unit / Feature-Integration / E2E (mock) / **Live** (manual gate —
هرگز در CI). تست mock اثبات اجرای واقعی NotebookLM نیست؛ شواهد live جداگانه
ثبت می‌شوند. جزئیات: [`docs/testing/`](docs/testing/) و
`apps/server/scripts/` (`e2e-live.ts`, `verify-live.ts`).

CI: GitHub Actions (lint → typecheck → test → build) و `.gitlab-ci.yml`
آماده برای GitLab داخلی.

## استقرار روی s52 (عملیات)

مسیر رسمی: git-based deploy از روی commitهای review‌شده‌ی `origin/main`:

```bash
# روی s52
cd /home/saber/saberprojects/notebooklm-orchestrator
bash deploy/deploy.sh origin/main
# rollback: ROLLBACK=1 bash deploy/deploy.sh <commit-قبلی>
```

بکاپ DB+`.env` (5 آخر)، verify کامل (health/ready/port/journal) و اجرای
تست‌های regression بعد از restart، همه داخل اسکریپت است. جزئیات:
[`docs/deployment/s52-deploy.md`](docs/deployment/s52-deploy.md) ·
[`docs/operations/`](docs/operations/)

## API

دو سطح:

- **Legacy (loopback):** Base `http://127.0.0.1:4870/api` — بدون تغییر.
- **Versioned (Phase C):** Base `http://127.0.0.1:4870/api/v1` — همان منابع +
  **OpenAPI 3.x** روی `/api/openapi.json` (و `/api/v1/openapi.json`) +
  **Swagger UI** روی `/api/docs` + **Token Auth** (اختیاری؛ با `NLO_API_AUTH=1`
  اجباری) + **per-token rate limit** + **Idempotency-Key** (روی `POST /jobs`)
  - **`x-correlation-id`** + **audit trail** (`GET /api/v1/audit`).

Envelope خطای یکنواخت: `{"error":{"code","message","details?"}}` (کدها:
`validation_error`، `unauthorized`، `forbidden`، `not_found`، `conflict`،
`rate_limited`، … در `packages/shared/src/api-error.ts`).

مستندات کامل + مثال‌های cURL/TypeScript/Python: [`docs/api/README.md`](docs/api/README.md).

| گروه    | روت‌ها                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Job     | `POST /api/jobs` (multipart: `prompt`, `title?`, `preferredAccountId?`, `preferredNodeId?` + فایل `audio`) → `201 {id, status}`؛ `GET /api/jobs` (فیلتر+pagination)؛ `GET /api/jobs/:id`؛ `…/events`؛ `…/attempts`؛ `…/artifacts`؛ `GET /api/jobs/:id/artifacts/:artifactId` (دانلود)؛ `GET /api/jobs/:id/audio` / `…/audio/download`؛ `POST /api/jobs/:id/cancel`؛ `POST /api/jobs/:id/requeue` |
| Account | `POST /api/accounts`، `GET /api/accounts`، `GET /api/accounts/:id`، `POST /api/accounts/:id/health` + روت‌های session                                                                                                                                                                                                                                                                            |
| Proxy   | `POST /api/proxies` (URI VLESS)، `POST /api/proxies/manual`، `GET /api/proxies`، `POST /api/proxies/ping-all`، `GET /api/proxies/runtime`                                                                                                                                                                                                                                                        |
| دیگه    | `GET/PUT /api/settings`، `GET /api/secrets` (redacted)، `GET /api/provider`، `GET /api/health`، `GET /api/health/ready`، `POST /api/health/account`، `POST /api/health/egress`                                                                                                                                                                                                                   |

عملیات طولانی **async** هستند: ایجاد job شناسه‌ی قابل‌پیگیری `j_<hex32>`
می‌دهد و وضعیت/رودیدار/خروجی‌ها از API قابل‌دسترسی‌اند. Webhook: **planned**
(Phase G). مدل اعتماد پیش‌فرض هنوز loopback است؛ برای مصرف‌کننده‌های بیرونی،
Token Auth روی `/api/v1` (اختیاری یا اجباری) از فاز C موجود است.

## وضعیت واقعی قابلیت‌ها (صادقانه)

| قابلیت                                                            | وضعیت                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Job audio + prompt → پاسخ (provider واقعی)                        | implemented + **live-verified**                                                                                            |
| Mock provider (توسعه آفلاین)                                      | implemented + tested                                                                                                       |
| مدیریت حساب گوگل (cookie/storage-state)                           | implemented + live-verified                                                                                                |
| Nودهای VLESS + پروکسی Xray + fail-closed egress                   | implemented + live-verified (egress guard: unit-tested)                                                                    |
| آرشیو job (manifest/timeline/artifacts) + دانلود                  | implemented + tested                                                                                                       |
| Docker (اجرای محلی)                                               | implemented (image self-contained)                                                                                         |
| استقرار git-based + rollback (s52)                                | implemented + verified on s52                                                                                              |
| OpenAPI / Swagger / `/api/v1`                                     | implemented + tested + production-smoke-verified (Phase C؛ spec↔live drift-checked؛ پذیرش زنده ۲۰۲۶-۱۰-۲۸ روی s52)         |
| Token Auth برای مصرف‌کنندگان بیرونی (scopes + rate limit + audit) | implemented + tested + verified on deployed code (Phase C؛ optional/enforced؛ حالت اجباری روی نسخه‌ی استقرارشده آزمایش شد) |
| Idempotency-Key / Correlation IDs                                 | implemented + tested + verified on deployed code (Phase C)                                                                 |
| Webhooks                                                          | **planned** (Phase G)                                                                                                      |
| انتشار API به بیرون (`nlo.ai.ismc.ir` + TLS)                      | **planned** (Phase F؛ DNS A record وجود دارد، مسیر proxy نه)                                                               |
| انتشار مستندات در Wiki.js                                         | **in progress** (محتوای Markdown در `docs/wiki/`)                                                                          |
| Google Drive / DOCX / خروجی‌های Studio / Download Manager         | **planned** (Phase G)                                                                                                      |

محدودیت‌های شناخته‌شده و وضعیت دقیق پیاده‌سازی:
[`docs/architecture/provider-evaluation.md`](docs/architecture/provider-evaluation.md) (بخش ۵).

## ایمنی — خلاصه‌ی خط‌مشی

- binding پیش‌فرض **loopback**؛ هیچ دسترسی عمومی.
- ترافیک provider **fail-closed**: بدون پروکسیِ تأییدشده، direct egress نمی‌شود (تست‌شده با mock transport).
- secretها در vault با **AES-256-GCM**؛ UUID VLESS masked؛ logها redact.
- پیش‌فرض **mock** است؛ حالت زنده فقط با انتخاب صریح (`NLO_PROVIDER=python-worker` +
  `NLO_PROXY_RUNTIME=xray`) روشن می‌شود.
- جزئیات: [`SECURITY.md`](SECURITY.md) و [`docs/security/threat-model.md`](docs/security/threat-model.md)

## حالت زنده (live mode) — ورود واقعی + پراکسی واقعی + شغل واقعی

سیستم پیش‌فرض mock اجرا می‌شود و همه‌ی خروجی‌هایش با برچسب mock نمایش داده می‌شوند.
برای اجرای **واقعی** (درخواست به NotebookLM واقعی از طریق پروکسی واقعی):

```bash
# ۱) آماده‌سازی کارگر پایتونی (یک‌بار) — venv جدا از سیستم
npm run worker:setup --workspace @nlo/server
#    → data/venv با notebooklm-py + playwright chromium

# ۲) پیکربندی
cp .env.example .env
#    NLO_PROVIDER=python-worker
#    NLO_PROXY_RUNTIME=xray
#    NLO_PYTHON_BIN=$PWD/data/venv/bin/python

# ۳) باینری Xray (یک‌بار) — در data/vendor/xray/xray
#    (خروجی رسمی xray؛ بدون آن، runtime «not_configured» گزارش می‌دهد)

# ۴) راه‌اندازی
npm run dev

# ۵) در UI: یک حساب بسازید ← «دریافت از مرورگر واقعی» (کوکی‌های نشست گوگل
#    از مرورگر خودت روی همین دستگاه خوانده و verify می‌شود) یا «ورود پیشرفته
#    (storage-state)» برای آپلود storage-state JSON
#    یک نود VLESS بسازید ← «سلامت (امتحان خروج)» و «سلامت (مقصد NotebookLM)»

# ۶) اعتبارسنجی زنده (manual gate؛ هرگز در CI اجرا نمی‌شود)
npm run verify:live --workspace @nlo/server
```

**صادقانه بودن نتیجه:** هر شغل `resultProvenance` دارد — `real` فقط وقتی خود
provider گزارش کند که خروجی واقعی است؛ `mock` برای شبیه‌ساز؛ در غیر این صورت
`unknown`. صفحه‌ی جزئیات شغل این برچسب را کنار «پاسخ» نشان می‌دهد و هیچ‌جای UI
ادعای «زنده» بدون این مدرک نمی‌کند.

## مشارکت

خونده [`AGENTS.md`](AGENTS.md) و [`CONTRIBUTING.md`](CONTRIBUTING.md). هر
تغییر: هدف مشخص، تست متناسب، به‌روزرسانی مستندات، بدون secret، Commit با
پیام شفاف. CI: lint/typecheck/test/build.
