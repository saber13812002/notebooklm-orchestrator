# R1-A.3 — امن‌سازی دسترسی Neo4j رادیو (حساب اختصاصی + کمترین دسترسی)

**Mission:** RADIO-GOLIVE-2026-11 / Phase R1-A.3
**Server:** 172.20.1.53 (`llm`) — Neo4j 2025.10.1 Enterprise
**Date (UTC):** 2026-11-12
**Status:** `LIVE-VERIFIED` (۱۵/۱۵ معیار پذیرش، با یک حادثهٔ rebout مستقل از مأموریت)

---

## 1. خلاصهٔ اجرایی

حساب اختصاصی `radio_app` با نقش `radio_read` ایجاد شد که **فقط** به دیتابیس‌های `radio` و `radio-4b` دسترسی خواندن دارد. `radio_api` از طریق `.env.radio` (mode 600، gitignored) به این حساب منتقل شد و فقط همان container بازسازی شد. تمام ۱۵ آزمون پذیرش با شواهد زنده pass شدند؛ از جمله **تطابق کامل top-3 امتیاز جست‌وجوی برداری** با baseline ادمین و **رد ۱۲ دیتابیس دیگر + `system`**.

یک حادثهٔ هم‌زمان (ری‌استارت سرور و بالا نیامدن Neo4j به‌دلیل `RestartPolicy=no`) شناسایی و با **مجوز صریح کاربر** تنها با `docker start neo4j_db` بازیابی شد؛ هیچ تغییر پیکربندی انجام نشد.

---

## 2. Preflight (قبل از تغییر)

| مورد | مقدار |
|---|---|
| Neo4j | `2025.10.1` / **enterprise** / Cypher 5-25 |
| دیتابیس‌ها | ۱۴ (همه `online` در زمان اجرا) |
| کاربران | ۱ (`neo4j` → roles: `admin`, `PUBLIC`) |
| رول‌ها | ۶ پیش‌فرض |
| `radio_app` / `radio_read` | **وجود نداشتند** (صفر) |
| baseline | `radio`=79,350 · `radio-4b`=79,350 |
| stack | `radio-rag-service/docker-compose.radio.yml` (project `radio`)، env از `.env.radio` |
| تعریف کاربر | compose به‌صورت **هاردکد** `- NEO4J_USERNAME=neo4j` |
| ports | `8043→8003` (api)، `8044→80` (frontend) روی `0.0.0.0` |
| restart policy | api/frontend `unless-stopped`؛ **neo4j_db `no`** |
| backup | `R1-A2-20261112-123345` — ۲۴/۲۴ checksum OK |

---

## 3. حادثهٔ هم‌زمان (Reboot) و بازیابی

- سرور حدود 15:07 UTC ری‌استارت شد؛ `neo4j_db` با `RestartPolicy=no` بالا نیامد (`Exited (255)`).
- پیامد: `radio_api` در crash-loop (۱۱ restart)، `radio.ai.ismc.ir` → 502، سایر مصرف‌کننده‌ها بدون Neo4j.
- **اقدام (تنها با مجوز صریح):** `docker start neo4j_db` — بدون تغییر config/port/policy.
- نتیجه: healthy در ~۴۰s؛ ۱۴/۱۴ DB `online`؛ `radio_api` healthy؛ `/api/health` = `200` با `"neo4j_online":true`؛ همهٔ ۶ محصول دیگر healthy.
- **ریسک باقی‌مانده (F7):** `RestartPolicy=no` روی `neo4j_db` — رفع نیازمند **recreate** و مجوز جداگانه است.

---

## 4. طراحی اجراشده (LIVE-VERIFIED روی 2025.10.1)

```cypher
CREATE ROLE radio_read;
GRANT ACCESS ON DATABASE radio TO radio_read;
GRANT ACCESS ON DATABASE `radio-4b` TO radio_read;
GRANT MATCH { * } ON GRAPH radio TO radio_read;
GRANT MATCH { * } ON GRAPH `radio-4b` TO radio_read;
CREATE USER radio_app SET PASSWORD '<generated on server — never printed>';
ALTER USER radio_app SET PASSWORD CHANGE NOT REQUIRED;
GRANT ROLE radio_read TO radio_app;
-- hardening (پس از مشاهدهٔ نشت از PUBLIC):
GRANT SHOW INDEX ON DATABASE radio TO radio_read;
GRANT SHOW CONSTRAINT ON DATABASE radio TO radio_read;
GRANT SHOW INDEX ON DATABASE `radio-4b` TO radio_read;
GRANT SHOW CONSTRAINT ON DATABASE `radio-4b` TO radio_read;
DENY ACCESS ON DATABASE neo4j TO radio_read;
```

نکات اثبات‌شده:
- `GRANT MATCH { * }` در `SHOW PRIVILEGES` به‌صورت `match / all_properties` روی `NODE(*)` و `RELATIONSHIP(*)` ثبت می‌شود (نه `{ NODES, RELATIONSHIPS }` که در R1-A.1 به‌عنوان «تلهٔ خاموش» شناسایی شد).
- رمز با `openssl rand -hex 24` روی سرور تولید و فقط در فایل `0600` ذخیره شد؛ در هیچ لاگ/خروجی/گزارش چاپ نشد.

---

## 5. تزریق credential (بدون secret در Git)

| فایل | تغییر | وضعیت |
|---|---|---|
| `.env.radio` (mode 600، gitignored) | `NEO4J_PASSWORD=<new>`, افزودن `NEO4J_USERNAME=radio_app` | اعمال شد |
| `docker-compose.radio.yml` (tracked) | یک خط: `- NEO4J_USERNAME=neo4j` → `- NEO4J_USERNAME=${NEO4J_USERNAME:-neo4j}` | اعمال شد (diff = ۱ خط) |
| بازسازی | `docker compose -p radio -f docker-compose.radio.yml --env-file .env.radio up -d --no-deps api` | فقط `radio_api` |

- **Downtime اندازه‌گیری‌شده:** **۶ ثانیه** (تا `200`؛ بهتر از برآورد ۶۰–۹۰s چون cache pip).
- تأیید env داخل container: `NEO4J_USERNAME=radio_app` ✓ و `NEO4J_PASSWORD` جدید ✓.
- `radio_frontend` و `neo4j_db` دست‌نخورده.

---

## 6. ماتریس پذیرش ۱۵ موردی (شواهد زنده)

| # | آزمون | نتیجه | شاهد |
|---|---|---|---|
| 1 | ورود با `radio_app` | PASS | `RETURN 1` → `1` |
| 2 | دسترسی `radio` | PASS | `count(Chunk)` = **79,350** |
| 3 | دسترسی `radio-4b` | PASS | `count(Chunk)` = **79,350** |
| 4 | مقایسه با baseline | PASS | 79,350 = 79,350 (هر دو) |
| 5 | خواص node | PASS | `size(keys(n))` = **38** |
| 6 | وجود indexها | PASS | ۳ index در هر دو DB |
| 7 | جست‌وجوی برداری | PASS | ۳ hit |
| 8 | تطابق top-3 با ادمین | PASS | `0.5511904954910278 / 0.5501537322998047 / 0.5468377470970154` — یکسان |
| 9 | رد نوشتن | PASS | `CREATE` → `42NFF`؛ `SET` → `42NFF` |
| 10 | رد ۱۲ دیتابیس دیگر | PASS | همه `42NFF` |
| 11 | رد `system` | PASS | `42NA9` / `42N17` |
| 12 | خطاهای موردانتظار | PASS | `42NFF` (permission/access denied) |
| 13 | رفتار `SHOW DATABASES` جدا از دسترسی | PASS | از `-d radio`: فقط `neo4j`, `radio`, `radio-4b`, `system` |
| 14 | health رادیو | PASS | `200` + `"neo4j_online":true`, `ms:6` |
| 15 | health شش محصول دیگر | PASS | mesbah/eiis/taghrir/tasnim/sources healthy؛ ragportal Up |

### یافتهٔ امنیتی مهم

`PUBLIC` دارای `GRANT ACCESS ON HOME DATABASE TO PUBLIC` است ⇒ `radio_app` می‌توانست دیتابیس `neo4j` را بخواند (خالی، اما خارج از دامنه). با `DENY ACCESS ON DATABASE neo4j TO radio_read` مسدود شد (اکنون `42NFF`) و **health هم دست‌نخورده ماند** (verified `200`).

---

## 7. آنچه تغییر نکرد

- `neo4j` (کاربر ادمین) و رمز آن
- هیچ دیتابیس/داده‌ای (counts ثابت)
- ۶ رول پیش‌فرض و مجوزهای آن‌ها
- `neo4j_db`، `radio_frontend`، ۶ محصول دیگر
- پیکربندی Neo4j، ports، firewall (این فاز فایروال ندارد)
- پشتیبان R1-A.2 (دست‌نخورده، checksum OK)

---

## 8. Rollback

1. `.env.radio` را از `R1-A3-<TS>/config/env.radio.bak` بازگردانید (0600).
2. همان یک خط compose را به `- NEO4J_USERNAME=neo4j` برگردانید.
3. `docker compose -p radio -f docker-compose.radio.yml --env-file .env.radio up -d --no-deps api`
4. `curl localhost:8043/api/health` → انتظار `200` با `neo4j_online:true`.
5. **کاربر و رول را حذف نکنید** تا rollback تأیید شود (طبق مأموریت).

مسیر پشتیبان: `/home/saber/backups/radio/R1-A3-20261112-151647/` (`config/env.radio.bak`، `config/docker-compose.radio.yml.bak`، `neo4j/radio_app.pass` mode 600، `logs/`).

---

## 9. اثر بر Production و ریسک‌های باقی‌مانده

| مورد | وضعیت |
|---|---|
| Downtime رادیو | ۶ ثانیه (فقط `/api`) |
| سایر محصولات | بدون اثر (health-verified) |
| رمز در Git | خیر (فقط `.env.radio` mode 600 + فایل 0600 پشتیبان) |
| `RestartPolicy=no` روی neo4j_db | **باز** — نیازمند recreate با مجوز جداگانه |
| commit تغییرات سرور | **انجام نشده** — repo `rag/radio-rag-service` (branch `stage5-citations`, HEAD `e717b8f`) در فاز R1-D |
| رمز قبلی ادمین | هنوز فعال (طبق درخواست: عدم revoke در پذیرش اولیه) |

---

## 10. رگرسیون‌های یافت‌شده پس از اجرا و رفع آن‌ها (LIVE-VERIFIED)

پس از Gate A دو مشکل واقعی ظاهر شد و هر دو با مجوز صریح کاربر رفع شدند:

### 10.1 شکست `/api` از طریق فرانت‌اند و دامنه (502)

- **علامت:** `8043/api/health` = 200 اما `8044/api/health` و `https://radio.ai.ismc.ir/api/health` = **502**.
- **علت:** `radio_frontend` با `proxy_pass http://radio_api:8003;` کار می‌کند و nginx نام upstream را فقط در startup حل می‌کند (بدون `resolver`). بازسازی مجازشدهٔ `radio_api` باعث تغییر IP از `15.15.12.16` به `15.15.12.18` شد و فرانت‌اند به IP مرده وصل می‌شد:
  `connect() failed (111: Connection refused) ... upstream: "http://15.15.12.16:8003/api/health"`
- **نکتهٔ مهم:** `docker compose up -d --no-deps frontend` در این stack **no-op** است (قالب bind-mount و رندر آن در entrypoint)، بنابراین فقط `docker restart radio_frontend` قالب را بازتولید می‌کند.
- **رفع دائمی (اعمال‌شده):** در `nginx.conf` (قالب با توکن `__API_UPSTREAM__`):
  `resolver 127.0.0.11 valid=10s ipv6=off;` + `set $r13_api_upstream "__API_UPSTREAM__"; proxy_pass http://$r13_api_upstream$request_uri;`
- **اثبات:** config رندرشده داخل container: خط ۲ `resolver 127.0.0.11 valid=10s ipv6=off;` و خطوط ۳۶–۳۷ فرم متغیری.

### 10.2 `neo4j_online:false` پس از سخت‌سازی DENY

- **علامت:** health با `200` برمی‌گشت اما body: `"status":"degraded","neo4j_online":false`.
- **علت:** `api.py` در `def health()` از `_driver.session()` استفاده می‌کرد (دیتابیس پیش‌فرض `neo4j`)، که بعد از `DENY ACCESS ON DATABASE neo4j TO radio_read` مسدود است؛ کوئری‌های واقعی روی `radio` سالم بودند.
- **رفع (اعمال‌شده):** `with _driver.session(database=NEO4J_DB) as s:` — health همان دیتابیسی را می‌سنجد که اپ استفاده می‌کند.
- **اثبات:** `{"status":"ok",...,"neo4j_online":true,...}` هم مستقیم (8043)، هم از فرانت‌اند (8044) و هم از دامنه.

### 10.3 فایل‌های تغییریافته روی سرور (هنوز commit نشده — فاز R1-D)

`radio-rag-service`: `docker-compose.radio.yml` (۱ خط)، `nginx.conf` (resolver + متغیر upstream)، `api.py` (session health)، `.env.radio` (رمز/کاربر — gitignored، 0600).

---

## 11. حکم فاز

**R1-A.3 = `LIVE-VERIFIED`** — حساب اختصاصی فعال، کمترین دسترسی اثبات‌شده، نشت `neo4j` DB بسته شد، ۱۵/۱۵ پذیرش pass، Production سالم.
