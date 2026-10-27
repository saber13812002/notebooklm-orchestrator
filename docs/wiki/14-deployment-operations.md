# راهنمای استقرار و عملیات

این صفحه خلاصه‌ای عملیاتی از استقرار NLO روی سرور production (s52) و کارهای
روزمره‌ی Day-2 است. جزئیات کامل در
[`docs/deployment/s52-deploy.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/deployment/s52-deploy.md)
و [`docs/operations/README.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/operations/README.md)
در ریپوزیتوری است.

## مدل استقرار فعلی

| ویژگی          | وضعیت                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| سرور           | s52 (`172.20.1.52`) — تک‌کاربر                                                                 |
| سرویس          | systemd: `nlo`                                                                                 |
| bind           | فقط `127.0.0.1:4870` (loopback)                                                                |
| روش deploy     | git-based: `deploy/deploy.sh` — فقط commitهای `origin/main`                                    |
| داده           | `data/` (SQLite، آرشیو jobها، vault، کوکی‌ها، vendor) — git-ignored، هرگز حذف/checkout نمی‌شود |
| Docker Compose | فقط برای اجرای **محلی تک‌کاربر**؛ production روی systemd است                                   |
| دامنه/TLS      | **planned** (`nlo.ai.ismc.ir` — رکورد DNS هست، vhost/TLS هنوز)                                 |

## استقرار معمول (روی s52)

```bash
cd /home/saber/saberprojects/notebooklm-orchestrator
git fetch origin
bash deploy/deploy.sh origin/main        # یا یک SHA / tag مشخص
```

اسکریپت به‌ترتیب: fetch و resolve commit → رد کردن درختِ کثیف → backup از
`data/nlo.sqlite` + `.env` (۵ بکاپ نگه داشته می‌شود) → checkout → `npm ci`
(فقط اگر package.json تغییر کرده) → restart سرویس → verify (health، ready،
port، journal) → اجرای regression testها.

- **Dry run:** `NLO_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh <commit>` (بدون
  restart و بدون backup).
- **Rollback:** `bash deploy/deploy.sh <commit-قبلی>` (commit قبلی سالم بالای
  هر اجرا چاپ می‌شود؛ هم‌چنین در `data/deployed-commit` ذخیره است).
- **بازگردانی DB** (فوق‌العاده): stop سرویس → کپی بکاپ از `data/backups/`
  روی `data/nlo.sqlite` → start.

## چک‌لیست پس از deploy

- [ ] `systemctl is-active nlo` → `active`
- [ ] `GET /api/health` → `{"ok":true,…}`
- [ ] `GET /api/health/ready` → `ready:true`، provider و proxyRuntime موجود
- [ ] `ss -ltnp | grep 4870` → فقط یک listener
- [ ] `journalctl -u nlo --since <restart>` → خطای جدید ندارد
- [ ] تست‌های `apps/server` سبز
- [ ] `data/deployed-commit` = SHA مورد انتظار

## عملیات روزمره (Day-2)

| نیاز                  | فرمان / راه                                                       |
| --------------------- | ----------------------------------------------------------------- |
| سلامت                 | `curl http://127.0.0.1:4870/api/health`                           |
| readiness             | `curl http://127.0.0.1:4870/api/health/ready`                     |
| لاگ                   | `journalctl -u nlo -f`                                            |
| restart               | `sudo systemctl restart nlo`                                      |
| commit فعلی           | `cat data/deployed-commit`                                        |
| بکاپ                  | `data/backups/` (DB + `.env`، ۵ مورد آخر)                         |
| دسترسی از workstatioN | `ssh -N -L 4870:127.0.0.1:4870 s52` و بعد `http://127.0.0.1:4870` |

### حساب گوگل منقضی شد

کوکی‌های گوگل عمر محدود دارند. وقتی وضعیت حساب **EXPIRED** شد: در UI
«دریافت از مرورگر واقعی» (یا آپلود storage-state) → verify →
AUTHENTICATED. jobهای در صف با حساب بعدی یا پس از بازتأیید ادامه می‌یابند.

### Xray / نودهای VLESS

- باینری Xray: `data/vendor/xray/` (vendor می‌شود، هرگز در git نیست).
- نودها در DB ثبت می‌شوند (UI یا `POST /api/proxies/manual`)، نه در git.
- بدون Tانل، egress به گوگل **fail-closed** است: job fail می‌کند، ترافیک
  مستقیم ارسال نمی‌شود.

## امنیت (خلاصه برای اپراتور)

- `.env`، `data/`، `node_modules`، `data/vendor`، `data/venv` هرگز commit
  نمی‌شوند (`.gitignore` + بررسی دستی قبل از commit).
- bind فقط loopback؛ هر bind غیر-loopback **الزاماً** باید پشت reverse proxy
  با احراز هویت باشد (فاز بعدی).
- ترافیک provider فقط از Tانل تأییدشده؛ `NLO_ALLOW_DIRECT_EGRESS=false`.
- session کوکی‌ها: `0700`؛ کلید vault: `0600` (AES-256-GCM).
- جزئیات: [`SECURITY.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/SECURITY.md)
  و [`docs/security/threat-model.md`](https://github.com/saber13812002/notebooklm-orchestrator/blob/main/docs/security/threat-model.md).

## محدودیت‌های شناخته‌شده (مستقیم از audit)

- دسترسی بیرونی (domain + TLS + reverse proxy + token auth) هنوز فعال نیست.
- CI روی GitLab داخلی منتظر runner و token است (پروسیجر در
  `docs/operations/gitlab-sync.md` در ریپوزیتوری).
- تک‌نکوهه: s52؛ HA/backup بین‌سروری هنوز برنامه‌ریزی نشده است.
