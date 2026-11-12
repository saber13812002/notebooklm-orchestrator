# RADIO R1-A-Security — رادیو معارف: ممیزی امنیتی Neo4j، طراحی اصلاح احراز هویت و سخت‌سازی شبکه

> **مأموریت:** R1-A-Security (Read-only + مستندسازی + آماده‌سازی) — هدف: (۱) بررسی کامل و
> اثبات‌محور وضعیت امنیتی Neo4j روی `172.20.1.53`، (۲) طراحی اصلاح رمز (Credential
> Remediation)، (۳) طراحی سخت‌سازی شبکه، (۴) برنامهٔ Backup و Rollback — **بدون اجرا**.
> هر تغییر عملیاتی (رمز، کاربر، پورت، Firewall، Container، Backup) مستلزم **مجوز جداگانه**
> است و در این مأموریت **صفر مورد اجرا شد**.
>
> **تاریخ و زمان بررسی:** 2026-11-11، از 06:22 UTC (آغاز Re-baseline پس از تأیید اتمام
> کار موازی) تا حدود 08:05 UTC.
> **مدت مجاز:** فقط A0 تا A6 در محدودهٔ بررسی/مستندسازی/آماده‌سازی.
> **رعایت‌شده:** هیچ Change در Production/DB/رمز/Firewall/Docker انجام **نشده**. هیچ
> Commit/Push/Restart/Deploy انجام **نشده**. هیچ POST به `/api/chat` ارسال **نشده**.
> هیچ Backup اجرا **نشده**. هیچ Secret کامل در این گزارش **نیست** (فقط نام متغیر +
> وضعیت masked + hash پیشوندی).
> **برچسب‌های وضعیت:** `VERIFIED` · `PARTIALLY VERIFIED` · `NOT VERIFIED` · `BLOCKED` · `FIXED` · `NOT IMPLEMENTED`

---

## 1. خلاصهٔ اجرایی (Executive Summary)

**یافتهٔ اصلی (Critical/High): اعتبارسنجی Neo4j در سطح پلتفرم با یک رمز ضعیف و
شناخته‌شده فعال است.** هر سه لایهٔ مسیر اعتبار — فایل `.env.radio`، محیط اجرای
`radio_api` و `NEO4J_AUTH` خود `neo4j_db` — با یک **hash مشترک** اثبات شد که هر
سه همان **Placeholder قالب** (`your_neo4j_password_here`) را حمل می‌کنند. این فقط
مشکل Radio نیست: **همهٔ APIهای پلتفرم** (mesbah/eiis/taghrir/tasnim/sources/
ragportal) با کاربر `neo4j` و همان رمز ضعیف به یک Neo4j مشترک (۱۴ دیتابیس آنلاین)
اتصال دارند.

**یافتهٔ دوم (High): دروازه‌های Neo4j روی `0.0.0.0` منتشرند و از چهار نقطهٔ
مواضع (localhost، IP لانی 53، edge 133، workstation لانی شرکت) بازند** — شامل UI
مرورگری 7474 (HTTP 200) و bolt 7687. فایروال هاست به دلیل نبود دسترسی root قابل
مشاهده نبود (`BLOCKED`)؛ اما `ss` روی هاست نشان داد در لحظهٔ نمونه‌برداری **هیچ
فرآیند هاست** این پورت‌ها را نگه نمی‌داشت و **کل ترافیک زندهٔ bolt از شبکهٔ
داخلی Docker** (فقط ۵ Container API) بود. این یعنی محدودسازی 7474/7687 به
`127.0.0.1` یا حذف publish، بدون قطع هیچ مصرف‌کنندهٔ زنده‌ای ممکن است.

**یافتهٔ سوم (Medium): Neo4j مشترک بین محصولات است** — تغییر رمز کاربر `neo4j`
روی همهٔ محصولات اثر می‌گذارد؛ اما راه‌حل پیشنهادی (کاربر اختصاصی `radio_app` + نقش
محدود Enterprise RBAC) بدون دست زدن به اعتبار مشترک، فقط Radio را به اعتبار
جدید و محدودتحرک می‌رساند.

**یافتهٔ چهارم (Near-miss، داخلی): در حین این ممیزی یک خطای اسکریپت (backreference
در sed) باعث شد مقادیر واقعی متغیرهای `.env.radio` یک‌بار در ترمینال خود
اپراتور چاپ شوند.** هیچ افشای خارجی نبود (ترمینال متعلق به مالک اعتبارهاست)، اما
به‌عنوان رویداد ثبت می‌شود و چرخش توکن‌های متاثر پیشنهاد شده (بخش 10، یافته F5).

**حکم نهایی: `NOT READY` برای اجرای اصلاحات بدون مجوزها — ولی `READY WITH
CAVEATS` برای عبور به R1-B**؛ ریسک‌های امنیتی ثبت‌شده **موجود، شناخته‌شده و
خوش‌طراحی‌شدهٔ قابل‌رفع** هستند و R1-B (Nginx/HTTPS) با این وضعیت هم قابل انجام
است، به شرط اینکه Change A و Change B این گزارش پیش از یا بلافاصله پس از R1-B
اجرا شوند. جدول پایانی در بخش «جدول پایانی وضعیت» و درخواست مجوزها در بخش 21.

**توقف اجباری:** این مأموریت در همین‌جا متوقف می‌شود. منتظر مجوز جداگانه برای
Change A (احراز هویت)، Change B (شبکه) و سپس R1-B.

---

## 2. وضعیت اولیهٔ زیرساخت (Initial Infrastructure State)

| فیلد | 172.20.1.53 (`llm`) | 172.30.0.133 (`AI-TOOLS`) |
|---|---|---|
| OS | Ubuntu 24.04.5 | Ubuntu 24.04.4 |
| Uptime | 14 روز | 10 روز |
| CPU/RAM/Disk | 40c / 117Gi / 1.5T (79% پر — 310G آزاد) | 20c / 78Gi / 686G (38% پر) |
| Docker | 29.1.3 / Compose 2.40.3 | فعال (btpanel) |
| سرویس‌های اصلی | tailscaled، ollama، gitlab-runner، iranseda-dashboard، check_mk | nginx 1.31.4، btpanel، mysqld، php-fpm، gitlab-runner، **nlo.service**، certbot (timer فعال) |
| IPv4 | 172.20.1.53/24 + bridgeهای 15.15.x + tailscale0 `100.72.7.26` — **IPv4 عمومی قابل مشاهده ندارد** | 172.30.0.133/24 (+ بقیه بر اساس R1-A) |
| SSH | `PermitRootLogin yes` (یافتهٔ سخت‌سازی عمومی — خارج از اسکوپ این مأموریت) | `PermitRootLogin yes` (همان‌طور) |
| DNS/Edge | بدون سرویس DNS | `185.213.10.25` → NAT به 133 (بر اساس R1-A) |

**نتیجهٔ Re-baseline (مطابق ۱۰ بند دستورالعمل اتمام کار موازی):** محیط نسبت به
گزارش R1-A تغییر کرده و **کاملاً قابل توضیح است** — تنها تغییر، Commit M2-3
(`5df4c8d`) روی 53 است (بخش 3.3). هیچ Restart غیرمنتظره یا اختلاف غیرقابل
توضیح مشاهده **نشد**.

### 2.1 رویداد کار موازی (Incident) — ثبت رسمی

| زمان (UTC 11-10) | رویداد |
|---|---|
| ~17:09:04 | بازنویسی `.env.radio` (افزودن متغیرهای M2-3) |
| 17:25–17:28 | `radio_frontend` دوباره ساخته شد (حالت میانی) |
| 17:47:46 | بازنویسی نهایی `docker-compose.radio.yml` + ساخت نهایی `radio_frontend` |
| 18:16:12 | Commit `5df4c8d` (M2-3) روی 53 |

در لحظهٔ ~17:25 UTC (حین فاز A0 اولیه)، تغییرات هم‌زمان تشخیص داده شد و بر اساس
§13 مأموریت **توقف** شد؛ کاربر «توقف تا اتمام کار موازی» را انتخاب کرد و در
2026-11-11 06:22 UTC با دستور «ادامه از ابتدا با Re-baseline کامل Read-only»
مأموریت از سر گرفته شد. کل Delta git (71d94d1→5df4c8d) توضیح داده شد:
**M2-3 = افزودن UI محصول مستقل + selector + پراکسی `/api-eiis/` و `/api-taghrir/`
در nginx فرانت‌اند** با تزریق سرورساید توکن (مقدار توکن‌ها فقط در `.env.radio`
0600 و env Containerها).

---

## 3. هویت سرورها (Server Identity) — `VERIFIED`

### 3.1 سرور 53 (بررسی تازهٔ 11-11، نه از گزارش‌های قدیمی)

- hostname `llm`، Ubuntu 24.04.5، kernel مطابق روتر LLM، uptime 14d
- دسترسی: `saber@172.20.1.53` با key (بدون نیاز به jump)
- Docker daemon فعال؛ 17 Container روی شبکهٔ `graph-rag_default`
- tailscale0: `100.72.7.26` (Tailscale 1.104.5)، `tailscale serve` فعال نیست،
  peerها route اعلام می‌کنند ولی `--accept-routes` روی این نود **false** است

### 3.2 سرور 133 (Edge)

- hostname `AI-TOOLS`، Ubuntu 24.04.4
- nginx 1.31.4 + btpanel + certbot (timer فعال) — مطابق R1-A
- در این مأموریت صرفاً به‌عنوان **نقطهٔ مواضع (vantage)** برای تست مواجههٔ
  شبکه استفاده شد؛ هیچ تغییری روی آن انجام نشد.

### 3.3 وضعیت Git رپوی زندهٔ Radio (روی 53) — `VERIFIED`

| فیلد | مقدار |
|---|---|
| مسیر | `/home/saber/saberprojects/radio-rag-service` |
| Branch | `stage5-citations` |
| HEAD | **`5df4c8d`** — 2026-11-10 18:16:12 UTC — Commit M2-3 (UI محصول مستقل + پراکسی EIIS/Taghrir) |
| Working tree | تمیز، جز **۱ فایل untracked**: `tests_test_citation_quality.py` |
| تغییرات uncommitted | **صفر** |

**Git NLO (کاربرگ فعلی):** `main` @ `2235c3e`، تمیز؛ گزارش‌های R0/R1-A untracked
مانده‌اند. این گزارش (`RADIO_R1A_SECURITY.md`) هم **untracked** باقی می‌ماند.
هیچ `git add -A`/Commit/Push/branch-change انجام **نشده** (بر اساس §12).

---

## 4. فهرست Containerها (Container Inventory) — `VERIFIED`

### 4.1 شبکهٔ `graph-rag_default` (15.15.12.0/24) — 17 Container

| Container | IP | نسخه/نقش | Created | Started |
|---|---|---|---|---|
| `neo4j_db` | 15.15.12.5 | neo4j:2025.10.1-enterprise (DB مشترک پلتفرم) | 2026-10-02 | 2026-11-01 05:33 |
| `radio_api` | 15.15.12.13 | API Radio (FastAPI/Python) | 2026-11-03 | 2026-11-06 11:44 |
| `radio_frontend` | 15.15.12.9 | nginx:alpine (UI + پراکسی) | **2026-11-10 17:47:46** (موازی M2-3) | همان لحظه |
| `mesbah_api` / `_frontend` / `_feedback_db` | .2 / .4 / .12 | محصول مبین | 11-06 | 11-06 |
| `eiis_api` / `_frontend` / `_feedback_db` | .6 / .8 / .10 | محصول EIIS | 11-06 | 11-06 |
| `taghrir_api` / `_frontend` / `_feedback_db` | .3 / .11 / .7 | محصول تخریر | 11-06 | 11-06 |
| `tasnim_api` / `_frontend` / `_feedback_db` | .17 / .18 / .16 | محصول تسنیم | 11-08 | 11-08 |
| `sources_api` / `sources_frontend` | .14 / .15 | سرویس منابع | 11-05 | 11-05 |

### 4.2 نکات کلیدی `neo4j_db`

- **RestartPolicy = `no`** — در صورت crash، خودبه‌خود بالا نمی‌آید (یافتهٔ عملیاتی)
- Mount داده: `/home/saber/saberprojects/graph-rag/neo4j_data` → `/data` (rw) — **81GB**
  (63G databases + 17G transactions)
- `/import` → `neo4j_dump` (host dir) — پیشینهٔ `mesbah.dump` (1.4GB، 6 اکتبر)
- Volume Docker → `/logs`
- conf: `/var/lib/neo4j/conf/neo4j.conf` (داخل Container)
- `neo4j-admin` نسخهٔ 2025.10.1 در `/var/lib/neo4j/bin/` در دسترس است
- Publish: `7474/tcp -> 0.0.0.0:7474` و `7687/tcp -> 0.0.0.0:7687` (+ IPv6 `[::]`)

### 4.3 وضعیت سلامت (لحظهٔ بررسی 11-11)

- `radio_api` /api/health → HTTP 200، `neo4j_online: true`، 6.8ms — `VERIFIED`
- `radio_frontend` → HTTP 200 — `VERIFIED`
- `neo4j_db` — ONLINE (query واقعی، بخش 7)

---

## 5. نسخه و ویرایش Neo4j — `VERIFIED`

| فیلد | مقدار |
|---|---|
| Edition | **Enterprise** (`NEO4J_EDITION=enterprise`) |
| نسخه | **2025.10.1** (`dbms.components` + `neo4j-admin --version`) |
| Cypher | 5/25 (تغییرات سینتکسی 2025.x رعایت شدند — مثلاً حذف `SHOW PARAMETERS`) |
| License | `NEO4J_ACCEPT_LICENSE_AGREEMENT=yes` |
| Auth | **فعال** (رمز اشتباه → `AuthError` — بخش 7) |
| دیتابیس‌های آنلاین | **14**: radio, radio-4b, mesbah, taghrir, taghrir-10, taghrir-50, taghrir-100, falsafe-siasi-1000-embed-06b, falsafe-siasi-qwen3-embed-06b, falsafe-siasi-qwen3-embed-4b, tasnim-qwen3-embed-06b, import-test-06b, neo4j, system |
| Vector Index | `vector_index_chunk` در db `radio` — **ONLINE** (و radio-4b هم‌شکل) |
| حجم داده (db radio) | **79,350** chunk/node، 0 relation |
| query برداری واقعی | 1024-d dummy vector → 33.6ms، نتیجهٔ صحیح |
| Page cache | 512M |
| APOC | install شده؛ `dbms.security.procedures.unrestricted=apoc.*` + `apoc.export.file.enabled=true` + `apoc.import.file.enabled=true` (یافته F6) |
| Listen | `server.default_listen_address=0.0.0.0`؛ bolt 7687 + http 7474 فعال، https **غیرفعال** |
| پورت‌های شنونده (داخل Container) | 0.0.0.0: 6000 (metrics), 7000 (cluster), 7474, 7687, 7688 (raft) · 127.0.0.1: 6362 |

**مهم:** Neo4j یک سرویس **مشترک پلتفرم** است؛ Radio فقط دیتابیس‌های `radio` و
`radio-4b` را استفاده می‌کند، اما اعتبار `neo4j` روی **هر ۱۴ دیتابیس** admin است.

---

## 6. تحلیل منبع اعتبارها (Credential Source Analysis) — `VERIFIED` (با hash، بدون نمایش مقدار)

### 6.1 جدول مسیر اعتبار (متغیر / منبع / مصرف‌کننده / Placeholder؟ / اثبات)

| متغیر | منبع (فایل) | مصرف‌کننده | مقدار | وضعیت |
|---|---|---|---|---|
| `NEO4J_PASSWORD` | `.env.radio` (0600, 1161B, mtime 11-10 17:09:04) | `radio_api` (compose: `NEO4J_PASSWORD=${NEO4J_PASSWORD}`) | sha256 = `cfb62cc80de05545…` | **Placeholder قالب** — hash آن با sha256(`your_neo4j_password_here`) محلی تطبیق کرد |
| `NEO4J_AUTH` | env خود `neo4j_db` (از compose/`.env` graph-rag) | Neo4j server | `neo4j/<همان placeholder>` — hash password-part = `cfb62cc80de05545…` | **یکسان با فایل و API** (سه‌گانهٔ hash: فایل = API = DB) |
| `NEO4J_USERNAME` | compose inline | `radio_api` + ۵ API دیگر | `neo4j` (admin) | `VERIFIED` |
| `NEO4J_PASSWORD` در env `mesbah_api`/`eiis_api`/`taghrir_api`/`tasnim_api` | env fileهای هر محصول | همان APIها | hash password = `cfb62cc80de05545…` (مطابقت) | **همان رمز ضعیف، همهٔ محصولات** |
| `SOURCES_NEO4J_PASS` | env `sources_api` | `sources_api` | مقدار placeholder به‌صورت **حرف‌به‌حرف** در env دیده شد | `VERIFIED` |
| `QA_CORPUS_NEO4J_PW` / `QA_RADIO_NEO4J_PW` | env `ragportal_api` | `ragportal_api` | مقدار placeholder حرف‌به‌حرف در env | `VERIFIED` |
| `LITELLM_API_KEY` | `.env.radio` | `radio_api` → LiteLLM روی 133:4000 | hash = `17c64036d1f4fe4e…` ≠ sha256 کلید پیش‌فرض vendor (حذف از گزارش) | **نه پیش‌فرض شناخته‌شده است**؛ مقدار شناسایی‌شده نیست؛ ضعیف/بهداشت‌نشده → چرخش توصیه‌شده (F5) |
| `RAG_SERVICE_TOKEN` | `.env.radio` | `radio_api` (gate API v1) | `<SET>` masked | `VERIFIED` وجود دارد |
| `RAG_EIIS_TOKEN` / `RAG_TAGHRIR_TOKEN` | `.env.radio` | `radio_frontend` (nginx entrypoint — تزریق سرورساید header) | `<SET>` masked | `VERIFIED` وجود دارد (جدید در M2-3) |
| `NEO4J_URI` | compose inline | `radio_api` | `bolt://neo4j_db:7687` (نام DNS شبکهٔ Docker) | `VERIFIED` |
| `NEO4J_DATABASE` | compose inline | `radio_api` | `radio` | `VERIFIED` |

### 6.2 روش اثبات (چرا می‌توان بدون نمایش رمز نتیجه گرفت)

1. `sha256(مقدار NEO4J_PASSWORD در .env.radio)` روی خود سرور → پیشوند `cfb62cc80de05545`
2. `sha256(NEO4J_PASSWORD در env زندهٔ radio_api)` → **همان** پیشوند
3. `sha256(password-part از NEO4J_AUTH در env neo4j_db)` → **همان** پیشوند
4. محلی: `sha256("your_neo4j_password_here")` → `cfb62cc80de05545…` (تطبیق قطعی)

**نتیجه:** اعتبار مؤثر production، دقیقاً همان placeholder قالب Neo4j است؛ از فایل
→ compose → env API → env سرور DB، بدون هیچ لایهٔ مبدل یا secret manager.
`.gitignore` رپو با `.env*` از ورود به git جلوگیری می‌کند (نقطهٔ مثبت) ولی هیچ
secret manager موجود **نیست** (فایل 0600).

### 6.3 ⚠️ Near-miss: افشای محلی مقادیر به ترمینال اپراتور

در یک اسکریپت masking اولیه، backreference اشتباه در `sed` باعث شد مقادیر واقعی
`NEO4J_PASSWORD` (که placeholder شناخته‌شده است)، `LITELLM_API_KEY`،
`RAG_SERVICE_TOKEN`، `RAG_EIIS_TOKEN` و `RAG_TAGHRIR_TOKEN` **یک‌بار** در ترمینال
خودِ کاربر (مالک اعتبارها) چاپ شوند. **هیچ افشای خارجی، log، git یا گزارش نبود.**
با این حال به‌دلیل آلوده‌شدن ترمینال: چرخش `LITELLM_API_KEY`، `RAG_SERVICE_TOKEN`،
`RAG_EIIS_TOKEN` و `RAG_TAGHRIR_TOKEN` به‌عنوان **اختیاری اما توصیه‌شده** در Scope
Change A قرار می‌گیرد (بخش 12). از این پس همهٔ اسکریپت‌ها فقط hash 16-کاراکتری
مقدارها را نمایش می‌دادند.

---

## 7. راستی‌آزمایی احراز هویت (Authentication Verification) — `VERIFIED`

| تست | روش | نتیجه |
|---|---|---|
| آیا app واقعاً وصل است؟ | `GET /api/health` روی 127.0.0.1:8043 (روی 53) | HTTP 200 — `"neo4j_online":true`، `neo4j_database: radio` |
| آیا احراز هویت فعلاً فعال است؟ | اتصال cypher با **رمز اشتباه** (درایور جدا، بدون تخریب اتصال app) | **`AuthError`** — یعنی auth ON |
| آیا با اعتبار فعلی وارد می‌شود؟ | اتصال با env خود radio_api | موفق — `SHOW DATABASES`، شمارش nodها و query برداری |
| bolt از شبکهٔ داخلی | تحلیل `/proc/net/tcp6` neo4j_db | 10-12 اتصال ESTAB روی 7687 — **همه از ۵ Container API** (radio 15.15.12.13، sources .14، tasnim .17، mesbah .2، taghrir .3، eiis .6) — **هیچ اتصال از آدرس هاست یا بیرونی** |
| چند کاربر وجود دارد؟ | `SHOW USERS` (سینتکس 2025.x) | **فقط 1 کاربر: `neo4j`** (نقش‌ها: admin + PUBLIC) |
| چند نقش؟ | `SHOW ROLES` | PUBLIC, admin, architect, editor, publisher, reader — **Enterprise RBAC در دسترس** |
| چند اعتبار جداگانه؟ | مقایسهٔ hash همهٔ envها | **یک اعتبار واحد** در کل پلتفرم |

**نتیجه:** app زنده، اعتبار فعلی معتبر، auth فعال است — ریسک از «رمز ضعیف
شناخته‌شده + دروازه‌های باز» می‌آید، نه از «احراز هویت خاموش».

---

## 8. ماتریس مواجههٔ شبکه (Network Exposure Matrix)

### 8.1 نتایج تست (همه Read-only — tcp probe + curl)

| نقطهٔ مواضع | 7474 | 7687 | شواهد |
|---|---|---|---|
| 127.0.0.1 روی 53 | **OPEN** | **OPEN** | `/dev/tcp` probe |
| 172.20.1.53 (IP لانی) روی 53 | **OPEN** (HTTP 200، 417B — UI مرورگری Neo4j) | **OPEN** | curl + probe |
| از edge 133 | **OPEN** | **OPEN** | probe مستقیم از 133 |
| از workstation (لانی شرکت) | **OPEN** | **OPEN** | probe مستقیم |
| داخل Docker (15.15.12.x) | — | **OPEN** (مسیر app) | ESTAB واقعی |
| اینترنت عمومی | **NOT VERIFIED** | **NOT VERIFIED** | 53 IPv4 عمومی ندارد؛ `185.213.10.25` NAT به 133 است — از داخل قابل استنتاج نیست؛ **نیاز به probe خارجی در Change C** |
| Tailscale | serve غیرفعال؛ `accept-routes=false` | — | `tailscale status --json` |

### 8.2 چرا باز است (ریشه)

1. `docker port neo4j_db`: `0.0.0.0:7474` و `0.0.0.0:7687` — publish همه‌رسانه
2. `server.default_listen_address=0.0.0.0` در neo4j.conf
3. **فایروال هاست: `BLOCKED`** — `nft`/`ufw` به‌دلیل نبود دسترسی root قابل خواندن نبود؛
   `ss` روی هاست (لحظهٔ نمونه‌برداری) هیچ فرآیند هاستی با این پورت‌ها نشان نداد،
   ولی وجود/نبود قواعد filter قابل اثبات نبود → در برنامهٔ Change B، snapshot فایروال
   با root گیت می‌شود.

### 8.3 تحلیل مصرف‌کنندگان (A1.1) — `VERIFIED`

| مصرف‌کننده | مسیر | پورت | احراز | ضرورت |
|---|---|---|---|---|
| `radio_api` | `bolt://neo4j_db:7687` (DNS شبکهٔ Docker → 15.15.12.5) | 7687 ( داخلی) | neo4j/placeholder | **ضروری — سرویس زنده** |
| `mesbah_api`، `eiis_api`، `taghrir_api`، `tasnim_api` | همان الگو، env هر محصول | 7687 (داخلی) | neo4j/همان رمز | ضروری برای محصولاتشان |
| `sources_api` | `SOURCES_NEO4J_PASS` | 7687 (داخلی) | neo4j/placeholder | ضروری |
| `ragportal_api` | `QA_*_NEO4J_PW` | 7687 (داخلی) | neo4j/placeholder | ضروری |
| `radio_frontend` / frontendهای دیگر | **هیچ** — grep روی `nginx.conf` رادیو: صفر ارجاع به 7474/7687/neo4j | — | — | **فرانت به DB نمی‌زند** |
| فرآیندهای هاست | `ss -tnp` (لحظهٔ بررسی): **صفر** | — | — | نیست |
| اسکریپت‌های ad-hoc در رپوها (مثل `_neo4j_probe.py`، staging `m23_staging`) | ارجاع‌های متنی به پورت‌ها | — | — | غیرعملیاتی؛ در Change B بازبینی می‌شوند |

**نتیجهٔ معماری:** هیچ مصرف‌کنندهٔ زنده‌ای از پورت‌های publish شدهٔ هاست استفاده
**نمی‌کند**؛ همه از DNS داخلی Docker می‌روند. پس publish به `0.0.0.0` فقط سطح
مواجهه است، نه ضرورت.

---

## 9. وابستگی‌ها و سازگاری (Application Dependencies) — Dependency Matrix

| سؤوال | پاسخ | شواهد |
|---|---|---|
| API چگونه وصل می‌شود؟ | `bolt://neo4j_db:7687` از شبکهٔ Docker؛ driver lazy (اتصال on-demand) | env زنده + ESTAB |
| فرانت‌اند مستقیم به Neo4j می‌زند؟ | **خیر** | grep صفر + ESTAB صفر از .9 |
| چه کس دیگری از کاربر `neo4j` استفاده می‌کند؟ | ۶ API پلتفرم (فهرست بخش 8.3) | مقایسهٔ hash envها |
| اعتبار در چند جا تکرار شده؟ | `.env.radio` + env file هر محصول + (احتمالاً) inline composeهای قدیمی | اسکن host (بخش 4 A4) |
| secret manager هست؟ | **خیر** — فایل 0600 | — |
| برای تغییر اعتبار، چه چیزی باید restart شود؟ | **فقط `radio_api`** (`compose up -d radio_api`)؛ `neo4j_db` اگر با `CREATE USER` بریم، **اصلاً** restart نمی‌خواهد | طراحی بخش 12 |
| اگر با `NEO4J_AUTH` بچرخیم؟ | recreate `neo4j_db` لازم است (≈30–60s، data bind mount است) — **طرح پیشنهادی نیست** | — |
| indexes/data باقی می‌مانند؟ | بله — volume/mount جدا از Container است | mount 81GB ثابت |
| connection pool؟ | driver پیش‌فرض Neo4j (max pool ≈50)؛ در لحظهٔ بررسی 1-3 اتصال فعال از radio | ESTAB |
| تفاوت compose فایل vs env اجرای زنده؟ | **radio_api** 3 نوامبر ساخته شده و 10 نوامبر recreate **نشده** → env زنده با نسخهٔ 6 نوامبر (api.py) سازگار است؛ hash تطبیق کرد. **radio_frontend** 17:47:46 recreate شده → template زنده = نسخهٔ 17:47 (یکسان با git 5df4c8d) | `docker inspect` Created/Started + mtime + hash |
| LiteLLM | `http://172.30.0.133:4000/v1` — بدون تغییر در این مأموریت | env |

---

## 10. یافته‌های امنیتی (Security Findings)

| # | یافته | شدت | وضعیت |
|---|---|---|---|
| F1 | رمز مدیر Neo4j در کل پلتفرم = placeholder قالب (شناخته‌شده)؛ 14 دیتابیس admin | **Critical** | ثبت شد — با Change A رفع (محدودهٔ Radio)؛ چرخش پلتفرمی نیازمند هماهنگی جداگانه |
| F2 | 7474/7687 روی `0.0.0.0` publish + `default_listen_address=0.0.0.0`؛ قابل دسترس از LAN/edge/workstation؛ UI مرورگری 7474 با HTTP 200 | **High** | ثبت شد — با Change B رفع |
| F3 | فایروال هاست قابل مشاهده نبود (root نیاز) → لایهٔ دفاعی دوم اثبات‌نشده | **High** (gap) | `BLOCKED` — با snapshot root در Change B رفع |
| F4 | Neo4j مشترک ۱۴ دیتابیس؛ blast-radius تغییر رمز = کل پلتفرم | **High** | ثبت شد — طراحی Change A «کاربر اختصاصی» همین blast-radius را حذف می‌کند |
| F5 | Near-miss: چاپ یک‌بارهٔ مقادیر `.env.radio` در ترمینال اپراتور (بدون افشای خارجی) + `LITELLM_API_KEY` بدون چرخش دوره‌ای | **Medium** | ثبت شد — چرخش توکن‌ها در Change A (توصیه‌ای/اختیاری) |
| F6 | APOC `unrestricted=apoc.*` + `apoc.export.file.enabled=true` + `apoc.import.file.enabled=true` — با F1+F2 ترکیب، read/write فایل روی هاست از طریق DB ممکن می‌شود | **High** (ترکیبی) | ثبت شد — محدودسازی APOC پس از Change A+B پیشنهاد می‌شود (خارج از Scope اجباری) |
| F7 | `RestartPolicy=no` روی neo4j_db (آپ‌تایم 11-01 تاکنون) | **Medium** (عملیاتی) | ثبت شد — توصیه: `always` در مرحلهٔ بعدی (با مجوز جداگانه) |
| F8 | `PermitRootLogin yes` روی SSH هر دو سرور | **Medium** (خارج از Scope) | ثبت شد — پیگیری در پروژهٔ سخت‌سازی عمومی |
| F9 | https Neo4j غیرفعال (bolt/http فقط TLS-free) — با Change B (محدودسازی به 127.0.0.1/شبکهٔ Docker) ریسک کاهش می‌یابد | **Low–Medium** | ثبت شد |

---

## 11. طبقه‌بندی ریسک (Risk Classification)

- **احتمال بهره‌برداری F1+F2 (قبل از اصلاح): بالا** — رمز عمومی/شناخته‌شده +
  دروازهٔ باز در شبکه‌ای که edge و workstation هم وارد آن می‌شوند.
- **تأثیر: بسیار بالا** — دسترسی admin به 14 دیتابیس (داده‌های چند محصول) + APOC
  file I/O روی هاست.
- **وضعیت فعلی سرویس: سالم** — سرویس کار می‌کند؛ ریسک «دسترسی مجازنشده» است نه
  «خرابی». بنابراین اصلاح باید بدون توقف سرویس طراحی شود (و طراحی شد — بخش 12/13).
- **مرجّح:** Change A (ریسک F1/F4) **اولویت بالاتر** از Change B (F2) است، اما
  هر دو پیش از باز شدن عمومی `radio.ai.ismc.ir` (R1-C) باید بسته باشند.

---

## 12. برنامهٔ اصلاح اعتبار (Credential Remediation Plan) — طراحی، **اجرا نشده**

### 12.1 روش انتخاب‌شده: **کاربر اختصاصی + نقش محدود (Enterprise RBAC)** — ترجیحی

چرا: Neo4j مشترک است (F4)؛ چرخش رمز کاربر `neo4j` یعنی هماهنگ‌سازی ۶ محصول و
recreate چند Container. با کاربر اختصاصی، **فقط Radio** تحت تأثیر قرار می‌گیرد و
اعتبار مشترک دست‌نخورده می‌ماند تا چرخش پلتفرمی در هماهنگی جداگانه انجام شود.
RBAC Enterprise تأیید شد: `CREATE USER/ROLE` در دسترس (6 نقش از پیش موجود).

### 12.2 مراحل اجرایی (Runbook Change A) — هر مرحله با گیت مجوز

| مرحله | عملیات | اثر | بازگشت |
|---|---|---|---|
| A0 | **Backup کامل مطابق بخش 14** (اجرا شده + sha256 + تست restore در محیط مجزا) | — | — |
| A1 | `CREATE USER radio_app SET PASSWORD <پوشهٔ تولیدشدهٔ سرور>` | صفر | `DROP USER` |
| A2 | `CREATE ROLE radio_read`؛ `GRANT MATCH ON DATABASE radio TO radio_read` + همین برای `radio-4b` (radio_api فقط READ می‌کند — import جداست)؛ `GRANT ROLE radio_read TO radio_app` | صفر | `DROP ROLE/USER` |
| A3 | تولید رمز جدید **روی خود سرور** (`openssl rand -base64 32` مستقیم داخل `.env.radio`) — **هرگز در chat/git/گزارش/ترمینال نمایش نمی‌شود**؛ دسترسی انسان به مقدار «نیازی نیست» (app آن را می‌خواند) | صفر | — |
| A4 | ویرایش `.env.radio`: `NEO4J_USERNAME=radio_app` + `NEO4J_PASSWORD=<جدید>` (فایل 0600) | صفر | revert فایل |
| A5 | `docker compose -f docker-compose.radio.yml up -d radio_api` (recreate؛ **≈10–30s** قطع radio_api فقط) | radio_api: 10–30s | recreate با env قبلی (رمز قدیمی هنوز معتبر است) |
| A6 | راستی‌آزمایی: `/api/health` → `neo4j_online:true`؛ یک query برداری واقعی؛ `SHOW USERS`/ESTAB از 15.15.12.13؛ test اتصال با `radio_app` جداگانه | — | — |
| A7 | **اعتبار قدیمی (placeholder) برای محصولات دیگر فعلاً دست‌نخورده می‌ماند**؛ چرخش پلتفرمی = مأموریت جداگانه با هماهنگی ۶ محصول | — | — |
| A8 (اختیاری — گیت جدا) | چرخش `LITELLM_API_KEY`، `RAG_SERVICE_TOKEN`، `RAG_EIIS_TOKEN`، `RAG_TAGHRIR_TOKEN` (علت F5) + revert radio_api/frontend | radio: ≤60s | revert envها |

**Downtime کل:** Neo4j: **صفر**. محصولات دیگر: **صفر**. radio_api: **10–30 ثانیه**.
**نحوهٔ دریافت رمز جدید برای انسان:** فقط «نیاز به دانستن نداریم» — اگر روزی نیاز شد،
از خود سرور با دسترسی saber بازیابی می‌شود (فایل 0600)، نه از chat/گیت.
**Rollback:** A4/A5 را معکوس (env قبلی + recreate) — چون در A7 اعتبار قدیمی حذف
نمی‌شود، rollback همیشه در دست است. **هرگز** اعتبار قدیمی پیش از اثبات اعتبار
جدید حذف نمی‌شود (مطابق §13).

### 12.3 جایگزین (اگر A1–A3 ناموفق بود): چرخش رمز کاربر `neo4j`

تولید رمز جدید → ویرایش همهٔ envها (6 محصول) → recreate ترتیبی Containerها.
**ریسک بالاتر** (blast-radius کل پلتفرم، downtime توالی چند دقیقه‌ای)، فقط در صورت
شکست RBAC و با مجوز جداگانه + هماهنگی صریح.

---

## 13. برنامهٔ سخت‌سازی شبکه (Network Hardening Plan) — طراحی، **اجرا نشده**

### 13.1 قوانین پیشنهادی (هر قاعده: فعلی / پیشنهادی / اثر / بازگشت)

| قاعده | فعلی | پیشنهادی | دلیل | وابستگی | اثر | بازگشت |
|---|---|---|---|---|---|---|
| B1 — publish 7474 | `0.0.0.0:7474` | **حذف publish** (یا `127.0.0.1:7474` اگر دیباگ هاستی لازم شد) | هیچ مصرف‌کنندهٔ زنده‌ای از 7474 استفاده نمی‌کند (ESTAB صفر؛ app از 7687 داخلی) | — | UI مرورگری از LAN/edge/باز بسته می‌شود؛ app تأثر نمی‌بیند | revert compose + recreate neo4j_db |
| B2 — publish 7687 | `0.0.0.0:7687` | **حذف publish** (ترجیحی) یا `127.0.0.1:7687` (احتیاطی) | همهٔ APIها از `neo4j_db:7687` (DNS Docker) می‌روند — اثبات ESTAB | — | bolt از LAN/edge/باز بسته؛ ترافیک app دست‌نخورده | revert + recreate |
| B3 — neo4j.conf | `default_listen_address=0.0.0.0` | باقی بماند **اگر** B1/B2 اجرا شدند (مواجههٔ Container فقط در شبکهٔ Docker) — تغییر conf اختیاری است | publish لایهٔ تعیین‌کننده است | B1/B2 | صفر | — |
| B4 — فایروال هاست (root) | `BLOCKED` (غیرقابل مشاهده) | پس از snapshot، قواعد ufw: 7687 فقط از 15.15.12.0/24 و 127.0.0.1؛ 7474 فقط 127.0.0.1 (اگر publish باقی بماند) | لایهٔ دوم دفاع | **دسترسی root + مجوز** | صفر برای ترافیک مجاز | `ufw delete rule …` |
| B5 — Tailscale | serve غیرفعال، accept-routes=false | **بدون تغییر** — نیاز نیست؛ فقط ثبت شد | — | — | — | — |
| B6 — نه flush، نه restart شبکه | — | صریحاً ممنوع — همهٔ تغییرات additively با recreate فقط neo4j_db | حفاظت از Nginx(133)/LiteLLM/GitLab/Wiki.js/NLO | — | — | — |

**نکتهٔ کلیدی downtime:** تغییر `ports:` در compose مستلزم **recreate `neo4j_db`**
است (≈30–60s) — در آن پنجره **همهٔ 5 محصول** موقتاً بدون DB هستند (اتصال‌ها
retry می‌کنند، داده دست نمی‌رود چون bind mount است). اگر این پنجره برای پلتفرم
قابل قبول نبود، **جایگزین بدون recreate** = قواعد ufw/iptables (B4، نیازمند root)
با همان اثر عملی و بازگشت آسان — در گزارش Change B به عنوان **گزینهٔ کم‌ریسک‌تر**
پیشنهاد می‌شود و انتخاب با کاربر است.

**سرویس‌هایی که نباید آسیب ببینند (تحلیل تأثیر):** Nginx 133 (سرور دیگر — صفر)،
LiteLLM 133:4000 (صفر)، GitLab/Wiki.js (صفر)، NLO (صفر)، Radio API/FRontend
(فقط در پنجرهٔ recreate — با گزینهٔ ufw حتی این هم صفر می‌شود).

---

## 14. برنامهٔ Backup — طراحی، **اجرا نشده**

### 14.1 محدوده (اسکوپ Radio + پیکربندی)

| آیتم | منبع | روش |
|---|---|---|
| دیتابیس `radio` + `radio-4b` | neo4j_data (از 81GB کل) | **`neo4j-admin database dump`** (Enterprise، online، پیشینه: `mesbah.dump` 1.4GB) — تخمین حجم: 2–4GB برای هر db |
| (اختیاری گیت جدا) snapshot کامل همهٔ 14 db | — | فقط اگر کاربر بخواهد؛ حجم ~63GB+ |
| `neo4j.conf` | `/var/lib/neo4j/conf/neo4j.conf` (کپی از Container) | کپی فایل + hash |
| `docker-compose.radio.yml` | 53 | کپی + hash |
| `.env.radio` | 53 (0600) | کپی با **تبدیل نام** (بدون secret در نام فایل: `env-secrets-<ts>.bin`، 0600) — محتوای داخل = همان متغیرها |
| Container metadata | `docker inspect` (radio_api, radio_frontend, neo4j_db) → JSON | کپی |
| وضعیت شبکه/FW | اگر root در دسترس بود: `nft list ruleset`/`ufw status` | کپی |
| Git SHA | HEAD رپوی radio + NLO | ثبت در MANIFEST |

### 14.2 مسیر، دسترسی و فضای ذخیره

- مسیر پیشنهادی مأموریت `/var/backups/radio/r1a-security-<timestamp>/`:
  **`/var/backups` root:root است و کاربر `saber` نمی‌تواند زیرمجموعه بسازد** →
  دو گزینه (انتخاب کاربر):
  1. کاربر با sudo: `sudo mkdir -p /var/backups/radio && sudo chown saber:saber /var/backups/radio` و ادامه
  2. مسیر جایگزین همان هاست: `/home/saber/backups/radio/r1a-security-<ts>/` (خارج از git،
     خارج از webroot، فضا: 310G آزاد — کافی)
- دسترسی: دایرکتوری **0700**، فایل‌ها **0600**، hash SHA-256 هر فایل در
  `MANIFEST.sha256`؛ **هیچ secret در نام فایل/لوگ**.
- **هیچ Backup در این مأموریت اجرا نشد** (طبق دستور صریح).

### 14.3 قابلیت restore و تست ایزوله

- Restore: `neo4j-admin database load radio --from=dump…` (نسخهٔ یکسان 2025.10.1)
- **تست restore فقط در محیط ایزوله:** یک Container neo4j موقت نسخهٔ 2025.10.1 روی
  هاست (port بدون publish) + load + مقایسهٔ (a) شمارش 79,350 chunk، (b) ONLINE بودن
  `vector_index_chunk`، (c) یک query برداری هم‌شکل با تولیدی، (d) hash conf.
  این تست **نیز** با مجوز جداگانه و خارج از مسیر تولید است.

---

## 15. شواهد Backup (Backup Evidence)

| آیتم | وضعیت |
|---|---|
| Backup اجرا شده؟ | **خیر — `NOT IMPLEMENTED` (منبع: گیت مجوز)** |
| فضای ذخیره بررسی شده؟ | `VERIFIED` — 310G آزاد روی 53 |
| ابزار backup موجود؟ | `VERIFIED` — `neo4j-admin` 2025.10.1 در `/var/lib/neo4j/bin/` |
| پیشینهٔ موفق backup در هاست؟ | `VERIFIED` — `mesbah.dump` 1.4GB در `neo4j_dump` (6 اکتبر) |
| مسیر مقصد قابل‌نوشته؟ | `BLOCKED` — `/var/backups` root است؛ گزینه‌های بخش 14.2 منتظر انتخاب |
| TEST restore | `NOT VERIFIED` — فقط طراحی (14.3) |

---

## 16. برنامهٔ Rollback

| سناریو | عملیات معکوس | زمان |
|---|---|---|
| Change A شکست (A5/A6) | revert `.env.radio` (کپی پیش از تغییر) + `compose up -d radio_api` | ≤1 دقیقه |
| Change A پس از موفقیت، مشکل رفتاری | همان — اعتبار قدیمی تا A7 حذف نمی‌شود، پس «بازگشت» همیشه در دست است | ≤1 دقیقه |
| Change B (recreate neo4j_db) شکست | revert compose (کپی پیش از تغییر) + `compose up -d neo4j_db` | 1–2 دقیقه (خود recreate) |
| Change B (ufw، بدون recreate) | `ufw delete rule <rule>` (کد هر قاعده در MANIFEST بکاپ ثبت می‌شود) | ≤1 دقیقه |
| Backup خراب/ناموفق | بکاپ ناقص = **STOP** و تکرار (بخش 14) — بدون backup معتبر، Change A/B ممنوع | — |
| هر rollback جدیدی که خود تغییر جدید می‌خواهد | طبق §13: **اول مجوز** | — |

**قیدهای §13 رعایت‌شده:** حذف DB/volume ممنوع؛ rebuild index ممنوع؛ recreate بدون
بررسی ممنوع؛ reset فایروال ممنوع؛ حذف اعتبار قدیمی پیش از اثبات جدید ممنوع.

---

## 17. نتایج تست‌ها (Test Results)

### 17.1 تست‌های انجام‌شده در این مأموریت (همه Read-only)

| تست | نتیجه | برچسب |
|---|---|---|
| `/api/health` (GET فقط) | 200، `neo4j_online:true`، 6.8ms | PASS |
| فرانت‌اند HTTP | 200 | PASS |
| اتصال با رمز اشتباه | `AuthError` (auth ON) | PASS (رفتار امن) |
| اتصال با اعتبار فعلی | موفق + queryهای ساختاری | PASS |
| شمارش چانک‌ها radio/radio-4b | 79,350 / 79,350 | PASS (integrity) |
| وضعیت `vector_index_chunk` | ONLINE | PASS |
| query برداری واقعی (1024-d) | 33.6ms، نتایج درست | PASS |
| `SHOW USERS` | فقط `neo4j` | INFO |
| `SHOW ROLES` | 6 نقش (RBAC در دسترس) | INFO |
| ماتریس probe شبکه (4 مواضع) | همه OPEN (یافته F2) | ثبت شد |
| تحلیل ESTAB (neo4j + 7 API + هاست) | فقط 5 Container API، از شبکهٔ Docker | PASS (تحلیل مصرف‌کننده) |
| hash سه‌گانهٔ اعتبار | سه لایه هم‌hash = placeholder | ثبت شد (F1) |
| `POST /api/chat` | **اجرا نشد** (ممنوع) | — |
| Backup | **اجرا نشد** (ممنوع) | — |
| هرگونه تغییر Production | **صفر** | — |

### 17.2 ماتریس تست بعد از اجرا (فقط پس از مجوز Change A/B — بخش 9 مأموریت)

| تست Neo4j | معیار | | تست Radio app (از API واقعی) | معیار |
|---|---|---|---|---|
| Process ONLINE | `currentStatus=online` | | `/api/health` | 200 + `neo4j_online:true` |
| احراز موفق با `radio_app` | SUCCESS | | `/api/programs` (read واقعی) | 200 + آرایهٔ نام‌ها |
| احراز نامعتبر رد شود | `AuthError` | | query برداری از طریق API | نتیجهٔ هم‌شکل با قبل |
| bolt از خارج شبکهٔ مجاز | CLOSED | | خطاها (log) | بدون AuthError/ConnectionError |
| 7474 از خارج | CLOSED | | (بدون POST جدید — مجوز جدا) | — |
| index ONLINE | `ONLINE` | | | |
| چانک‌ها حفظ | 79,350 | | | |
| regressions | exit code 0 | | | |

**تست جداسازی سرویس‌ها (پیش/پس):** Nginx(133)، LiteLLM(133:4000)، GitLab،
Wiki.js، NLO، Radio Frontend، Radio API — قبل از Change، snapshot (status + hash
conf) و بعد از Change، مقایسه؛ هر تفاوت غیرمنتظره = **Incident** و STOP.

---

## 18. مقایسهٔ پیش/پس (Before/After Comparison)

| بُعد | پیش (ثبت‌شده، 11-11) | پس (پیش‌بینی پس از Change A+B — **هنوز اجرا نشده**) |
|---|---|---|
| اعتبار Radio | `neo4j` (admin، 14 db) + رمز placeholder | `radio_app` (read، فقط radio/radio-4b) + رمز 32-بایتی تصادفی |
| 7474 | OPEN از LAN/edge/WS | CLOSED (یا localhost-only) |
| 7687 | OPEN از LAN/edge/WS | CLOSED (یا localhost-only)؛ داخل Docker دست‌نخورده |
| blast-radius تغییر رمز | کل پلتفرم | فقط Radio |
| APOC | unrestricted + file I/O ON | (اختیاری) محدود — پس از A+B |
| سرویس‌دهی | 200/ONLINE | باید 200/ONLINE بماند (gate تست) |

---

## 19. نتایج جداسازی سرویس‌ها (Service Isolation Results)

در زمان بررسی (پیش از هر تغییر): همهٔ سرویس‌های حساس **عایق** از دروازه‌های DB
ثبت شدند — Radio API/FRontend فقط از مسیر Docker؛ Nginx/LiteLLM/GitLab/Wiki.js/NLO
روی 133 یا مسیرهای مستقل. این عایق بودن **پیش‌شرط** کم‌ریسک بودن Change B است
و در بخش 17.2 پس از اجرا هم راستی‌آزمایی می‌شود.

---

## 20. موانع باقی‌مانده (Remaining Blockers)

| # | مانع | نوع | اثر |
|---|---|---|---|
| B1 | **دسترسی root/sudo روی 53** — برای خواندن/تصویربرداری فایروال و (در صورت انتخاب گزینه) اعمال قواعد ufw | دسترسی | Change B گزینهٔ ufw + F3 |
| B2 | **انتخاب مسیر Backup** (sudo برای `/var/backups/radio` یا تأیید مسیر جایگزین `/home/saber/backups/radio/`) | تصمیم | Change A گیت A0 |
| B3 | **مجوز اجرا** برای Change A / Change B (جدا از هم) | مجوز | کل اصلاحات |
| B4 | **تأیید پلتفرمی** برای چرخش رمز مشترک `neo4j` (فراتر از Radio) و محدودسازی APOC (F1/F6) | تصمیم/هماهنگی | باقی‌ماندهٔ F1/F6 |
| B5 | **probe خارجی اینترنت** برای رد/تأیید «دسترسی عمومی 7474/7687» (از داخل قابل اثبات نیست — 53 بدون IPv4 عمومی) | دسترسی/ابزار | تکمیل ماتریس 8.1 |
| B6 | (مربوط به R1-B، نه این مأموریت) root/BT-Panel روی 133 + تأیید DNS owner | دسترسی/مجوز | R1-B |

**اصل:** `BLOCKED ≠ COMPLETE` — هیچ‌یک از این موانع «رفع‌شده» تلقی نمی‌شوند تا
وقتی دسترسی/مجوز/تصمیم واقعاً داده شود.

---

## 21. درخواست‌های مجوز (Approval Requests)

1. **مجوز Change A** (اصلاح اعتبار — بخش 12): شامل اجزای A0 (Backup) تا A6؛
   A8 (چرخش توکن‌ها) به‌صورت **جدا و اختیاری**.
2. **مجوز Backup** (بخش 14) — جدا از Change A قابل اجراست اگر کاربر بخواهد قبل
   از هر تغییری بکاپ گرفته شود؛ + انتخاب مسیر (B2).
3. **مجوز Change B** (سخت‌سازی شبکه — بخش 13) — با **انتخاب روش**:
   (الف) recreate neo4j_db با حذف/بازنشانی publish (پنجرهٔ 30–60s برای همهٔ
   محصولات) یا (ب) قواعد ufw با root (بدون recreate، نیازمند B1).
4. **تصمیم‌های کاربر:** چرخش پلتفرمی رمز `neo4j` (B4)؛ محدودسازی APOC؛
   `RestartPolicy=always` برای neo4j_db (F7)؛ probe خارجی (B5).
5. **سپس R1-B** (Nginx/HTTPS روی 133) — مطابق ترتیب مجاز
   R1-A-Security → R1-B → R1-C → R1-D.

---

## 22. حکم نهایی (Final Verdict)

- **برای اجرای اصلاحات امنیتی:** `NOT READY` تا صدور مجوزهای بخش 21 (به‌خصوص
  B1/B2/B3). طراحی‌ها کامل، تست‌های پیش‌نیاز سبز، Rollback‌ها تعریف‌شده‌اند.
- **برای R1-B (Nginx/HTTPS):** `READY WITH CAVEATS` — کار Edge روی 133 مستقل از
  DB است و قابل انجام است؛ اما **باید** قبل از R1-C (پذیرش) یا بلافاصله پس از آن،
  Change A و Change B بسته شوند چون با باز شدن عمومی دامنه، F1+F2 از «لانی» به
  «نیمه‌عمومی/عمومی» ارتقا می‌یابند.
- **شایستگی‌های اثبات‌شده این مأموریت:** همهٔ یافته‌ها Evidence-backed؛ هیچ
  تغییری در Production؛ هیچ Secret در گزارش؛ تست POST جدید انجام نشد؛ Backup اجرا
  نشد؛ Git دست‌نخورده.

---

## جدول پایانی وضعیت (Format §14 — 15 ردیف)

| # | ردیف | وضعیت |
|---|---|---|
| 1 | منبع اعتبار (Credential source) | `VERIFIED` — سه‌لایه (فایل/API/DB) هم‌hash = placeholder قالب (F1) |
| 2 | احراز مؤثر (Effective authentication) | `VERIFIED` — `neo4j`/placeholder در 6 محصول؛ auth ON (رمز اشتباه → AuthError) |
| 3 | وضعیت Neo4j | `VERIFIED` — 2025.10.1 Enterprise، ONLINE، 14 db، index ONLINE، 79,350 چانک |
| 4 | مواجههٔ پورت 7474 | `VERIFIED` — OPEN از localhost/LAN/edge/workstation (HTTP 200)؛ عمومی `NOT VERIFIED` (B5) |
| 5 | مواجههٔ پورت 7687 | `VERIFIED` — OPEN همان مواضع؛ ترافیک زنده فقط از 5 Container API (Docker) |
| 6 | اتصال Radio API | `VERIFIED` — bolt داخلی، health 200، `neo4j_online:true` |
| 7 | Vector Index | `VERIFIED` — `vector_index_chunk` ONLINE + query واقعی 33.6ms |
| 8 | یکپارچگی داده (Data integrity) | `VERIFIED` — 79,350/79,350 چانک در radio/radio-4b (در لحظهٔ بررسی) |
| 9 | وضعیت Backup | `NOT IMPLEMENTED` — طراحی کامل (بخش 14)، اجرا نیازمند مجوز + انتخاب مسیر |
| 10 | راستی‌آزمایی Restore | `NOT VERIFIED` — طرح ایزوله (14.3)، اجرا نیازمند مجوز |
| 11 | چرخش اعتبار (Credential rotation) | `NOT IMPLEMENTED` — Runbook Change A آماده (بخش 12) |
| 12 | سخت‌سازی شبکه (Network hardening) | `NOT IMPLEMENTED` — طرح 5 قاعده با Rollback (بخش 13) |
| 13 | آمادگی Rollback | `VERIFIED` — Runbook‌ها + اعتبار قدیمی تا اثبات جدید حذف نمی‌شود |
| 14 | تست‌های رگرسیون | `VERIFIED` (پیش‌تست‌ها سبز) — ماتریس پس از اجرا در 17.2 |
| 15 | وضعیت Git | `VERIFIED` — رپوی radio: HEAD 5df4c8d، تمیز (1 untracked از قبل)؛ NLO: main 2235c3e؛ **این گزارش untracked**؛ هیچ Commit/Push |

### A) چه چیزی کشف شد (و ریشه + شواهد)

1. **F1 (Critical):** رمز admin Neo4j در کل پلتفرم = placeholder قالب — ریشه:
   deploy اولیهٔ `NEO4J_AUTH` هرگز چرخش نخورده و envها از همان قالب کپی شده‌اند —
   شواهد: سه‌گانهٔ hash (بخش 6.2).
2. **F2 (High):** 7474/7687 روی `0.0.0.0` — ریشه: publish Docker + `default_listen_address` —
   شواهد: ماتریس 8.1 + `docker port`.
3. **F3 (High):** فایروال هاست اثبات‌نشده — ریشه: نبود دسترسی root — شواهد: خطای
   `Operation not permitted` در nft/ufw.
4. **F4 (High):** Neo4j مشترک ۱۴ db — شواهد: `SHOW DATABASES`.
5. **F5 (Medium):** Near-miss نمایش ترمینالی + توکن‌های چرخش‌نیافته — ریشه: خطای
   اسکریپت masking — شواهد: بخش 6.3.
6. **F6 (High ترکیبی):** APOC unrestricted + file I/O — شواهد: env neo4j_db.
7. **F7/F8/F9 (Medium/Low):** RestartPolicy=no، PermitRootLogin yes، TLS-off —
   شواهد: inspect/conf.
8. **معماری مصرف:** فرانت‌ها صفر DB؛ appها فقط Docker-internal — شواهد: ESTAB.

### B) چه چیزی واقعاً اصلاح شد (در این مأموریت)

**صفر** — مطابق دستور مأموریت، هیچ Change عملیاتی اجرا نشد. (فقط خودِ گزارش و
اسکریپت‌های یک‌بارمصرف که پس از اجرا حذف شدند.)

### C) چه چیزی اصلاح نشد (و چرا BLOCKED/NOT IMPLEMENTED)

چرخش اعتبار، سخت‌سازی شبکه، Backup و تست restore — **همگی فقط طراحی‌شده**؛
دلیل: نیازمند مجوز جداگانه (B3)، دسترسی root (B1) و تصمیم مسیر بکاپ (B2) است.
همچنین F1-پلتفرمی و F6 خارج از Scope مجازِ این مأموریت‌اند.

### D) چه چیزی نیاز به کاربر دارد (دسترسی / اعتبار / مجوز / تصمیم)

| مورد | نوع |
|---|---|
| sudo/root روی 53 (فقط برای snapshot + قواعد ufw در صورت انتخاب) | دسترسی |
| انتخاب مسیر Backup (`/var/backups/radio` با sudo یا `/home/saber/backups/radio/`) | تصمیم |
| مجوز Change A (+ گزینهٔ A8 چرخش توکن‌ها) | مجوز |
| مجوز Change B + انتخاب روش (recreate یا ufw) | مجوز + تصمیم |
| تصمیم چرخش پلتفرمی رمز `neo4j` و محدودسازی APOC (هماهنگی با 6 محصول) | تصمیم |
| ابزار/دسترسی برای probe خارجی (B5) | دسترسی |
| مجوز R1-B پس از اتمام | مجوز |

### E) شایستگی برای R1-B

**`READY WITH CAVEATS`** — R1-B (Nginx/HTTPS روی 133) می‌تواند آغاز شود چون
مستقل از DB است؛ شرط: Change A و Change B پیش از R1-C (پذیرش عمومی) بسته شوند و
موانع B1–B5 در جریان رها شوند.

---

## صورت‌حساب ایمنی و توقف (Safety Ledger + Mandatory STOP)

- **تغییر در Production/DB/رمز/Firewall/Docker:** صفر مورد
- **Commit/Push/Restart/Deploy:** صفر
- **POST /api/chat یا RRF زنده جدید:** صفر (ممنوع بود)
- **اجرای Backup:** صفر (ممنوع بود)
- **Secret در این گزارش:** صفر (فقط نام متغیر + hash 16-کاراکتری + placeholder
  عمومی قالب که در گزارش R1-A هم ثبت شده بود)
- **نزدیک‌ترین اتفاق:** Near-miss بخش 6.3 — ثبت شد، بدون افشای خارجی
- **Git:** رپوی radio و NLO دست‌نخورده؛ این گزارش **untracked** باقی است
- **اسکریپت‌های بررسی:** همه یک‌بارمصرف و پس از اجرا از 53 حذف شدند

> **توقف اجباری (مطابق §15 مأموریت):** این مأموریت در همین‌جا متوقف می‌شود.
> **R1-B آغاز نمی‌شود.** هیچ Nginx/SSL/DNS/Commit انجام نمی‌شود. منتظر:
> (1) پاسخ به D (دسترسی/تصمیم)، (2) مجوز جداگانه Change A، (3) مجوز جداگانه
> Change B، و سپس (4) تأیید صریح کاربر برای شروع R1-B.
>
> **اصل پایبندی‌شده:** حفاظت از داده و حفظ سرویس production، بر سرعت مقدم است؛
> هیچ موفقیتی بدون Evidence اعلام نشده است.

---

# الحاقیهٔ اصلاحی ۱ (R1-A.1) — اعتبارسنجی طراحی و اصلاح Runbook (نسخهٔ نهایی، Live-Verified v3)

> **مأموریت:** R1-A.1 — اعتبارسنجی طراحی‌های Change A / Change B / Backup و اصلاح Runbook
> **تاریخ:** 2026-11-11 (ادامهٔ R1-A-Security؛ بدنهٔ گزارش، بخش‌های ۱ تا ۲۲، **دست‌نخورده** است)
> **حالت:** Read-only — با **یک استثنأ مجازشده**: `docker start neo4j_db` (تأیید صریح کاربر، 2026-11-11 16:54 UTC)
> **سطح راستی‌آزمایی این الحاقیه:** **Live verified** روی 2025.10.1 Enterprise در هاست 53 (16:52–17:33 UTC)
> **اسکریپت‌های یک‌بارمصرف (همه پس از اجرا از 53 حذف شدند):** r1a1_bootcheck / r1a1_neo4jdiag / r1a1_startneo / r1a1_api / r1a1_ragcheck / r1a1_envfull / r1a1_neo4jhost / r1a1_iptnosh / r1a1_fwbackup / r1a1_rbac (v1) / r1a1_rbac2 / r1a1_rbac3 / r1a1_rbac4 / r1a1_rbac5 / r1a1_rbac5b / r1a1_rbac6 / r1a1_prog
> **اعتبار اجرایی:** جداول Runbook این الحاقیه (**نسخهٔ ۳**) جایگزین بخش‌های ۱۲/۱۳/۱۴ بدنهٔ گزارش برای **اجرا** می‌شوند.

---

## خ-0. خلاصهٔ اجرا و استثنای مجاز

1. **بازگشت شبکه** کاری‌استیشن به 172.20.x.x در حدود 16:52 UTC.
2. **کشف فوریت پس از reboot هاست 53:** `neo4j_db` در وضعیت `Exited (255)` مانده بود چون
   `RestartPolicy=no` (همهٔ Containerهای دیگر `unless-stopped`/`always`ند) و `radio_api`
   در حلقهٔ restart قرار داشت (RestartCount 13). **این خودِ ریسک F7 را زنده اثبات کرد.**
3. **تنها تغییر مجاز این مأموریت:** `docker start neo4j_db` — آماده‌شدن ~5 ثانیه، 14 دیتابیس
   ONLINE، `radio_api` سالم (running، RestartCount 14).
4. **پس از هر probe، وضعیت Neo4j به خط صفر بازگشت** (هر بار تأییدشده):
   `SHOW USERS` → فقط `neo4j` (admin+PUBLIC، passwordChangeRequired=FALSE)؛
   `SHOW ROLES` → 6 نقش پیش‌فرض (PUBLIC, admin, architect, editor, publisher, reader).
   هیچ role/user testی باقی نمانده است.

---

## خ-1. ایراد ۱ — RBAC: حقیقت زندهٔ Neo4j 2025.10.1

### خ-1.1. دستورات معتبر/نامعتبر (همه Live-Verified روی نمونهٔ زندهٔ 2025.10.1)

| دستور | نتیجهٔ زنده | شواهد (خطا دقیق) |
|---|---|---|
| `CREATE ROLE r;` / `CREATE USER u SET PASSWORD 'p';` | ✅ | rbac3/rbac4 |
| `GRANT ACCESS ON DATABASE radio TO r;` | ✅ | rbac1/3/6 |
| `GRANT ACCESS ON DATABASE radio-4b TO r;` (بدون علامت) | ❌ | rbac1: `Invalid input '-', expected: a database name, ',' or 'TO'` |
| `GRANT ACCESS ON DATABASE "radio-4b" TO r;` (دوگوش) | ❌ | rbac2: `Invalid input '"radio-4b"', expected: a database name` |
| `` GRANT ACCESS ON DATABASE `radio-4b` TO r; `` (بکتیک) | ✅ | rbac3/5b/6 |
| `GRANT MATCH ON GRAPH radio TO r;` (سینتکس 5.x) | ❌ | rbac1/2: `Invalid input 'ON', expected: '{'` |
| `GRANT MATCH { NODES(*), RELATIONSHIPS(*) } ON GRAPH radio TO r;` | ❌ | rbac2: `Invalid input '(', expected: ',' or '}'` |
| `GRANT MATCH { NODES, RELATIONSHIPS } ON GRAPH radio TO r;` | ✅ **اما فریبنده — ببینید خ-1.2** | rbac3 |
| `GRANT MATCH { * } ON GRAPH radio TO r;` | ✅ **خواندن کامل (all properties)** | rbac5b/6 |
| `GRANT MATCH { embedding } ON GRAPH radio TO r;` | ✅ (یک property مشخص) | rbac5b |
| `ALTER USER u SET PASSWORD CHANGE NOT REQUIRED;` | ✅ (پرچم TRUE→FALSE) | rbac5b |
| `ALTER USER u SET PASSWORD 'p' PASSWORD CHANGE NOT REQUIRED;` | ❌ | rbac2: `expected: 'CHANGE', 'SET' or <EOF>`؛ همچنین 22N89 برای همان رمز |
| `GRANT SHOW DATABASES TO r;` / `GRANT PRIVILEGE SHOW DATABASES TO r;` / `GRANT SHOW DATABASES ON DATABASE db TO r;` | ❌ هر سه | rbac1/2/3/6: `Invalid input 'SHOW'/'DATABASES'` |
| `SHOW PRIVILEGES FOR ROLE r;` | ❌ | rbac1: `Invalid input 'FOR'` |
| `SHOW ROLES FOR CURRENT USER;` | ❌ | rbac3: `Invalid input 'CURRENT', expected: 'PRIVILEGE' or 'PRIVILEGES'` |
| `SHOW USERS;` (ستون‌های roles + passwordChangeRequired + suspended) | ✅ | rbac3/5b/6 |
| `SHOW PRIVILEGES YIELD action, resource, graph, segment, role WHERE role='r' RETURN ...;` | ✅ **دستور صحیح برای فهرست مجوزهای یک role** | rbac3/5b/6 |

**یافتهٔ کلیدی ۱ — نقش جدید:** کاربر تازه‌ساخته با `passwordChangeRequired=TRUE` شروع می‌شود و
**هر query** او با `42NFD: credentials expired. ... must be changed` رد می‌شود، مگر:
`ALTER USER u SET PASSWORD CHANGE NOT REQUIRED;` (دستور مستقل، بدون رمز).

**یافتهٔ کلیدی ۲ — `SHOW DATABASES` بدون هیچ grant خاص:** کاربر محدود در **session پیش‌فرض**
(بدون `--database`) دستورات `SHOW DATABASES YIELD name, currentStatus WHERE name='radio'`
و `MATCH (n) RETURN count(n)` را با موفقیت اجرا کرد (rbac3 T3a/T3b/T5/T5b، rbac6 4f) —
یعنی **neither `GRANT ACCESS ON DATABASE neo4j` nor any `SHOW DATABASES` privilege is
required** for `/api/health`. این فرض نسخهٔ ۲ (خ-1.2 قبلی/بخش ۱۲ بدنه) را **ساده‌سازی** می‌کند.

### خ-1.2. کشف تصمیم‌ساز: دیدپذیری Property (دام «NODES/RELATIONSHIPS»)

در 2025.10.1، محتوای `{ ... }` در `GRANT MATCH { ... } ON GRAPH` **نام property** است، نه
دستهٔ دادهٔ 5.x. آنچه واقعاً در catalog ثبت می‌شود (خروجی زندهٔ `SHOW PRIVILEGES`):

| grant | ثبت‌شده (action/resource/segment) | اثر زندهٔ اندازه‌گیری‌شده |
|---|---|---|
| `GRANT MATCH { NODES, RELATIONSHIPS }` | `property(NODES)` + `property(RELATIONSHIPS)` روی NODE(\*) و RELATIONSHIP(\*) — یعنی دو **property با نام** «NODES» و «RELATIONSHIPS» | فقط entity: `keys(n) → []`؛ `WHERE n.embedding IS NOT NULL → 0`؛ `WHERE n.program_name IS NOT NULL → 0`؛ VQ → **0 hit** |
| `GRANT MATCH { ALL }` | `property(ALL)` (یک property با نام «ALL») | همان وضعیت نامرئی (0 hit) |
| `GRANT MATCH { * }` | **`all_properties`** روی NODE(\*) و RELATIONSHIP(\*) | کامل: `keys(n) → 38 key`؛ `embedding NOT NULL → 79,350`؛ VQ → **3 hit، score 0.5468377470970154 — دقیقاً برابر مقدار neo4j/admin** |
| `GRANT MATCH { embedding }` | `property(embedding)` | `embedding NOT NULL → 79,350` |

نقش داخلی `reader` نیز دقیقاً `match all_properties` روی هر دو segment دارد — معادلِ
«خواندن کامل» در مدل جدید.

**تفسیر ریسک:** اگر Change A با Runbook نسخهٔ ۱/۲ اجرا می‌شد (`GRANT MATCH ON GRAPH` یا
نزدیک‌ترین جایگزینِ قابل‌اجرا `{ NODES, RELATIONSHIPS }`)، نتیجه **نه خطا، بلکه رگرسیونِ
ساکت** بود: `/api/chat` بدون منبع (VQ → 0 hit) و `/api/programs` خالی — در حالی که
`/api/health` «ok» گزارش می‌داد. این ایراد اصلی طراحی قبلی بود و اکنون با `MATCH { * }`
اصلاح و **زنده اثبات** شد.

### خ-1.3. مجموعهٔ مجوزهای نهایی (Change A — نسخهٔ ۳)

```
CREATE ROLE radio_read;
GRANT ACCESS ON DATABASE radio TO radio_read;
GRANT ACCESS ON DATABASE `radio-4b` TO radio_read;
GRANT MATCH { * } ON GRAPH radio TO radio_read;
GRANT MATCH { * } ON GRAPH `radio-4b` TO radio_read;
CREATE USER radio_app SET PASSWORD '<32-byte random, on-server generated>';
ALTER USER radio_app SET PASSWORD CHANGE NOT REQUIRED;   -- الزامی (42NFD)
GRANT ROLE radio_read TO radio_app;
```

- **بدون** `GRANT ACCESS ON DATABASE neo4j` — زنده اثبات شد لازم نیست (خ-1.1، یافتهٔ ۲).
- **بدون** هیچ مجوز نوشتن/APOC/GDS/procedure: بررسی کامل `api.py` (رادیو) دو خانوادهٔ
  query را نشان می‌دهد و هر دو read-only‌اند (خ-4).
- `verify_connectivity()` (api.py:87) فراخوانی پروتکلی در سطح driver است؛ با اعتمادسازی
  جدید، **اولین** آیتم باتری A7 است (اتصال bolt با cypher-shell در همهٔ probeها اثبات شده).

### خ-1.4. Runbook نسخهٔ ۳ — Change A (جایگزین بخش ۱۲ برای اجرا)

| مرحله | عمل (cypher-shell `-u neo4j` مگر ذکر شود) | Pre-check | Post-check | Rollback | Stop-criteria |
|---|---|---|---|---|---|
| A0 | Backup کامل طبق خ-3.4 — **پیش از هر A** اجباری | 14 db ONLINE؛ 6362 listening | MANIFEST + sha256 همهٔ فایل‌ها | — | هر خطا → STOP |
| A1 | `CREATE ROLE radio_read;` | `SHOW ROLES;` (radio_read نیست) | در `SHOW ROLES;` دیده می‌شود | `DROP ROLE radio_read;` | خطا → STOP (چیزی ساخته نشده) |
| A2 | `GRANT ACCESS ON DATABASE radio TO radio_read;` + `` GRANT ACCESS ON DATABASE `radio-4b` TO radio_read; `` | — | `SHOW PRIVILEGES YIELD action,resource,graph,segment,role WHERE role='radio_read' RETURN ...;` → 2 ردیف access | `REVOKE ACCESS ON DATABASE radio FROM radio_read;` + `` REVOKE ACCESS ON DATABASE `radio-4b` FROM radio_read; `` | خطا → A1 rollback |
| A3 | `GRANT MATCH { * } ON GRAPH radio TO radio_read;` + `` GRANT MATCH { * } ON GRAPH `radio-4b` TO radio_read; `` | — | همان query → 4 ردیف `all_properties` (2× radio + 2× radio-4b) | `REVOKE MATCH { * } ON GRAPH radio FROM radio_read;` + `` REVOKE MATCH { * } ON GRAPH `radio-4b` FROM radio_read; `` | خطا → A2 rollback |
| A4 | `CREATE USER radio_app SET PASSWORD '<generated>';` | `SHOW USERS;` (فقط neo4j) | `SHOW USERS YIELD user, roles, passwordChangeRequired WHERE user='radio_app';` → موجود، passwordChangeRequired=**TRUE** | `DROP USER radio_app;` | خطا → A3 rollback |
| A5 | `ALTER USER radio_app SET PASSWORD CHANGE NOT REQUIRED;` | — | همان query → passwordChangeRequired=**FALSE** | — | خطا → A4 rollback + A3/A2 |
| A6 | `GRANT ROLE radio_read TO radio_app;` | — | `SHOW USERS YIELD user, roles WHERE user='radio_app';` → roles شامل radio_read | `REVOKE ROLE radio_read FROM radio_app;` | خطا → A4–A2 rollback |
| A7 | **باتری تست ایزوله با radio_app** (پیش از تغییر env) — ۹ آیتم، جدول خ-1.5 | — | هر ۹ آیتم PASS | `DROP USER radio_app; DROP ROLE radio_read;` | هر FAIL → STOP + cleanup + گزارش |
| A8 | ویرایش `.env.radio` (فقط `NEO4J_USERNAME`/`NEO4J_PASSWORD`) + `docker compose up -d radio_api`؛ env قبلی 0600 آرشیو | بکاپ env موجود | `/api/health` → `neo4j_online:true` و `status:ok`؛ `/api/programs` → 200 و **غیرخالی**؛ یک `/api/chat` کنترل‌شده (در صورت مجوز) | env قبلی + recreate (اعتمادسازی `neo4j` تا حذفِ صریح آن معتبر است) | degraded/500/خالی → A8 rollback |
| A9 | سایر محصولات **دست‌نخورده**؛ اعتبار `neo4j` برای 6 محصول دیگر بدون تغییر (F1 پلتفرمی = تصمیم جدا، B4) | — | — | — | — |

**دقت:** A8 تنها recreate می‌کند `radio_api` را. `neo4j_db` و 6 Container دیگر **اصلاً**
لمس نمی‌شوند.

### خ-1.5. باتری A7 — همهٔ آیتم‌ها با role موقت در این مأموریت Live-Passed

| # | تست (با کاربر/role محدود) | انتظار | نتیجهٔ زنده |
|---|---|---|---|
| 1 | `--database radio` → `MATCH (n) RETURN count(n);` | 79,350 | ✅ 79,350 (rbac6 4a) |
| 2 | `--database radio-4b` → `MATCH (n) RETURN count(n);` | 79,350 | ✅ 79,350 (rbac6 4b) |
| 3 | `--database radio` → VQ `vector_index_chunk` با بردار 1024بُعدی | 3 hit | ✅ 3 hit، min-score 0.5468377470970154 — **parity کامل با neo4j/admin** (rbac6 4c) |
| 4 | `--database radio-4b` → VQ روی `vector_index_chunk` | 3 hit با بردار **2560بُعدی** (این db از مدل embed متفاوت) | ✅ عدم خطای دسترسی؛ بردار 1024بُعدی آزمون‌شده → `52U00 ... 1024 dimensions, but indexed vectors have 2560` (مطابقت بعدی، نه دسترسی) — اپ رادیو per-DB embed دارد (rbac6 4d) |
| 5 | `--database radio` → `MATCH (n:Chunk) LIMIT 1 RETURN keys(n);` | 38 key | ✅ 38 key کامل (rbac6 4e) |
| 6 | session پیش‌فرض → `SHOW DATABASES YIELD name, currentStatus WHERE name='radio';` | radio/online | ✅ (rbac6 4f) |
| 7 | حلقهٔ 10 db دیگر (mesbah, taghrir, taghrir-10, taghrir-50, taghrir-100, falsafe-siasi-1000-embed-06b, falsafe-siasi-qwen3-embed-06b, falsafe-siasi-qwen3-embed-4b, tasnim-qwen3-embed-06b, import-test-06b) → `MATCH (n) RETURN count(n);` | همه 42NFF | ✅ 10/10 `42NFF ... Access denied` (rbac3 T4 + rbac6 4g) |
| 8 | `--database system` → `MATCH (n) RETURN count(n);` | ردشدن | ✅ `42NA9` (system procedure rules) (rbac3 T4) |
| 9 | منفی‌های نوشتن: `CREATE (t:Tmp) RETURN t;` و `MATCH (n:Chunk) SET n.r1as_tmp=1 RETURN count(n);` | هر دو 42NFF | ✅ هر دو `42NFF Access denied` (rbac4 8a/8b) |

**نتیجهٔ اثباتی (مأموریت، بند ۱):** radio_app با مجموعهٔ خ-1.3: Nodes ✅ / Relationships ✅
/ Vector Query ✅ (parity زنده) / PUBLIC (عضویت پیش‌فرض، بدون تداخل) ✅ / **عدم دسترسی به
سایر dbها ✅ (10/10 + system)**.

---

## خ-2. ایراد ۲ — Docker Firewall / NAT (Change B — نسخهٔ ۳)

### خ-2.1. حقایق زندهٔ این نشست

- `iptables -S` بدون root: `Permission denied (you must be root)` (r1a1_iptnosh)؛ saber عضو
  گروه‌های `sudo`/`docker` است ولی **sudo بدون رمز ندارد** → snapshot زنجیرهٔ `DOCKER-USER`
  هنوز **دسترسی کاربر** است (مانع B1 بدنهٔ گزارش، بدون تغییر).
- UFW پیش‌فرض روی پورت‌های published Docker اثر ندارد (NAT در زنجیره‌های DOCKER/FORWARD).
- نقطهٔ کنترل صحیح = زنجیرهٔ `DOCKER-USER` (پیش از NAT).
- **پس از reboot:** همهٔ Containerها برگشتند **جز neo4j_db** (RestartPolicy=no). در نتیجه:
  پنجرهٔ recreate در روش ۱ حساس‌تر از پیش است — اگر neo4j_db در پنجرهٔ recreate به هر
  علتی خراب شود، **خودکار برنمی‌گردد**.

### خ-2.2. مقایسهٔ روش‌ها (به‌روزشده)

| معیار | روش ۱: حذف/بازنشانی Publish + recreate | روش ۲: قواعد در DOCKER-USER |
|---|---|---|
| نیاز به recreate neo4j_db | بله (پنجرهٔ 30–60s) | خیر |
| نیاز به root | خیر (compose) | بله (iptables) — B1 |
| blast radius در پنجره | **7 محصول** (خ-5) موقتاً بدون DB (اتصال retry) | صفر |
| ماندگاری بعد از reboot | بله (compose) | خیر — systemd unit یا پذیرش ناپایداری + مستندسازی |
| بازگشت (rollback) | revert compose + recreate (1–2 دقیقه) | `iptables -D DOCKER-USER ...` (دقیقاً معکوس) |
| ریسک اضافه | **F7 زنده شد در این نشست** → پیش‌شرط: `RestartPolicy=always` (تصمیم کاربر، B4/خ-10) | دقت در source-IP (خطا = قطع ترافیک Docker-internal) |

### خ-2.3. Runbook نسخهٔ ۳ — Change B

**پیش‌شرط مشترک (هر روش):** (a) `RestartPolicy=always` برای neo4j_db (در غیر این صورت
**STOP** — ریسک ثابت‌شده در خ-0.2)؛ (b) A0/backup کامل.

**روش ۱ (حذف Publish):**
- Pre: `docker port neo4j_db` (ثبت فعلی)؛ `docker inspect neo4j_db -f '{{.HostConfig.RestartPolicy.Name}}'` → `always`
- Exec: ویرایش compose (حذف `ports:` یا `127.0.0.1:7687:7687` / `127.0.0.1:7474:7474`) + `docker compose up -d neo4j_db`
- Post: `docker port neo4j_db` → خالی یا localhost-only؛ probe از LAN/edge → CLOSED؛ `SHOW DATABASES` → 14 ONLINE؛ `/api/health` هر 7 API → ok؛ ESTAB داخل Docker (از 15.15.12.x) → OPEN
- Rollback: revert compose + recreate (1–2 دقیقه)
- Stop: health هر API ≠ ok، یا هر db ≠ ONLINE، یا ESTAB داخلی ریخت → فوراً rollback

**روش ۲ (DOCKER-USER):**
- Pre: `sudo iptables -S DOCKER-USER` (snapshot)؛ `sudo iptables -S DOCKER | head` (ثبت)
- Exec: `sudo iptables -I DOCKER-USER -p tcp --dport 7687 ! -s 15.15.12.0/24 ! -s 127.0.0.1 -j DROP` + همان برای 7474
- Post: probe از LAN → CLOSED؛ از داخل Docker → OPEN؛ `/api/health` هر 7 API → ok
- Rollback: `sudo iptables -D DOCKER-USER ...` (دقیقاً معکوس هر قاعده)
- Stop: ترافیک Docker-internal هم قطع شد → فوراً rollback (خطای source-IP)

---

## خ-3. ایراد ۳ — Backup (نسخهٔ ۳)

### خ-3.1. کشف 6362 (Live) — ارتقای وضعیت مسیر physical

- **Backup service در حال اجراست:** پورت 6362 روی `::ffff:127.0.0.1:6362` **داخل**
  Container `neo4j_db` شنونده است (کشف از `/proc/net/tcp6` — hex `18DA`؛ `ss` بدون root
  فقط 7474/7687 را نشان داد). خطوط backup در `neo4j.conf` comment‌اند → **رفتار پیش‌فرض
  Enterprise** (enabled روی loopback).
- نتیجه: **recreate یا تغییر conf برای backup physical لازم نیست** —
  `docker exec neo4j_db neo4j-admin database backup ...` همان loopback درون‌Container را
  می‌سازد. در ماتریس تصمیم، «Backup (physical)» از *نیازمند بررسی* به **تأیید فنی** ارتقا یافت
  (با شرط تست restore ایزولهٔ B7، بدون تغییر).
- `neo4j-admin database backup --help` (خروجی زنده): پشتیبانی از
  `--to-path=...`، `--compress`، `--from=<host:port>` و **`--include-metadata=none|all|users[=user1,user2]|roles`**.

### خ-3.2. dump vs backup (اصلاح‌شده با شواهد زنده)

| معیار | `neo4j-admin database dump` | `neo4j-admin database backup` (Enterprise) |
|---|---|---|
| نوع | logical (آرشیو تک‌فایل) | **physical** (store + TX log، آنلاین/online) |
| نیاز به backup service | خیر | بله — **اما در این هاست فعال است (خ-3.1)** |
| متادیتای user/role | خیر — جداگانه لازم است | **بله، با `--include-metadata=users,roles`** (ثابت‌شده از --help) |
| دیتابیس system | جداگانه | جداگانه |
| سازگاری نسخهٔ restore | ≥ نسخهٔ dump | **دقیقاً همان نسخه** (2025.10.1) |
| پیشینه در این هاست | ✅ `mesbah.dump` 1.4GB (6 اکتبر) VERIFIED | جدید (اما service فعال) |
| restore | `neo4j-admin database load` | `neo4j-admin database restore` (+`--overwrite` برای db خالی) |

### خ-3.3. مسیر پیشنهادی (پاسخ به بند ۳ مأموریت)

**ترجیحی: `backup` physical با `--include-metadata=users,roles`** — بدون هیچ تغییر
پیکربندی (6362 از پیش فعال)، online، سریع‌تر، و user/role را هم می‌گیرد.
**جایگزین (fallback): `dump` logical** — اگر در لحظهٔ اجرا service 6362 خامش پیدا شد
یا نسخهٔ مقصد restore متفاوت خواهد بود؛ پیشینهٔ موفق دارد.
**مکمل اجباری در هر مسیر:** system db (dump) + `neo4j.conf` + compose + `.env.radio`
(به‌صورت `env-secrets-<ts>.bin`، 0600) + `docker inspect` + MANIFEST.

### خ-3.4. Runbook نسخهٔ ۳ — Backup

| مرحله | عمل | Pre | Post | Rollback | Stop |
|---|---|---|---|---|---|
| B0 | انتخاب مسیر: `/var/backups/radio/` (با sudo) یا `/home/saber/backups/radio/` (تصمیم کاربر) | `df -h` (آزادی کافی) | `mkdir -p` + `chmod 700` | — | فضا < 20G → STOP |
| B1 | `docker exec neo4j_db neo4j-admin database backup --to-path <مسیر درون volume داده> --include-metadata=users,roles` برای `radio` و `radio-4b` (و در صورت خواسته، بقیهٔ radio-محورها)؛ سپس `docker cp neo4j_db:<مسیر> <host:مسیر B0>/` | 6362 listening (`ss` با sudo یا /proc) | آرشیو‌ها موجود + `sha256sum` | — | هر خطا → STOP |
| B2 | `docker exec neo4j_db neo4j-admin database dump system --to-path <volume>` + `docker cp` (توصیه) | — | فایل موجود | — | — |
| B3 | `docker exec neo4j_db cypher-shell -u neo4j -p <pw> "SHOW USERS;"` + `SHOW ROLES;` + `SHOW PRIVILEGES YIELD ...;` → متن 0600 | — | فایل موجود | — | — |
| B4 | کپی `neo4j.conf` + `docker-compose` + `.env.radio` (→ `env-secrets-<ts>.bin` 0600) | — | همه موجود + sha256 | — | — |
| B5 | `docker inspect radio_api neo4j_db radio_frontend` → JSON | — | فایل موجود | — | — |
| B6 | `MANIFEST.sha256` (همهٔ فایل‌ها) + `MANIFEST.txt` (تاریخ، نسخهٔ Neo4j، 14 db، count 79,350) | — | MANIFEST موجود | — | — |
| B7 | **تست Restore ایزوله:** Container موقت 2025.10.1 (بدون publish، volume جدا) + `restore` radio + ۴ چک: (a) count=79,350؛ (b) index ONLINE؛ (c) VQ → 3 hit؛ (d) تطابق hash conf | Container موقت ساخته شد | ۴/۴ PASS | حذف Container موقت | هر FAIL → STOP + بررسی آرشیو |

**نکات اجرایی:** (1) خروجی داخل Container **باید روی volume داده** بنشیند (فایل‌سیستم
Container ephemeral است) و سپس با `docker cp` بیرون آورده شود؛ (2) B7 **نیازمند مجوز
جداگانه** است (Container موقت = تغییر موقت Docker، بدون publish و بدون اثر روی تولید).

---

## خ-4. بررسی کامل queryهای Radio API (بند ۴ مأموریت) — با شواهد زندهٔ grep

| Endpoint | Cypher/Procedure (ثابت‌شده از api.py زنده) | db | مجوز لازم |
|---|---|---|---|
| `/api/chat`، `/api/chat/stream`، `/api/v1/qa/stream`، `/api/v1/chat/completions` (retrieve/RRF) | `CALL db.index.vector.queryNodes($idx, $k, $q) YIELD node, score ...` (api.py:118) | radio **و** radio-4b (RRF دو بار) | ACCESS + `MATCH { * }` (هر دو) |
| `/api/programs` | `MATCH (n:Chunk) WHERE n.program_name IS NOT NULL ...` (api.py:694) | radio | ACCESS + `MATCH { * }` |
| `/api/health` | `SHOW DATABASES YIELD name, currentStatus WHERE name=$n` (api.py:550-554، **session پیش‌فرض** `_driver.session()`) | پیش‌فرض | هیچ grant اضافی (خ-1.1 یافتهٔ ۲) |
| استارتاپ (api.py:86-87) | `GraphDatabase.driver(...)` + `_driver.verify_connectivity()` | پروتکل (بدون query) | احراز اعتبار صحیح؛ در A7 بازتست |
| همهٔ `retrieve*` | `MATCH (n:Chunk)` + خواندن properties (chunk_text, citation, ...) | radio / radio-4b | همان (visibility property با `MATCH { * }`) |

**نتیجه:** radio_app فقط `ACCESS` + `MATCH { * }` روی radio/radio-4b نیاز دارد.
هیچ `CREATE/SET/DELETE/MERGE/REMOVE` و هیچ `CALL apoc.*`/`gds.*` در api.py وجود ندارد
→ **فقط خواننده**. نکتهٔ مهم: index `vector_index_chunk` در radio **1024بُعدی** و در
radio-4b **2560بُعدی** است (مدل‌های embed متفاوت) — API رادیو per-DB embed می‌کند؛
هر آزمون/پایش بعدی باید بعد صحیح را به‌کار ببرد.

---

## خ-5. ناسازگاری شمارش APIها و وضعیت ragportal_api (بند ۵) — **اصلاح‌شده**

**حقیقت زنده (r1a1_api / r1a1_ragcheck / r1a1_envfull):** `ragportal_api` **Up** است
(نه Exited، برخلاف فرض نسخهٔ پیشین این الحاقیه). شمارش واقعی = **7 API فعال** متصل به
Neo4j: `radio_api, mesbah_api, eiis_api, taghrir_api, tasnim_api, sources_api, ragportal_api`.

- هر 7 با placeholder-password قالب (sha256 پیشوند `cfb62cc80de05545`) — env با پیشوند
  `NEO4J_*` **به‌جز** `sources_api` که پیشوند `SOURCES_*` دارد
  (`SOURCES_NEO4J_URI=bolt://neo4j_db:7687`، `SOURCES_RADIO_DB=radio` → **sources_api
  مستقیماً dbِ `radio` را می‌خواند**).
- `ragportal_api` هم `QA_CORPUS_NEO4J_PW`/`QA_RADIO_NEO4J_PW` (placeholder) دارد.
- **تأثیر بر طراحی:** (1) blast radius روش ۱ = **7 محصول**؛ (2) چرخش پلتفرمی رمز `neo4j`
  (F1) 7 env را شامل می‌شود، نه 6؛ (3) هر تغییر آتی روی db `radio` مستقیماً
  sources_api را هم لمس می‌کند.

---

## خ-6. Pre/Execution/Post/Rollback/Stop (بند ۶)

- **Change A:** جدول خ-1.4 (A0–A9) + باتری خ-1.5.
- **Change B:** خ-2.3 (هر دو روش، با پیش‌شرط RestartPolicy).
- **Backup:** خ-3.4 (B0–B7).
- **معیارهای توقفِ سراسری:** (1) هر FAIL در باتری A7 پیش از A8؛ (2) هر health ≠ ok برای
  هر 7 API در هر Post-check؛ (3) هر db ≠ ONLINE؛ (4) هر خطای restore در B7؛ (5) فضا < 20G
  در B0. در همهٔ موارد: rollback مطابق جداول، سپس STOP و گزارش — **ادامه بدون گزارش ممنوع**.

---

## خ-7. تحلیل Blast Radius (بند ۷) — **اصلاح‌شده**

| تغییر | blast radius (حقیقت زنده) | توضیح |
|---|---|---|
| **Change A** | **1 محصول (Radio)** | فقط `radio_api` recreate می‌شود؛ neo4j و 6 API دیگر دست‌نخورده |
| **Change B روش ۱** | **7 محصول (موقتی 30–60s)** | recreate neo4j_db؛ اتصال‌ها retry می‌کنند؛ دادهٔ bind-mounted دست‌نخورده |
| **Change B روش ۲** | **صفر** | فقط ترافیک بیرونی به 7474/7687 می‌افتد؛ Docker-internal دست‌نخورده |
| **Backup (هر مسیر)** | **صفر** | online (خ-3.1) |

---

## خ-8. ماتریس تصمیم (Decision Matrix — نهایی)

| طرح / مورد | وضعیت | شواهد / شرط |
|---|---|---|
| **Change A (radio_app + RBAC v3)** | ✅ **تأیید فنی** (طراحی اصلاح‌شده) | خ-1؛ همهٔ ۹ تست باتری A7 با role موقت Live-Passed؛ blast=1 محصول |
| **Change B روش ۱ (unpublish + recreate)** | ✅ **تأیید فنی (مشروط)** | خ-2؛ پیش‌شرط: `RestartPolicy=always` (F7)؛ blast=7 محصول (موقتی 30–60s) |
| **Change B روش ۲ (DOCKER-USER)** | ✅ **تأیید فنی (جایگزین)** | خ-2؛ blast=صفر؛ نیازمند sudo (B1) |
| **Backup — physical (6362)** | ✅ **تأیید فنی** (از «نیازمند بررسی» ارتقا) | خ-3.1 — 6362 از پیش listening؛ بدون تغییر conf؛ `--include-metadata=users,roles` |
| **Backup — dump (logical)** | ✅ **تأیید فنی (fallback)** | پیشینهٔ mesbah.dump؛ بدون نیاز به service |
| **تست Restore ایزوله (B7)** | ⏳ **نیازمند مجوز جداگانه** | Container موقت = تغییر موقت Docker |
| **دسترسی/تصمیم‌های مورد نیاز کاربر** | لیست | (a) sudo/root روی 53 (iptables snapshot + قواعد روش ۲ + در صورت انتخاب `/var/backups`)؛ (b) انتخاب مسیر Backup؛ (c) مجوز Change A (با A0)؛ (d) مجوز Backup؛ (e) مجوز Change B + انتخاب روش + تصمیم RestartPolicy (F7)؛ (f) مجوز B7 |
| **Downtime — Change A** | **10–30s** (فقط radio_api) | neo4j: صفر؛ 6 محصول دیگر: صفر |
| **Downtime — Change B روش ۱** | **30–60s** (7 محصول موقتی) | recreate neo4j_db |
| **Downtime — Change B روش ۲** | **صفر** | فقط ترافیک بیرونی |
| **Downtime — Backup** | **≈ صفر** | online |
| **تست‌های الزامی پیش/پس** | لیست | A7 (پیش از A8)؛ Post-check خ-1.4/خ-2.3 (پس از هر Change)؛ B7 (پس از Backup)؛ health همهٔ 7 API در همهٔ Post-checkها |

---

## خ-9. دفتر شواهد زنده (Live Evidence Log)

> همهٔ شواهد زیر 2026-11-11، 16:52–17:33 UTC، روی هاست 53 / Neo4j 2025.10.1 Enterprise.
> هر اسکریپت یک‌بارمصرف بود و پس از اجرا حذف شد. ساعت هاست ~3.5 ساعت جلوتر از کاری‌استیشن.

| اسکریپت | یافتهٔ کلیدی |
|---|---|
| r1a1_bootcheck | پس از reboot: neo4j_db `Exited (255)`؛ radio_api در restart loop؛ **ragportal_api Up**؛ 14 db |
| r1a1_neo4jdiag | neo4j_db: `RestartPolicy=no`، ExitCode=255، OOMKilled=false؛ لاگ‌های auth-failure قبلی (2026-11-06)؛ radio_api RestartCount=13 |
| r1a1_startneo | `docker start neo4j_db` → READY ~5s؛ **14/14 db ONLINE**؛ radio_api running (RestartCount=14) |
| r1a1_api | env زندهٔ radio_api: `NEO4J_USERNAME=neo4j, NEO4J_URI=bolt://neo4j_db:7687, NEO4J_DATABASE=radio, NEO4J_PASSWORD=<SET, sha256:cfb62cc80de05545>`؛ grep Cypher: api.py:118 (VQ) + api.py:694 (MATCH Chunk program_name) — فقط این دو خانواده |
| r1a1_ragcheck | ragportal_api env: `QA_CORPUS_NEO4J_PW`/`QA_RADIO_NEO4J_PW` (placeholder)؛ radio/mesbah/eiis/taghrir/tasnim با `NEO4J_*`؛ sources/ragportal بدون `NEO4J_*` در آن بازنمایی |
| r1a1_envfull | **7 API** با placeholder (sha256 cfb62cc80de05545)؛ sources_api: `SOURCES_NEO4J_URI/USER/PASS` + `SOURCES_RADIO_DB=radio`؛ neo4j_db env: `NEO4J_AUTH=neo4j/your_neo4j_password_here`، `NEO4J_PLUGINS=["apoc"]`، `NEO4J_dbms_security_procedures_unrestricted=apoc.*`، `NEO4J_TARBALL=neo4j-enterprise-2025.10.1-unix.tar.gz`، `NEO4J_EDITION=enterprise` |
| r1a1_neo4jhost | saber: uid=1001، گروه‌ها sudo(27)/docker(111)/ollama(987)؛ **sudo بدون رمز: خیر** |
| r1a1_iptnosh | `iptables -S` بدون root → `Permission denied (you must be root)` → snapshot DOCKER-USER = دسترسی کاربر (B1) |
| r1a1_fwbackup | **6362 listening روی `::ffff:127.0.0.1:6362` داخل neo4j_db** (از /proc/net/tcp6)؛ خطوط backup در neo4j.conf comment (پیش‌فرض)؛ فهرست `neo4j-admin database` شامل `backup` با `--include-metadata=none|all|users[=...]|roles`، `dump`، `load`، `restore` |
| r1a1_rbac (v1) | ACCESS ✅؛ `radio-4b` بدون علامت ❌؛ `GRANT MATCH ON GRAPH` ❌ (`expected: '{'`)؛ `GRANT SHOW DATABASES` ❌؛ کاربر جدید → 42NFD؛ cleanup ✅ |
| r1a1_rbac2 | دوگوش برای db نامعتبر ❌؛ `{ NODES(*), RELATIONSHIPS(*) }` ❌ (`expected ',' or '}'`)؛ `SHOW USERS YIELD user,passwordChangeRequired...` ✅ (TRUE ثبت شد)؛ دو واریانت ALTER USER ❌ |
| r1a1_rbac3 | **بکتیک برای radio-4b ✅**؛ `GRANT MATCH { NODES, RELATIONSHIPS }` ✅ (ثبت `property(NODES)`/`property(RELATIONSHIPS)`)؛ `ALTER USER u SET PASSWORD CHANGE NOT REQUIRED;` ✅ (TRUE→FALSE)؛ T1: 79,350؛ T4: 10 db + system همه رد؛ T6 (بعد از ACCESS neo4j): count=0 بدون خطا (db خالی) |
| r1a1_rbac4 | parity: VQ بردار ثابت **با neo4j → 3 hit (0.5468)** ولی **با کاربر محدود → 0** (نشان از مشکل visibility)؛ radio-4b count=79,350 با کاربر محدود؛ منفی‌های نوشتن 42NFF ✅ |
| r1a1_rbac5 / r1a1_rbac5b | **کشف تصمیم‌ساز:** بعد از `{ NODES, RELATIONSHIPS }` → `keys(n)→[]`، `embedding NOT NULL→0`، VQ→0؛ بعد از `{ * }` → `keys(n)→38`، VQ→**3 hit، score یکسان با admin**؛ `{ embedding }` → embedding count 79,350؛ نقش‌های داخلی: `reader` = `match all_properties` (هر دو segment)؛ catalog مجوزها: `match all_properties` / `property(...)` / `access database` / `write graph` / `token` / ... |
| r1a1_rbac6 | **باتری نهایی با مجموعهٔ X-1.3:** 4a=79,350؛ 4b=79,350؛ 4c=3 hit (parity)؛ 4d=52U00 (بعد 1024 vs 2560 در radio-4b — عدم خطای دسترسی)؛ 4e=38 key؛ 4f=SHOW DATABASES در session پیش‌فرض ✅؛ 4g=6 db + system همه رد؛ همهٔ واریانت‌های GRANT برای SHOW DATABASES ❌ (لازم نبود)؛ **FINAL: 1 user (neo4j)، 6 role پیش‌فرض — cleanup تأییدشده** |
| r1a1_prog | `SHOW TRANSACTIONS` در 2025.10.1 ستون‌های جدید (connection-centric: currentQuery, cpuTime, runtime, ...) — برای پایش queryهای طولانی |

---

## خ-10. موارد باقی‌مانده، وضعیت نهایی و STOP اجباری

**باقی‌مانده (بی‌تأثیر بر اعتبارسنجی، برای اجرا لازم):**
1. snapshot زندهٔ `DOCKER-USER` — نیازمند sudo (B1)؛ تا آن زمان روش ۲ «تأیید فنی،
   بدون snapshot» است.
2. probe خارجی اینترنت (B5) — اثبات «عمومی/نمی‌باشد» از داخل ممکن نیست.
3. `RestartPolicy=always` برای neo4j_db (F7) — **پیش‌شرط الزامی Change B روش ۱** و توصیه
   برای همهٔ مسیرها (ریسک در خ-0.2 زنده شد).
4. چرخش پلتفرمی رمز `neo4j` (F1، 7 env) و محدودسازی APOC (F6) — تصمیم/هماهنگی جدا (B4).

**وضعیت نهایی (اصلاح‌شده از حکم بخش ۲۲ بدنه):**
- **Change A:** `TECHNICALLY VALIDATED` (Runbook v3، خ-1.4) — آمادهٔ اجرای مشروط بر مجوز.
- **Change B:** `TECHNICALLY VALIDATED` (هر دو روش، خ-2.3) — روش ۱ مشروط بر F7.
- **Backup:** `TECHNICALLY VALIDATED` (physical ترجیحی + dump fallback، خ-3.4) — مجوز +
  انتخاب مسیر (B2) + مجوز B7 برای تست restore.
- **R1-B:** `READY WITH CAVEATS` (بدون تغییر) — **آغاز نمی‌شود** تا مجوز صریح.

> **توقف اجباری (مطابق مأموریت):** این مأموریت در همین‌جا متوقف می‌شود. منتظر **مجوزهای
> جداگانه** به این ترتیب: (1) پاسخ به دسترسی‌ها/تصمیم‌های خ-8، (2) مجوز **Change A**،
> (3) مجوز **Backup**، (4) مجوز **Change B** + انتخاب روش، (5) مجوز B7/Restore،
> و سپس (6) تأیید صریح **R1-B**. هیچ Commit/Push/Deploy/Nginx/SSL/DNS در این مأموریت
> انجام نشد.
>
> **صورت‌حساب ایمنیِ این الحاقیه:** تغییر در Production: **۱ مورد مجازشده**
> (`docker start neo4j_db`، تنها استثنای مصوب). test users/roles: **صفر باقی‌مانده**.
> Secret در این الحاقیه: **صفر** (فقط نام متغیر + پیشوند 16-هگزادیزی sha256 + placeholder
> عمومی قالب). Git: دست‌نخورده (این گزارش باقی untracked است).
