# راهنمای توسعه‌دهندگان

این صفحه برای کسانی است که می‌خواهند روی خودِ کد NLO کار کنند: ساختار
پروژه، محیط توسعه، تست‌ها، و قواعدی که هر تغییر باید رعایت کند.

> مستندات داخلی کامل در خودِ ریپوزیتوری است:
> [`docs/development/quick-start.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/development/quick-start.md)،
> [`docs/architecture/overview.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/architecture/overview.md)
> و قواعد حاکمیت در [`AGENTS.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/AGENTS.md).

## ساختار monorepo

| مسیر              | توضیح                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `apps/server`     | سرور Fastify 5 — API، صف job، providerها، proxy/egress، SQLite                                |
| `apps/web`        | فرانت‌اند React 19 + Vite + Tailwind (فارسی، RTL)                                             |
| `packages/shared` | منطق مشترک: state machine، error envelope، redaction، SSRF guard، safe-name، retry، VLESS URI |
| `deploy/`         | اسکریپت استقرار s52 + unit فایلی systemd                                                      |
| `docs/`           | مستندات: architecture، development، deployment، security، testing، operations، reports        |

### معماری کلیدی (خلاصه)

- **API-first:** تمام قابلیت‌ها از مسیر `/api/*` قابل‌دسترس‌اند؛ فرانت‌اند فقط
  یک مصرف‌کننده است و مستقیم به دیتابیس یا worker دسترسی ندارد.
- **Job نوبتی:** `POST /api/jobs` → شناسه `j_<hex32>` → وضعیت با
  `GET /api/jobs/:id` (machine: CREATED → … → RUNNING → SUCCEEDED / FAILED /
  NEEDS_ATTENTION).
- **Provider:** `mock` (پیش‌فرض، بدون شبکه) یا `python-worker`
  (NotebookLM واقعی). ماتریس قابلیت در `providers/types.ts` است و هر خروجی
  برچسب `resultProvenance` (real/mock/unknown) دارد.
- **Fail-closed egress:** ترافیک provider فقط از تانل Xray/VLESS تأییدشده؛
  بدون تانل، job fail می‌کند (خطای مبهم مستقیم به گوگل نمی‌رود).

## پیش‌نیازها

| ابزار   | نسخه                       |
| ------- | -------------------------- |
| Node.js | ≥ 22.5                     |
| Python  | 3.10+ (فقط برای حالت live) |
| npm     | همراه Node                 |

## راه‌اندازی محلی (تسهیل)

```bash
git clone https://github.com/saber13812002/notebooklm-orchestrator.git
cd notebooklm-orchestrator
npm install
npm run build          # build وب
npm run start --workspace @nlo/server
```

مرورگر: **http://127.0.0.1:4870** — حالت پیش‌فرض `mock` است (بدون
درخواست واقعی). برای حالت live مراحل ۱ تا ۵ در
[`docs/development/quick-start.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/development/quick-start.md)
(venv پایتون، Xray، `.env`) را دنبال کنید.

توسعه با reload زنده: `npm run dev` (سرور 4870 + Vite 5173).

## محیط (env vars)

تمام متغیرها با پیشوند `NLO_` هستند و همه در [`.env.example`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/.env.example)
مستند شده‌اند. مهم‌ترین‌ها:

| متغیر                     | پیش‌فرض              | توضیح                                               |
| ------------------------- | -------------------- | --------------------------------------------------- |
| `NLO_HOST` / `NLO_PORT`   | `127.0.0.1` / `4870` | bind فقط loopback (امنیت)                           |
| `NLO_PROVIDER`            | `mock`               | `mock` یا `python-worker`                           |
| `NLO_PROXY_RUNTIME`       | —                    | `xray` برای حالت live                               |
| `NLO_ALLOW_DIRECT_EGRESS` | `false`              | fail-closed: بدون تانل، ترافیک مستقیم به گوگل ممنوع |
| `NLO_PYTHON_BIN`          | —                    | مسیر python داخل venv (فقط حالت بدون-Docker)        |

## تست‌ها

| سطح                 | پوشش                                                              | اجرا                               |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Unit                | state machine، redaction، SSRF guard، safe-name، retry، VLESS URI | `npm test --workspace @nlo/shared` |
| Feature/Integration | API سطح کامل، job manager، repositories، provider mock، download  | `npm test --workspace @nlo/server` |
| E2E (mock)          | فلوی کامل upload → job → result → download روی اپ in-process      | در همان `npm test`                 |
| Live                | `apps/server/scripts/verify-live.ts` / `e2e-live.ts`              | **دستی و خارج از CI**              |

اجرای همه با `npm test` (baseline فعلی: server 59، web 25، shared 44 — همه سبز).

> ⚠️ تست mock اثبات اجرای واقعی NotebookLM **نیست**. گزارش‌ها باید سطح
> تأییدشده را صادقانه بنویسند: `Unit/Integration/E2E passed` vs
> `Live verified` vs `Not tested`.

## درِ کیفیت (قبل از هر commit)

```bash
npm run typecheck      # TS همه workspaces
npm run lint           # ESLint
npm run format:check   # Prettier
npm test               # همه testها
npm run build          # build همه
```

قواعد (از [`CONTRIBUTING.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/CONTRIBUTING.md)
و [`AGENTS.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/AGENTS.md)):

- هر تغییر: هدف و scope مشخص، تست متناسب با ریسک، آپدیت مستندات مرتبط.
- **هیچ secret** (`.env`، کوکی، توکن، VLESS UUID) در git نمی‌آید.
- commit message: Conventional Commits + goal/scope.
- تغییرات مستندات/CI نباید سرویس production را restart کنند.
- استقرار production فقط با `deploy/deploy.sh` روی s52 و فقط از commitهای
  `origin/main`.

## CI

- **GitHub Actions** (`.github/workflows/ci.yml`): lint → format → typecheck →
  test → build روی Node 22.
- **GitLab** (`.gitlab-ci.yml`): هم‌راستا با GitHub Actions برای
  `git.ai.ismc.ir` (mirror داخلی).
- تست live هرگز در CI اجرا نمی‌شود (حساب واقعی گوگل، هزینه واقعی).

## محدودیت‌های فعلی (برای برنامه‌ریزی)

- API هنوز بدون نسخه (`/api` نه `/api/v1`) و بدون token auth (فاز بعدی).
- OpenAPI/Swagger هنوز تولید نمی‌شود؛ قرارداد = کد روت‌ها + `api.test.ts`.
- Webhook، Google Drive/DOCX، خروجی‌های Studio: **planned**.
- دسترسی بیرونی (domain/TLS/reverse proxy) هنوز فعال نیست؛ تا آن زمان سرویس
  فقط روی loopbackِ s52 و از طریق SSH port-forward در دسترس است.
