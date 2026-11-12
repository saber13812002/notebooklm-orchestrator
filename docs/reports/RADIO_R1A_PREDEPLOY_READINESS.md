# RADIO R1-A — Radio Maaref: پیش‌آمادگی استقرار، راستی‌آزمایی زیرساخت و یک تست زنده RRF

> **مأموریت:** R1-A (Read-only + دقیقاً یک POST مجاز RRF) — هدف: رفع همه ابهامات فنی قبل از
> قرار دادن موتور موجود پشت دامنه **`https://radio.ai.ismc.ir`**.
> **تاریخ و زمان بررسی:** 2026-11-10، حدود 15:42 تا 16:14 UTC (19:12–19:44 به‌اساس تهران)
> **مدت مجاز:** (۱) بررسی کامل Read-only زیرساخت/کد/سرور/DNS/Nginx/HTTPS
>  (۲) دقیقاً **یک** درخواست واقعی `POST /api/chat` با `variant="rrf"`.
> **رعایت‌شده:** هیچ Nginx، DNS، گواهی، سرویس، Container، دیتابیس، رمز، Config یا کد
> Production تغییر **نکرد**. هیچ Commit/Push انجام **نشد**. هیچ Secret چاپ **نشد**
> (فقط نام متغیر و وضعیت masked).
> **برچسب‌های وضعیت:** `VERIFIED` · `PARTIALLY VERIFIED` · `NOT VERIFIED` · `BLOCKED` · `NOT IMPLEMENTED`

---

## 1. خلاصه اجرایی

موتور Radio Maaref **سالم، زنده و توانمند** است و با **یک درخواست واقعی RRF** (بخش 18)
اثبات شد که با انتخاب صریح `variant="rrf"` پاسخ فارسی با استناد ساختاریافته و لینک
منابع تولید می‌کند (HTTP 200، ~30 ثانیه، ۵ منبع، ۵ استناد، ۹ لینک معتبر).

پاسخ کوتاه به سؤال مأموریت — «آیا آماده‌ایم موتور موجود را **بدون دستکاری** پشت دامنه بگذاریم؟»:
**بله.** تنها موارد مانده، لایه **Edge** (vhost + گواهی روی `172.30.0.133`) است که
Draft آن از قبل وجود دارد و در R1-A کامل راستی‌آزمایی شد (upstream از Edge قابل دسترسی
است، certbot و خودنوسازی فعال‌اند، مسیر SNI/Host routing روی Edge اثبات شد).

**یافته‌های مهم جدید این مأموریت (فراتر از R0):**
1. **پورت Edge = `8044`** به‌صورت قطعی اثبات شد (بخش 7) — هر دو پورت زنده‌اند و 8044
   (frontend) خود `/api/` را به 8043 (API) پروکسی می‌کند؛ پس upstream واحد vhost همان 8044 است.
2. **یافته امنیتی Neo4j دقیق‌تر شد (درجه High):** متغیر `NEO4J_PASSWORD` در Container مقدار
   همان **Placeholder قالب** (`your_neo4j_password_here`) است و **احراز هویت Neo4j فعال است**
   (رمز اشتباه → `AuthError`). یعنی کاربر `neo4j` با یک رمز ضعیف و **شناخته‌شده** وارد می‌شود
   و دروازه‌ها 7474/7687 روی `0.0.0.0` منتشر‌اند. سرویس در حال حاضر کار می‌کند (اتصال و
   query واقعی موفق) — خطر، دسترسی بیرونی با رمز شناخته‌شده است، نه خرابی سرویس. (بخش 10)
3. **ریشه‌یابی دقیق خلأ URL استنادها (مسأله ۴۴٪):** db `radio` (پایه 06b) فیلدهای Stage-5 را
   دارد (۷۶.۳٪ چانک‌ها `episode_url` دارند) اما db `radio-4b` (پایه 4b) **هیچ** فیلد Stage-5
   ندارد (0 از 79,350). یعنی ۱۰۰٪ استنادهای پایه 4b بدون URL هستند و این درون RRF با هم
   مخلوط می‌شوند. (بخش 19)
4. **DNS:** هم‌اکنون از هر سه Resolver (داخلی 172.22.6.1 و عمومی 8.8.8.8 / 1.1.1.1) آدرس
   `185.213.10.25` برمی‌گردد — **اختلاف با مشاهده R0** (که داخل→172.30.0.133 بود).
   Split-horizon برای این نام در لحظه بررسی R1-A **تأیید نشد**؛ باید با مالک Zone قطعی شود.
   این مانع Go-live نیست (Edge روی 133 برای هر دو مسیر پاسخ می‌دهد) اما باید مستند شود. (بخش 16)
5. **دامنه عمومی رسیده است ولی محصول روی آن نیست:** `https://radio.ai.ismc.ir` → 307 `/login`
   (vhost پیش‌فرض CMS، سرور Next.js) با گواهی پیش‌فرض `admin.ai.ismc.ir`. (بخش 17)

**حکم نهایی: READY WITH BLOCKERS** — دو مانع کوچک برای R1-B (دسترسی root/BT-Panel روی 133 و
تأیید DNS owner) + یک اصلاح امنیتی پیشنهادی هم‌زمان (رمز Neo4j). جزئیات در بخش 25.

---

## 2. مجوز و مرزهای مأموریت

| مورد | وضعیت |
|---|---|
| مجوز Read-only کامل (زیرساخت/کد/DNS/Nginx/HTTPS) | دریافت‌شده — رعایت شد |
| مجوز **یک** POST واقعی RRF | دریافت‌شده — دقیقاً **یک** بار اجرا شد (بخش 18) |
| تغییر Nginx / Reverse Proxy / DNS / گواهی / سرویس / Container / DB / رمز / Config / کد | **صادر نشده — صفر مورد اجرا شد** |
| Retry روی POST RRF | ممنوع بود — **انجام نشد** (درخواست موفق بود؛ اگر ناموفق می‌شد INCONCLUSIVE ثبت می‌شد) |

تصمیم‌های امنیتی در حین کار:
- POST از لوک‌بک اپلای‌هست (`127.0.0.1:8043` روی 53) اجرا شد تا متغیر شبکه حذف شود؛
  دسترسی Edge→53:8043/8044 جداگانه از خود 133 هم VERIFIED شد.
- Body درخواست با `scp` به `/tmp` روی 53 گذاشته شد و پس از اجرا **حذف** شد (`CLEANED`).
- اسکریپت‌های بررسی همگی یک‌بار مصرف بودند و پس از اجرا پاک شدند.

---

## 3. پایگاه Repository (Re-Baseline)

### 3.1 رپوی زنده Radio (روی 53) — `VERIFIED` (SSH `saber@172.20.1.53`)

| فیلد | مقدار |
|---|---|
| مسیر | `/home/saber/saberprojects/radio-rag-service` |
| Remote `origin` | `https://git.ai.ismc.ir/rag/radio-rag-service.git` (بدون credential در URL — پاک) |
| Branch فعال | `stage5-citations` |
| HEAD | `71d94d10f5bee04a54c74ae82bdd436f5c815ac6` — 2026-11-06 13:36:52 UTC — `feat(citations): Stage 5 structured citations + clickable frontend links (spec §9)` |
| Push state | با origin هم‌گام (`git log origin/stage5-citations..HEAD` = خالی) |
| Working tree | تمیز، جز **۱ فایل untracked**: `tests_test_citation_quality.py` |
| سایر branchها | `main` b7e150e (pushed) · `feature/radio-multi-model-4b` 977cca8 (pushed) · `feature/phase-i-citation-quality` 4371ffd (**بدون tracking → محلی/احتمالاً non-pushed**) |

### 3.2 رپوی NLO (کاربرگ فعلی) — `VERIFIED`

- Branch `main`، HEAD `2235c3e`، تمیز جز ۲ فایل untracked (دو گزارش R0).
- **هیچ `git add -A`، Commit یا Push انجام نشد.**

### 3.3 فایل‌های مرتبط با Radio/Nginx/LE در `server52and53` — خوانده شدند (بدون تغییر)

| File | Purpose | Current Status | Proposed Use |
|---|---|---|---|
| `edge_vhost_radio.ai.ismc.ir.conf` | vhost پیشنهادی 133 برای radio (HTTP→HTTPS + ACME + proxy به 53:8044 با تنظیم SSE) | **Deploy نشده** | مرجع Draft R1-B (با ۳ اصلاح؛ بخش 14) |
| `docs/reports/RADIO_R0_INFRASTRUCTURE_DISCOVERY.md` | گزارش R0 | موجود (untracked) | مبنا؛ جایی که با R1-A مغایرت داشت، اصلاح شد |
| `docs/reports/RADIO_R0_ROADMAP_STATUS_PROPOSAL.md` | پیشنهاد وضعیت رودمپ | موجود (untracked) | بدون تغییر |
| `EDGE_NGINX_SSL_REPORT.md`، `*.conf`های سایر دامنه‌ها (admin/git/docs/chat/grafana/sources) | تاریخچه vhostهای Edge | Read-only خوانده‌شدند | الگوی سازگاری با vhostهای موجود |
| `_work/stage5_repo/radio-rag-service/api.py` | کد زنده Stage-5 (SHA256 تطبیق‌شده با /app/app/api.py) | snapshot | مرجع اسکیما و منطق RRF |
| `_work/stage5_repo/live-radio-frontend/` | اسنپ‌شات فرانت | snapshot | مرجع UI |
| `docker-compose.radio.yml` + `nginx.conf` + `entrypoint.sh` (روی 53) | تعریف Containerها | **زنده** | مرجع پورت‌ها/شبکه/mounts |

---

## 4. وضعیت GitHub/GitLab — `PARTIALLY VERIFIED`

| مورد | وضعیت | شواهد |
|---|---|---|
| رپوی Radio روی GitHub | **وجود ندارد** | R0 + سیاست فعلی: موتور فقط روی GitLab داخلی؛ تنها رپوی عمومی مرتبط `iranseda-crawler-golang-` (کِرولر کورپس) است — همان‌جا که URL متن منابع به آن اشاره می‌کند (بخش 18) |
| رپوی GitLab `rag/radio-rag-service` | **VERIFIED** (از git سمت سرور) | origin، branch، HEAD، push-state (بخش 3.1) |
| جزئیات API/CI رپوی GitLab | **BLOCKED** | API بدون credential پروژه را نمی‌بیند؛ نیاز به token با `read_api` (بخش 22) |

---

## 5. فهرست سرور 53 (Host Inventory) — `VERIFIED`

| فیلد | مقدار |
|---|---|
| Hostname | `llm` |
| OS | Ubuntu 24.04.5 LTS (kernel 6.8.0-147-generic) |
| CPU | 40 هسته |
| RAM | 117Gi (43Gi در استفاده، 74Gi available) |
| Disk | 1.5T — 1.1T استفاده (79%) — 308G آزاد |
| Docker | 29.1.3 |
| Docker Compose | 2.40.3 |
| Node.js | v22.23.2 |
| Python | 3.12.3 |
| FFmpeg | 6.1.1 |
| Git | 2.43.0 |

---

## 6. فهرست Docker (Containerهای Radio + Neo4j) — `VERIFIED`

| Container | Image | ID | وضعیت | پورت‌های منتشرشده | Restart | Healthcheck |
|---|---|---|---|---|---|---|
| `radio_api` | `mrbaqeri/qa_lang_neo4j_mesbah:1.0.0` | `9847d492592c` | Up 4 days (**healthy**) | `0.0.0.0:8043→8003` (+ 8501 exposed/ناشرنشده) | `unless-stopped` | `python ... urlopen http://127.0.0.1:8003/api/health` (10s, start 120s) |
| `radio_frontend` | `nginx:alpine` | `a96128dcf8f9` | Up 5 days (**healthy**) | `0.0.0.0:8044→80` | `unless-stopped` | `wget --spider http://127.0.0.1/` (15s) |
| `neo4j_db` | `neo4j:2025.10.1-enterprise` | — | Up 9 days (**healthy**) | `0.0.0.0:7474`, `0.0.0.0:7687` (+ 7473 exposed) | — | (healthy) |

- **Compose file:** `/home/saber/saberprojects/radio-rag-service/docker-compose.radio.yml` (project `radio`)
- **شبکه:** `graph_rag_net` (external `graph-rag_default`) — هر دو Container عضو آن‌اند؛
  frontend از داخل شبکه به `radio_api:8003` می‌رسد (نه از طریق 8043).
- **Mountها (api):** `./api.py → /app/app/api.py:ro` (فایل‌تک‌باینده؛ به‌روزرسانی API = جایگزینی
  همین فایل + restart — نکته عملیاتی مهم R1-B بعدی).
- **Mountها (frontend):** `./frontend → /usr/share/nginx/html:ro`، `./nginx.conf →
  /etc/nginx/templates-api/default.conf.template:ro`، `./entrypoint.sh → /entrypoint.sh:ro`.
- **متغیرهای محیطی (فقط نام/وضعیت — مقدار چاپ نشد):**

| متغیر | وضعیت masked |
|---|---|
| `NEO4J_URI` | SET (len 20) — `bolt://neo4j_db:7687` از compose |
| `NEO4J_USERNAME` | SET (len 5) |
| `NEO4J_PASSWORD` | **PLACEHOLDER-literal** (مطابق دقیق با مقدار پیش‌فرض قالب) — جزئیات بخش 10 |
| `NEO4J_DATABASE` | SET (len 5) — `radio` |
| `VECTOR_INDEX` | SET (len 18) — `vector_index_chunk` |
| `LITELLM_BASE` | SET (len 27) — `http://172.30.0.133:4000/v1` |
| `LITELLM_API_KEY` | SET (len 20) |
| `RAG_SERVICE_TOKEN` | SET (len 32) |
| `EMBED_MODEL` / `GEN_MODEL` | SET — `Qwen3-Embedding-0.6B` / `qwen38` |

---

## 7. تعیین پورت 8043/8044 — `VERIFIED` (مهم‌ترین بخش)

### شواهد لایه‌به‌لایه

| منبع شواهد | نتیجه |
|---|---|
| docker-compose.radio.yml | `api.ports: 8043:8003` و `frontend.ports: 8044:80` |
| `docker inspect` | دقیقاً همان mappingها؛ شبکه مشترک `graph-rag_default` |
| `nginx.conf` داخل frontend | `location /api/ { proxy_pass http://__API_UPSTREAM__ }` با `API_UPSTREAM=radio_api:8003` |
| پروب از خود 53 | `8043/api/health` **200** (8ms) · `8043/openapi.json` **200** · `8043/docs` **200** · `8044/` **200** (SPA) · `8044/api/health` **200** (پروکسی) |
| پروب از Edge (133) | `53:8044 /` **200** · `53:8044/api/health` **200** · `53:8043/api/health` **200** |
| Swagger | 8043: **مستقیم و VERIFIED**. 8044: `/openapi.json` 200 بازگرداند اما چون nginx فقط `/api/` را پروکسی می‌کند، محتوا احتمالاً SPA-fallback است → **PARTIALLY VERIFIED** (Swagger واقعی روی 8043 است) |

### جدول تک‌پرتی

| سؤال | 8043 | 8044 |
|---|---|---|
| TCP باز؟ | بله (0.0.0.0) | بله (0.0.0.0) |
| HTTP پاسخ؟ | بله | بله |
| متعلق به Radio API؟ | بله — **خودِ FastAPI** (uvicorn 8003) | بله — nginx فرانت + پروکسی `/api/` به API |
| Swagger؟ | بله (مستقیم) | 200 ولی احتمالاً fallback SPA |
| از Edge (133) قابل دسترسی؟ | بله (200) | بله (200) |
| از داخل 53؟ | بله | بله |

### نتیجه صریح

```
RADIO_UPSTREAM_PORT = 8044   (برای vhost Edge: UI + API در یک upstream)
RADIO_DIRECT_API_PORT = 8043 (برای فراخوانی مستقیم API: Swagger، تست‌ها، Orchestrator آینده)
```

هر دو پورت «درست»اند؛ 8044 مقصد vhost است (چون فرانت `/api/` را خودش به 8043 می‌رساند و
تنظیم SSE را هم دارد)، و 8043 پورت مستقیم API است که تست RRF از آن اجرا شد.
**پس از این اثبات، POST RRF اجرا شد** (بخش 18).

---

## 8. راستی‌آزمایی Radio API — `VERIFIED`

- `/api/health` (GET، بدون احراز): **200** — `{"status":"ok","neo4j_online":true,
  "neo4j_database":"radio","vector_index":"vector_index_chunk","embedding_model":
  "Qwen3-Embedding-0.6B","gen_model":"qwen38","litellm":"http://172.30.0.133:4000/v1","top_k":5,"ms":2}`
- `/api/site`، `/api/programs`: **200** — 27 برنامه با نام/تعداد session/chunk (بزرگ‌ترها:
  گنج سعادت 7251، پارسایان 4762، پیام ولایت 4752، زمزم احکام 5767).
- `/api/v1/*`: guard با `RAG_SERVICE_TOKEN` فعال (R0؛ در این مأموریت بازنظرنیازی نشد).
- اسکریپت POST با موفقیت `200` — جزئیات بخش 18.

---

## 9. Swagger / OpenAPI — `VERIFIED`

- `GET 53:8043/openapi.json` → **200** (spec 3.1.0، 8 مسیر — هم‌خوان با کد).
- `GET 53:8043/docs` → **200** (Swagger UI).
- اسکیما `ChatRequest` از کد زنده استخراج شد: `{ message: str (required), stream: bool = false,
  variant: str = "06b" }` — **بدون احراز** روی `/api/chat`. `ChatResponse`:
  `{ answer, sources[], question, score, citations[] }`.

---

## 10. یافته امنیتی Neo4j — `VERIFIED` (درجه **High**)

### بررسی (همه Read-only، از داخل Container با همان credential سرویس)

| # | سؤال | پاسخ |
|---|---|---|
| 1 | متغیر در Container تعریف شده؟ | بله (`NEO4J_PASSWORD` از `.env.radio` تزریق می‌شود) |
| 2 | خالی است؟ | خیر |
| 3 | Placeholder است؟ | **بله** — مقدار با رشته قالب `your_neo4j_password_here` **عیناً** برابری دارد (مقادیر دیگری هرگز چاپ نشدند) |
| 4 | Container Neo4j فعال؟ | بله — `neo4j:2025.10.1-enterprise`، Up 9 days، healthy |
| 5 | اتصال واقعی Radio API به Neo4j؟ | **بله** — `RETURN 1` موفق، 79,350 چانک خوانده شد، query برداری زنده در RRF اجرا شد |
| 6 | `neo4j_online:true` سازگار با واقعیت؟ | بله — `/api/health` وضعیت `SHOW DATABASES` واقعی را می‌خواند و هم‌اکنون `radio` online است |
| 7 | احراز Neo4j فعال است؟ | **بله** — پروب منفی با رمز اشتباه → `AuthError` (پس Placeholder یک «رمز واقعی و شناخته‌شده» است، نه یک اتصال بدون احراز) |

### اثر بر سرویس
سرویس **الان سالم کار می‌کند**؛ خطا یا قطع نیست. خطر این است: (a) رمز حساب `neo4j` یک مقدار
قالبی و قابل حدس است؛ (b) پورت‌های 7474/7687 روی `0.0.0.0` منتشرند؛ (c) هر actor با دسترسی
شبکه به 53 می‌تواند با آن رمز به همه DBها (شامل dbهای سایر محصولات) دسترسی کامل بخواند/بنویسد.

### طرح اصلاح (اجرا **نشده** — نیاز به مجوز و پنجره R1-B یا هم‌زمان)
1. تولید رمز قوی و ذخیره در Secret Store همان host (فایل env با `chmod 0600` — نه git).
2. تغییر رمز از داخل 53: `docker exec neo4j_db cypher-shell -u neo4j -p <عوض‌شده>
   "ALTER USER neo4j SET PASSWORD '<رمزجدید>'"` (نام متغیر: `NEO4J_PASSWORD` در
   `/home/saber/saberprojects/radio-rag-service/.env.radio`).
3. ویرایش `.env.radio` و **یک بار** restart `radio_api` (و هر مصرف‌کننده‌ای که همان رمز را دارد —
   باید قبلش فهرست‌سازی شود).
4. محدودسازی آتش‌بام به‌طوری که 7474/7687 فقط از شبکه داخلی قابل دسترسی باشند (بستنی با
   آتش‌بام؛ بدون تغییر سرویس).
5. راستی‌آزمایی: health دوباره `ok` + یک GET `/api/programs` موفق.
- **Rollback:** ذخیره مقدار فعلی env قبل از تغییر (در بکاپ رازدارن) تا در صورت نیاز برگشت شود.

---

## 11. وضعیت Vector Index — `VERIFIED`

- `SHOW INDEXES` → `vector_index_chunk` در وضعیت **ONLINE** (db `radio`).
- Label `Chunk` — **79,350** چانک (مطابق گزارش Phase A: 4,148 doc / 79,350 chunk).
- query برداری زنده `db.index.vector.queryNodes` در RRF POST با موفقیت اجرا شد (بخش 18).
- **db `radio-4b`:** 79,350 چانک — ولی **بدون فیلدهای Stage-5** (بخش 19).

---

## 12. فهرست Edge Host (133) — `VERIFIED` (حد دسترسی فعلی)

| فیلد | مقدار |
|---|---|
| Hostname / OS | `AI-TOOLS` / Ubuntu (kernel 6.8.0-147) |
| CPU / RAM / Disk | 20 هسته / 78Gi (23Gi در استفاده) / 686G (38% استفاده) |
| Nginx | **1.31.4** (مستقیم BT-Panel webserver) — `VERIFIED` |
| پورت 80/443 | LISTEN روی `0.0.0.0` و `[::]` — `VERIFIED` |
| LiteLLM | `:4000` (docker) — مصرف‌کننده مشترک؛ تغییر نکرد |
| GitLab / Wiki.js | `:81` / `:8888` — فعال (تغییر نکرد) |
| دسترسی فعلی | SSH کلیدی `saber` فعال؛ `sudo`/root **نداریم** |

### BLOCKED (نیازمند root)
- فهرست/خواندن `/www/server/panel/vhost/nginx/*` — Permission denied
- خواندن `/www/server/panel/webserver/conf/webserver.conf` — Permission denied
- خواندن `/etc/letsencrypt/live/` — Permission denied
- `ufw status` — root لازم
→ این موارد با روش‌های Read-only جایگزین (رفتار Host/SNI زنده + certbot timer) پوشش داده
شدند؛ فقط «متن vhostهای موجود» مستقیماً قابل خواندن نبود.

---

## 13. ممیزی Nginx روی Edge — `VERIFIED` (در حد قابل مشاهده بدون root)

### رفتار زنده per-Host (تست `Host:` + SNI از روی خود 133) — `VERIFIED`

| Host | رفتار | گواهی ارائه‌شده |
|---|---|---|
| `radio.ai.ismc.ir` (HTTP) | 200 (صفحه CMS) | — |
| `radio.ai.ismc.ir` (HTTPS) | **307 → `/login`** (vhost پیش‌فرض CMS) | `CN=admin.ai.ismc.ir` (LE YE2، 2026-10-03 تا 2027-01-01) — **گواهی پیش‌فرض، اشتباه برای این نام** |
| `rag.ai.ismc.ir` (HTTPS) | **200** | `CN=rag.ai.ismc.ir` (LE، 2026-10-13 تا 2027-01-11) — **مرجع سالم** |
| `git.ai.ismc.ir` (HTTPS) | 302 → `/users/sign_in` | (GitLab) |

### پاسخ‌ها به سؤالات مأموریت
- آیا `server_name radio.ai.ismc.ir` وجود دارد؟ **خیر** (NOT IMPLEMENTED).
- آیا vhost دیگری این دامنه را می‌گیرد؟ **بله** — vhost پیش‌فرض (catch-all) CMS/Next.js آن را می‌گیرد.
- آیا Default CMS درخواست را دریافت می‌کند؟ **بله** (307 → /login) — `VERIFIED`.
- آیا گواهی admin.ai.ismc.ir به‌اشتباه ارائه می‌شود؟ **بله** (default cert برای نام radio) — `VERIFIED`.
- آیا vhost مستقل قابل ایجاد است؟ **بله** — routing per-Host/SNI روی همین nginx اثبات شد (rag و git هرکدام گواهی و رفتار جداگانه دارند)؛ vhost جدید با `server_name` مستقل و additive است.
- آیا upstream 53 از Edge قابل دسترسی است؟ **بله** — 8044 و 8043 هر دو از 133 با 200 پاسخ دادند.

---

## 14. Draft vhost موجود — `PARTIALLY VERIFIED` (خوانده و ۳ اصلاح مشخص شد)

فایل `server52and53/edge_vhost_radio.ai.ismc.ir.conf` (88 خط) کامل خوانده شد: HTTP→HTTPS 301،
ACME challenge با `root /var/www/letsencrypt`، proxy کل ترافیک به `http://172.20.1.53:8044` با
`proxy_buffering off` / `read_timeout 300s` / `X-Accel-Buffering no`، HSTS، logهای جدا.

**اصلاحات لازم برای R1-B (در Draft جدید اعمال شد):**

| # | مشکل | اصلاح |
|---|---|---|
| FIX-1 | `/var/www/letsencrypt` روی 133 **وجود ندارد** (`No such file or directory`) | مرحله 2 R1-B: ساخت webroot + مالکیت مناسب |
| FIX-2 | مسیر include vhostهای BT-Panel هنوز بدون root تأیید نشده | مرحله 1 R1-B: `sudo nginx -T \| grep include` برای اطمینان از مسیر درک‌شونده |
| FIX-3 | upstream = 8044 | تأییدشد در R1-A (بخش 7) — Draft بدون تغییر باقی می‌ماند |

Draft نهایی (فقط محلی، نصب **نشده**):
[`docs/reports/drafts/r1b_radio_vhost.conf`](drafts/r1b_radio_vhost.conf)

---

## 15. آمادگی Let's Encrypt — `VERIFIED` (قابلیت) / `NOT IMPLEMENTED` (گواهی radio)

- **certbot 2.9.0** نصب است و **`certbot.timer` فعال** است (آخرین اجرا 2026-11-10 06:51 UTC،
  بعدی 17:59 UTC) — خودنوسازی زنده است.
- گواهی `rag.ai.ismc.ir` (LE، معتبر تا 2027-01-11) وجود دارد → مسیر صدور برای دامنه‌های
  `*.ai.ismc.ir` **اثبات‌شده**.
- **گواهی `radio.ai.ismc.ir` وجود ندارد** (NOT IMPLEMENTED) — تا نصب vhost + ACME، برای این
  نام گواهی پیش‌فرض admin ارائه می‌شود.
- webroot `/var/www/letsencrypt` هنوز ساخته نشده (FIX-1).

---

## 16. راستی‌آزمایی DNS — `VERIFIED` (با یک مغایرت مهم با R0)

| Resolver | نوع | پاسخ | TTL |
|---|---|---|---|
| **داخلی 172.22.6.1** | A | `185.213.10.25` | 131 |
| داخلی 172.22.6.1 | AAAA / CNAME | نداشت (SOA zone) | — |
| **عمومی 8.8.8.8** | A | `185.213.10.25` | 300 |
| **عمومی 1.1.1.1** | A | `185.213.10.25` | 300 |
| عمومی 1.1.1.1 | AAAA | نداشت | — |
| SOA (`ismc.ir` از 8.8.8.8) | SOA | `indie.ns.cloudflare.com` / `dns.cloudflare.com`، Serial 2419782340، DefaultTTL 1800 | 1800 |

**⚠ مغایرت با R0:** در R0 مشاهده شده بود «داخلی→172.30.0.133 / عمومی→185.213.10.25»
(split-horizon). **در لحظه R1-A (16:00 UTC) هر سه resolver `185.213.10.25` دادند.**
تفسیر صادقانه: یا record داخلی تغییر/حذف شده، یا مسیر forwarding resolver داخلی متفاوت است.
**split-horizon در این لحظه تأیید نشد (NOT VERIFIED در R1-A).** تأثیر عملی: چون `185.213.10.25`
NAT همان Edge 133 است و Edge هر دو نام/آدرس را مدیریت می‌کند، Go-live خراب نمی‌شود؛ ولی
**مالک Zone باید قبل از R1-B تأیید کند** که مسیر公网 و داخلی هر دو به Edge 133 می‌رسند.
**هیچ DNS تغییر نکرد.**

---

## 17. اتصال داخلی/خارجی — `VERIFIED`

| مسیر | نتاio | وضعیت |
|---|---|---|
| Edge(133) → 53:8044 | `/` 200، `/api/health` 200 | ✅ (شرط پیش‌نیاز vhost) |
| Edge(133) → 53:8043 | `/api/health` 200 | ✅ |
| 53 loopback → 8043/8044 | 200 / 200 | ✅ |
| **اینترنت عمومی** → `185.213.10.25:80` | TCP open (از ایستگاه کاری خارج از شبکه) | ✅ |
| **اینترنت عمومی** → `185.213.10.25:443` | TCP open | ✅ |
| **اینترنت عمومی** → `https://radio.ai.ismc.ir` | **HTTP 307 → `/login`**، سرور `nginx` + `X-Powered-By: Next.js`، گواهی `admin.ai.ismc.ir` | ❌ **دسترسی محصول Radio = شکست** (دستور مأموریت: این همان وضعیت «روی دامنه نیست») |

**نتیجه صادقانه:** لوله‌ی اینترنت→Edge باز است و Edge روی 53 می‌رسد؛ اما «موفقیت از شبکه
داخلی» به‌جای دسترسی عمومی **گزارش نشد** — تست عمومی با خروجی واقعی 307 ثبت شد.

---

## 18. شواهد درخواست زنده RRF (دقیقاً یک) — `VERIFIED`

### پیش‌شرط‌ها (همه پیش از POST تأیید شد)
API واقعی شناسایی ✅ · پورت قطعی ✅ (8043 مستقیم) · Swagger خوانده ✅ · اسکیما از کد زنده ✅
(`{message, stream, variant}`) · احراز: `/api/chat` بدون token است ✅ · Neo4j بررسی ✅
· Vector Index ONLINE ✅ · بدون نیاز به هیچ تغییر Production ✅

### مشخصات درخواست

| فیلد | مقدار |
|---|---|
| Timestamp UTC | **2026-11-10T16:04:19Z** (شروع curl) — تکمیل در **16:04:49.324Z** (log) |
| Target Host | `172.20.1.53` (اجرا از لوک‌بک خود 53) |
| Port | **8043** |
| Endpoint | `POST /api/chat` |
| Variant | **`"rrf"`** (صریح؛ default = 06b دست‌نخورده) |
| Body | `{"message":"در برنامه پارسایان موضوعات مربوط به نماز و عبادت چگونه تبیین می‌شود؟","variant":"rrf"}` — سؤال واقعی، غیرمحرمانه، مرتبط با آرشیو |
| HTTP Status | **200 OK** (log: `POST /api/chat HTTP/1.1" 200 OK`) |
| Latency | **≈ 30.3 ثانیه** (برخی از 16:04:19 تا 16:04:49) |
| Response Schema | `ChatResponse` کامل: `answer` + `sources[5]` + `question` + `score` + `citations[5]` |
| Correlation ID | در اسکیما **وجود ندارد** (NOT IMPLEMENTED) |
| Provenance | **LIVE** — چانک‌های واقعی Neo4j (با URL واقعی آرشیو iranseda) + تولید واقعی qwen38 از LiteLLM؛ **Mock نبود** |
| Error | نبود |

### پاسخ (مختصر)
پاسخ فارسی ۴بخشی (فضیلت نماز شب با استناد به آیت‌الله وحیدی؛ حقیقت و آداب نماز؛ احکام نماز از
جمله محدودیت لباس؛ رویکرد تفسیری همراه با مقدمه تفسیر آیه 120 مائده)، با ارجاعات داخل متن
`[1]…[5]` و محتوایی که **کاملاً به چانک‌های بازیابی‌شده بازمی‌گردد** (جعل منبع مشاهده نشد).

### آمار پاسخ
- **Citation Count:** 5 (زمزم احکام ×1، پارسایان ×4 — همه پخش 1404-02-21 / 2025-05-11)
- **Source UID Count:** 3 از 5 با `session_uid` معتبر (2 مورد خالی)
- **URL Count:** 9 لینک معتبر (source 1: 5 لینک — source_text/episode/program_page/day_archive/
  time_slot_archive؛ source 5: 4 لینک — بدون source_text) — 2 استناد (40٪) بدون URL
- **quarantined:** 1 استناد (source 3) درست است که بدون لینک برگشته (طبق spec §10.1: «citable by id only»)
- `score` = 0.806 (raw KNN؛ `rrf_score` در response فیلد ندارد — مطابق کد)

### هشدارهای Neo4j در حین query (مهم)
`UnknownPropertyKeyWarning` برای `raw_srt_url`، `full_text_url` و `air_date_status` → یعنی این
کلیدها در **بخشی** از چانک‌های db `radio` تعریف نشده‌اند (schema partial). نمونه‌ی چانک db
`radio` کلیدهای Stage-5 (session_uid, air_date_status, quarantined, episode_url, program_page_url,
day_archive_url, timeslot_archive_url, corrected_text_url, corrected_srt_url, summary_url,
linkage_validated_at) را دارد اما `full_text_url`/`raw_srt_url` را ندارد.

---

## 19. ارزیابی کیفیت RRF — `VERIFIED` (یک نمونه زنده؛ نه تکرار بنچمارک)

| معیار | ارزیابی |
|---|---|
| ارتباط پاسخ با سؤال | عالی — مستقیم درباره برنامه پارسایان و تبیین نماز/عبادت |
| کیفیت فارسی | روان، ساختاریافته، بدون برچسب مدل |
| وجود استنادات | بله — 5 استناد با program/date/chunk_id/citation |
| قابلیت کلیک لینک‌ها | بله برای 9 لینک (iranseda archive + full-text از GitHub کِرولر) |
| تطبیق UID و URL | برای 3 استناد؛ برای 2 استناد (UID خالی) لینک ندارد |
| عدم جعل منبع | تأیید — همه جملات به چانک‌های بازیابی‌شده بازمی‌گردد؛ استناد quarantined درست بدون لینک |
| کامل بودن Metadata | خوب — `air_date_status`/`quarantined`/`session_uid` حضور دارند؛ `rrf_score` و correlation-id نیستند |

**مقایسه با M2-2 (92/100):** این تک‌درخواست با همان سطح کیفیت بنچمارک هم‌خوان است.
**ریشه‌یابی خلأ URL (جدید و دقیق):**

| db | چانک‌ها | کلیدهای Stage-5 | با `episode_url` |
|---|---|---|---|
| `radio` (06b) | 79,350 | بله (با partial: بدون full_text/raw_srt) | **60,575 (76.3٪)** |
| `radio-4b` (4b) | 79,350 | **خیر — هیچ** | **0 (0٪)** |

→ در RRF، هر استنادی که از پایه 4b بیاید **حتماً** بدون URL است؛ «۴۴٪ بدون URL» دقیقاً همین
ترکیب است. **اقدام اصلاحی (R4):** اجرای مراحل linkage (K1–K22) روی `radio-4b`.

---

## 20. طرح Go-Live برای R1-B — Draft (بدون اجرا)

Draft کانفیگ: [`docs/reports/drafts/r1b_radio_vhost.conf`](drafts/r1b_radio_vhost.conf)

معماری مقصد: `Internet → radio.ai.ismc.ir → Nginx HTTPS (133) → 53:8044 (UI + /api/ proxy) →
radio_api:8003 (8043) → radio-rrf → پاسخ + استناد + لینک`. vhost **additive** و فقط با
`server_name radio.ai.ismc.ir` کلید می‌خورد؛ vhostهای rag/admin/git/NLO دست‌نخورده می‌مانند
و قبل از reload همه باید در بکاپ باشند (گام 1).

| # | مرحله | دستور/اقدام | نتیجه مورد انتظار |
|---|---|---|---|
| 1 | بکاپ کانفیگ Nginx | `sudo cp -a /www/server/panel/vhost/nginx /root/r1b_backup/nginx_$(date +%F)` و `sudo nginx -T > /root/r1b_backup/nginx_full_$(date +%F).conf` | دو بکاپ readable |
| 2 | آماده‌سازی ACME webroot | `sudo mkdir -p /var/www/letsencrypt && sudo chown -R www:www /var/www/letsencrypt` (FIX-1) | دایرکتوری موجود |
| 3 | بررسی DNS/Edge routing | `curl -sk -o /dev/null -w '%{http_code}' -H 'Host: radio.ai.ismc.ir' https://127.0.0.1/` (باید 307/200 CMS) + تأیید DNS owner برای公网/داخلی | وضعیت پیش‌از اجرا مستند |
| 4 | بررسی مسیر include | `sudo nginx -T \| grep -E 'include.*vhost'` (FIX-2) | مسیر درک‌شونده BT-Panel |
| 5 | ایجاد vhost | کپی Draft به `/www/server/panel/vhost/nginx/radio.ai.ismc.ir.conf` (فقط server blockهای جدید) | فایل جدید، بدون لمس بقیه |
| 6 | upstream check | از 133: `curl -s -o /dev/null -w '%{http_code}' http://172.20.1.53:8044/` | 200 |
| 7 | `nginx -t` | `sudo nginx -t` | `syntax is ok / test is successful` |
| 8 | صدور Let's Encrypt | `sudo certbot --nginx -d radio.ai.ismc.ir --non-interactive --agree-tos -m admin@ismc.ir` (یا webroot) | گواهی در `/etc/letsencrypt/live/radio.ai.ismc.ir/` |
| 9 | فعال‌سازی | `sudo nginx -s reload` | بدون خطا در log |
| 10 | تست Swagger | `curl -s https://radio.ai.ismc.ir/api/../openapi.json` → در عمل `curl -s https://radio.ai.ismc.ir/` + دسترسی مستقیم 53:8043/docs برای اطمینان | 200 |
| 11 | تست Health | `curl -s https://radio.ai.ismc.ir/api/health` | 200 + `neo4j_online:true` |
| 12 | تست API واقعی | **یک** POST `variant:"rrf"` از پشت دامنه (با مجوز جداگانه) | 200 + پاسخ + استناد |
| 13 | تست گواهی | `openssl s_client -servername radio.ai.ismc.ir ... \| openssl x509 -noout -subject -dates` | CN=radio.ai.ismc.ir، SAN درست، تاریخ معتبر |
| 14 | تست Renewal | `sudo certbot renew --dry-run` | «Congratulations»/no failure + timer فعال |
| 15 | **Rollback** | برگرداندن بکاپ گام 1 یا حذف فایل vhost + `sudo nginx -s reload` | رفتار CMS پیشین برمی‌گردد؛ بدون اثر روی سایر vhostها |

**تأثیر بر NLO/سایر سرویس‌ها:** vhost جدید independent است؛ reload فقط confهای همان include را
می‌خواند. ریسک اصلی = خطای تایپی در conf → با `nginx -t` قبل از reload حذف می‌شود. LiteLLM/GitLab/
Wiki.js/NLO دست‌نخورده.

---

## 21. ریسک‌های امنیتی (Risk Register)

| # | ریسک | درجه | توضیح / کنترل |
|---|---|---|---|
| S1 | **رمز Neo4j = Placeholder قالبی + auth فعال + پورت‌ها 0.0.0.0** | **High** | بخش 10؛ اصلاح در R1-B یا قبلش (با مجوز) |
| S2 | `/api/*` بدون احراز — پس از publish عمومی قابل فراخوانی هر کسی است | Medium | پیش از باز کردن عمومی، Rate-limit/ACL در Edge (header-based یا token ساده) یا Orchestrator (R2) |
| S3 | گواهی پیش‌فرض admin برای نام radio | Medium | با R1-B (گواهی اختصاصی) حل می‌شود |
| S4 | خلأ URL استنادها (100٪ پایه 4b) | Medium (کیفیت) | R4: linkage روی `radio-4b` |
| S5 | ممیزی کامل vhostهای Edge بدون root ممکن نیست | Low (process) | در R1-B با root انجام می‌شود (گام 1/4) |
| S6 | مغایرت DNS R0/R1-A (split-horizon نامشخص) | Low-Medium | تأیید مالک Zone قبل از R1-B |
| S7 | disk 53 در 79٪ | Low | پایش؛ بدون اقدام در این مأموریت |

---

## 22. دسترسی‌های موردنیاز (بدون درخواست Secret در چت)

| Access | Purpose | Minimum Permission | Status |
|---|---|---|---|
| Edge SSH (سaber) | بررسی Nginx | Read-only | ✅ داریم (استفاده شد) |
| **Edge Root / BT-Panel (133)** | نصب vhost + TLS در R1-B | sudo/root (فقط: اضافه‌کردن 1 conf، ساخت webroot، certbot، nginx -t/reload) | ❌ **مفقود — مانع اصلی** |
| GitLab Token | بررسی CI/پایپ‌لاین `rag/radio-rag-service` | `read_api` + `read_repository` | ❌ مفقود |
| Radio API Token | — | لازم نیست: `/api/chat` بدون token است؛ برای `/api/v1/*` کافی است نام متغیر `RAG_SERVICE_TOKEN` (در Secret Store همان host 53) | ✅ در دسترس (استفاده نشد) |
| DNS Admin | تأیید/اصلاح record `radio.ai.ismc.ir` | تأیید Zone Cloudflare `ismc.ir` (ویرایش فقط اگر مالک Zone بخواهد) | ❌ نیاز به مالک Zone |
| Wiki.js API | انتشار مستندات (R6) | API access | ❌ مفقود (خارج از R1-B) |
| Neo4j credential | اصلاح S1 | تغییر رمز از داخل 53 با دسترسی فعلی saber (بدون نیاز به credential جدید؛ فقط مجوز) | ⏳ منتظر مجوز |

---

## 23. تأییدیه‌های موردنیاز از کارفرما برای R1-B

1. **دسترسی root/BT-Panel روی 172.30.0.133** (حداقل: گام‌های 1–9 جدول بخش 20).
2. **مجوز اجرای طرح 15 مرحله‌ای R1-B** (با توقف و گزارش پس از هر گام پرخطر).
3. **تأیید DNS owner** برای آدرس公网 `185.213.10.25` و (در صورت وجود) record داخلی.
4. **مجوز (اختیاری ولی توصیه‌شده) هم‌زمان: چرخش رمز Neo4j** (بخش 10) — شامل یک restart `radio_api`.
5. **مجوز یک POST RRF از پشت دامنه** در گام 12 (دقت: این مجزاست از یک POST انجام‌شده در R1-A).

---

## 24. طرح Rollback (R1-B)

| سناریو | اقدام |
|---|---|
| `nginx -t` شکست | reload نمی‌شود؛ هیچ چیزی تغییر نکرده — فقط conf جدید را اصلاح می‌کنیم |
| خطا پس از reload | `sudo cp` بکاپ گام 1 به جای خودش + `sudo nginx -s reload` → وضعیت پیشین |
| گواهی ناموفق | حذف/بازگردانی conf radio؛ دامنه به vhost پیش‌فرض برمی‌گردد (رفتار CMS فعلی) |
| خطا در چرخش Neo4j | برگرداندن مقدار قبلی env (از بکاپ رازدارن) + restart radio_api |
| اثر روی vhost دیگر | چون vhostها per-server_name و additive هستند، حذف conf radio باید وضعیت را کامل برگرداند؛ در هر صورت بکاپ کامل `nginx -T` (گام 1) مرجع مرجع است |

**نقطه بازگشت:** هیچ گامی بدون بکاپ اجرا نمی‌شود؛ بکاپ‌ها در `/root/r1b_backup/` می‌مانند تا
پایان دوره پایداری.

---

## 25. قضاوت نهایی

**حکم: READY WITH BLOCKERS**

چرا نه «READY FOR R1-B» خالص: (a) دسترسی root/BT-Panel روی 133 هنوز نداریم؛ (b) تأیید
DNS owner برای recordهای عمومی/داخلی انجام نشده. هر دو «دسترسی/تأیید» هستند، نه «فنی نامعلوم» —
هیچ ابهام فنی باقی نمانده است.

### هفت سؤال مأموریت — پاسخ مستقیم

1. **API واقعی رادیو روی کدام پورت است: 8043 یا 8044؟**
   هر دو زنده‌اند و هر دو متعلق به Radio API: **8043 = پورت مستقیم API** (FastAPI/uvicorn 8003 —
   Swagger/Health/POST RRF از این‌جاست) و **8044 = فرانت + پروکسی `/api/` به 8043**. برای
   upstream vhost، **`RADIO_UPSTREAM_PORT = 8044`** (UI و API در یک مسیر).

2. **آیا اتصال Nginx به API بدون تغییر معماری امکان‌پذیر است؟**
   **بله.** Edge (133) امروز از 53:8044 می‌رسد (200 VERIFIED)؛ vhost با `proxy_pass
   http://172.20.1.53:8044` کافی است — بدون تغییر هیچ Container/Compose/کدی. تنظیم SSE هم در
   Draft هست.

3. **آیا Neo4j واقعاً سالم و Credential آن معتبر است؟**
   Neo4j **سالم است** (Up 9 days، healthy، index ONLINE، 79,350 چانک، query برداری زنده موفق،
   `neo4j_online:true` سازگار). اما **Credential معتبر نیست به‌معنای امن:** مقدار همان
   Placeholder قالبی است درحالی‌که auth فعال است (رمز ضعیف + شناخته‌شده روی 0.0.0.0) →
   **High** و باید در R1-B چرخش کند.

4. **آیا یک درخواست واقعی RRF موفق شد؟**
   **بله.** یک POST، `variant="rrf"`، **HTTP 200** در 16:04:49 UTC (≈30 ثانیه)، پاسخ فارسی
   4بخشی + 5 استناد + 9 لینک معتبر، بدون error، Provenance LIVE (Neo4j + qwen38 واقعی).

5. **آیا دامنه از اینترنت عمومی قابل دسترسی است؟**
   **کانال عمومی باز است** (TCP 80/443 از خارج شبکه open) **اما محصول Radio هنوز روی دامنه
   نیست** — `https://radio.ai.ismc.ir` در حال حاضر 307 به `/login` می‌رود (vhost پیش‌فرض CMS
   با گواهی اشتباه admin). این «دسترسی عمومی محصول» = **FAIL** تا R1-B.

6. **آیا می‌توانیم بدون تأثیر بر NLO و سایر سرویس‌ها Radio را منتشر کنیم؟**
   **بله.** vhost additive با server_name مستقل است؛ `rag`/`git`/`admin` و LiteLLM/GitLab/
   Wiki.js/NLO دست‌نخورده می‌مانند؛ پیش از reload حتماً `nginx -t` + بکاپ (گام‌های 1/7/15).

7. **برای شروع R1-B دقیقاً چه مجوزهایی لازم است؟**
   (a) root/BT-Panel روی 133؛ (b) تأیید اجرای طرح 15 مرحله‌ای؛ (c) تأیید DNS owner؛
   (d) [توصیه‌شده] مجوز چرخش رمز Neo4j؛ (e) مجوز یک POST ریلی از پشت دامنه در گام 12.

**STOP — مطابق بخش 13 مأموریت متوقف می‌شوم.** هیچ Nginx deployment، SSL issuance، DNS،
Firewall، Docker، Deploy، DB، Credential، Commit یا Push انجام نشد. منتظر بررسی گزارش و
مجوز R1-B.

---
*پایان گزارش R1-A. تمام شواهد از خروجی واقعی ابزارها در 2026-11-10 است؛ جایی که R0 با واقعیت
مغایرت داشت (DNS داخلی)، اختلاف صادقانه ثبت شد و R0 اصلاح نشد.*
