# R1-A.2 — پشتیبان‌گیری Production و بازیابی در محیط ایزوله

**Mission ID:** RADIO-R1-A2-2026-11
**سرور:** 172.20.1.53 (hostname: `llm`)
**تاریخ اجرا (UTC):** 2026-11-12، 12:25 → 13:33
**وضعیت نهایی:** `BACKUP_AND_RESTORE_VERIFIED` (با محدودیت مستند در §20)

---

## 1. خلاصهٔ مدیریتی (Executive Summary)

یک پشتیبان فیزیکی **آنلاین** از کل نمونهٔ Neo4j (هر ۱۴ دیتابیس شامل `system`) گرفته شد، بدون هیچ restart، بدون تغییر پیکربندی، و بدون هیچ تغییر در Production. پشتیبان در مسیر `/home/saber/backups/radio/R1-A2-20261112-123345/` با مجوزهای `0700/0600` ذخیره شد؛ ۱۴ artifact مجموعاً **36,093,209,280 بایت (۳۳٫۶ GiB)**. تمام SHA-256ها تأیید شد (۲۴ فایل، صفر mismatch) و یک بار دیگر پس از همهٔ آزمون‌ها بازبینی و تأیید شد.

سپس یک نمونهٔ Neo4j **کاملاً ایزوله** (container، volume و network مستقل، بدون هیچ port منتشرشده) ساخته شد، هر ۱۴ artifact در آن بازیابی شد و آزمون‌های E1..E5 اجرا شد:

- هر **۱۴ دیتابیس** در نمونهٔ بازیابی‌شده `online` شدند.
- **متادیتای کاربر/رول** داخل artifact اثبات شد و با رویهٔ رسمی (`restore_metadata.cypher`) اعمال شد (۱۳/۱۳ با `rc=0`).
- شمارش Chunk در `radio` و `radio-4b` دقیقاً **79,350 = 79,350** (برابر Production).
- هر سه index در هر دو دیتابیس `ONLINE`؛ جست‌وجوی برداری نماینده **با نتایج و امتیازهای دقیقاً یکسان با Production**.
- Production در تمام مدت دست‌نخورده: `restarts=0`، `started_at` بدون تغییر، شمارش‌ها بدون تغییر.

**نتیجه:** پشتیبان قابل بازیابی و قابل اتکا است؛ پیش‌شرط Change A برآورده شد.

---

## 2. مجوز مأموریت (Authorization)

کاربر مجاز کرد: ایجاد پشتیبان production در `/home/saber/backups/radio/`، استفاده از backup endpoint پورت `6362`، شمول متادیتای کاربر/رول، پشتیبان‌گیری از پیکربندی و مواد بازیابی، تأیید SHA-256، بازیابی در محیط کاملاً ایزوله، اجرای تأییدهای read-only، نگارش گزارش فارسی، و commit مستندات.

**ممنوعیت‌های رعایت‌شده (همه):** بدون Change A (هیچ user/role/password ساخته یا تغییر نکرد)، بدون Change B (هیچ قاعدهٔ firewall/iptables/DOCKER-USER/UFW و هیچ port publishing تغییر نکرد)، بدون تغییر `.env.radio`، بدون restart/recreate/stop/upgrade هیچ container تولیدی، بدون تغییر پیکربندی Neo4j، بدون Nginx/certificate، بدون R1-B، بدون حذف پشتیبان‌های موجود، بدون بازیابی روی دیتابیس‌های production، و بدون نمایش هیچ password/token/credential.

تنها عملیات‌های نوشتنیِ انجام‌شده: ساخت درخت `/home/saber/backups/radio/`، فایل‌های پشتیبان و لاگ‌ها، یک دایرکتوری موقت داخل حجم mount‌شدهٔ `/data` که در پایان همان جلسه حذف شد، و منابع ایزولهٔ آزمون (`r1a2_restore` / `r1a2_restore_data` / `r1a2_net`) که همه پس از آزمون حذف شدند.

---

## 3. شواهد Preflight (Phase A)

| مورد                 | مقدار                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| هویت SSH             | `saber` (uid 1001) از `172.22.6.30`                                                |
| گروه‌ها              | `sudo`, `users`, `docker`, `ollama`                                                |
| Host key (ED25519)   | `SHA256:BP+9ekCAA+LaalRmqt84JQydR+PUwx0GQ8a33t4U7WY`                               |
| Host key (RSA-3072)  | `SHA256:E/5/R8JvQnM6G02sZ+PR/L1IjJF1C0+PnABUS+31XHw`                               |
| سیستم‌عامل           | Ubuntu 24.04.5 LTS، کرنل 6.8.0-147-generic                                         |
| Docker               | client/server 29.1.3، API 1.52، driver overlay2، root `/var/lib/docker`، cgroup v2 |
| نشست‌های هم‌زمان     | فقط یک نشست (همین مأموریت)                                                         |
| فعالیت هم‌زمان Radio | هیچ عملیات neo4j-admin/restore/backup فعال نبود؛ `restarts=0`                      |

**Docker Compose مربوط به neo4j:** `/home/saber/saberprojects/graph-rag/docker-compose.yml` (تصویر `neo4j:2025.10.1-enterprise`، نام container `neo4j_db`، mountها: `./neo4j_data:/data` و `./neo4j_dump:/import`).

---

## 4. هویت سرور (Server Identity)

| مورد             | مقدار                                                              |
| ---------------- | ------------------------------------------------------------------ |
| IP               | `172.20.1.53/24` (ens33)                                           |
| Hostname         | `llm`                                                              |
| Container ID     | `f8f850e8ca812fa1a61421552b1a25594b54a87cbcfc00e966caf183dc80a738` |
| وضعیت            | `running`, `healthy`                                               |
| RestartCount     | `0`                                                                |
| RestartPolicy    | `no`                                                               |
| StartedAt        | `2026-11-12T08:32:45.128699022Z` (بدون تغییر تا پایان مأموریت)     |
| Mountهای `/data` | bind از `/home/saber/saberprojects/graph-rag/neo4j_data`           |

---

## 5. نسخه و Edition

| مورد        | مقدار                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Image       | `neo4j:2025.10.1-enterprise` (image id `a64074737267`، 794MB، به‌صورت محلی موجود) |
| Kernel      | `2025.10.1`                                                                       |
| Edition     | `enterprise`                                                                      |
| Cypher      | `5`, `25`                                                                         |
| neo4j-admin | `2025.10.1`                                                                       |
| صفحه‌cache  | `server.memory.pagecache.size=512M`                                               |

---

## 6. فهرست دیتابیس‌ها (Database Inventory)

در زمان preflight، ۱۴ دیتابیس، همه `online`:

| دیتابیس                         | حجم store |
| ------------------------------- | --------- |
| `system`                        | 2.3M      |
| `neo4j` (default/home)          | 1.1M      |
| `radio`                         | 1.4G      |
| `radio-4b`                      | 3.2G      |
| `mesbah`                        | 1.9G      |
| `taghrir`                       | 376M      |
| `taghrir-10`                    | 3.0G      |
| `taghrir-50`                    | 15G       |
| `taghrir-100`                   | 30G       |
| `tasnim-qwen3-embed-06b`        | 841M      |
| `falsafe-siasi-1000-embed-06b`  | 6.2G      |
| `falsafe-siasi-qwen3-embed-06b` | 620M      |
| `falsafe-siasi-qwen3-embed-4b`  | 1.4G      |
| `import-test-06b`               | 4.7M      |

مجموع `/data` = **71G** (۶٫۲G آن transactions).

**کاربران/رول‌ها (بدون هیچ credential):** کاربر `neo4j` (roles: `admin`, `PUBLIC`)، رول‌ها: `PUBLIC`, `admin`, `architect`, `editor`, `publisher`, `reader`.

---

## 7. روش پشتیبان‌گیری و دلیل انتخاب (Backup Method)

**روش: پشتیبان فیزیکی آنلاین با `neo4j-admin database backup` روی backup service داخلی پورت `6362`.**

دلایل:

1. Backup service در تصویر Enterprise به‌صورت پیش‌فرض روی `127.0.0.1:6362` داخل container فعال است — با `ss`/`netstat` (که در image نصب نیستند) از طریق `/proc/net/tcp6` اثبات شد: `::ffff:127.0.0.1:6362` در حالت `LISTEN`.
2. در `neo4j.conf` هیچ خط فعالِ backup وجود ندارد ⇒ **هیچ تغییر پیکربندی و هیچ recreate لازم نبود**.
3. فشرده‌سازی پیش‌فرض (`--compress=true`) → ۳۳٫۶ GiB برای ۷۱G داده.
4. `--include-metadata=all` پشتیبانی می‌شود (برای `system` مجاز نیست؛ `system` ذاتاً حاوی کاربران/رول‌ها است).
5. `--inspect-path` برای تأیید ساختار artifact پشتیبانی می‌شود.

**چرا همهٔ ۱۴ دیتابیس؟** چون Radio با ۷ محصول دیگر روی یک نمونهٔ مشترک Neo4j زندگی می‌کند؛ پشتیبان دو دیتابیس Radio به‌تنهایی «بازیابی کامل نمونه» را تضمین نمی‌کرد. تفکیک: ۱۳ دیتابیس با `--include-metadata=all` در یک فرمان + `system` در فرمانی جدا (بدون پرچم متادیتا، مطابق محدودیت مستند).

فضای مورد نیاز: ۳۳٫۶ GiB؛ فضای آزاد در زمان اجرا 327G (پس از پشتیبان: 294G).

---

## 8. محل پشتیبان (Backup Location)

```
/home/saber/backups/radio/R1-A2-20261112-123345/     (mode 700, owner saber)
├── db/            14 artifact، همه mode 600
├── config/        neo4j.conf، compose، docker-inspect.redacted.json، env.redacted، versions.txt
├── logs/          backup.log، inspect.txt، verify.log، restore-*.log
├── meta/          databases.txt، users.txt، roles.txt، privileges.txt، counts-pre.txt،
│                  verified_count.txt، metadata-scripts/*.cypher.sanitized
├── manifest.txt
└── checksums.sha256
```

زمان‌بندی جلسه: شروع `12:33:45Z`، پایان پشتیبانِ کاربر‌ها و `system` `12:38:35Z`، کپی و حذف temp `12:40:17Z`، تأیید checksum `12:41:14Z`.

---

## 9. حجم پشتیبان

| مورد                     | مقدار                                 |
| ------------------------ | ------------------------------------- |
| مجموع artifactها         | `36,093,209,280` بایت (۳۳٫۶ GiB)      |
| کل پوشه (با config/logs) | 34G                                   |
| بزرگ‌ترین artifact       | `taghrir-100` = `17,275,115,670` بایت |
| کوچک‌ترین (بدون `neo4j`) | `system` = `22,572` بایت              |

---

## 10. Manifest

`manifest.txt` شامل: تاریخ ساخت، مسیر، نسخهٔ Neo4j، فهرست ۱۴ دیتابیس، اندازهٔ هر artifact، و شمارش‌های پیش از پشتیبان است. `logs/inspect.txt` جدول کامل artifactها را دارد: برای هر ۱۴ مورد `FULL=true`، `COMPRESSED=true`، `RECOVERED=true` به‌همراه Database ID، LOWEST/HIGHEST TX و STORE ID HASH.

---

## 11. تأیید SHA-256

| مرحله                                                             | نتیجه                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| تولید `checksums.sha256` (۱۴ artifact + ۱۰ فایل متادیتا/پیکربندی) | انجام شد                                                 |
| `sha256sum -c` بلافاصله                                           | **۲۴ خط `OK`، صفر mismatch** (`verified_count.txt = 24`) |
| بازبینی مستقل بعدی (مستقل از verify اولیه)                        | `mismatch_lines=0`، `verified_ok_lines=24`               |
| بازبینی نهایی پس از همهٔ آزمون‌های بازیابی                        | `FINAL_VERIFY_RC=0`                                      |

| Database / Artifact             | Backup |          bytes | SHA-256 (کوتاه)      | Verified |
| ------------------------------- | ------ | -------------: | -------------------- | -------- |
| `falsafe-siasi-1000-embed-06b`  | OK     |  3,319,347,708 | `dd5d7046…a3527d`    | OK       |
| `falsafe-siasi-qwen3-embed-06b` | OK     |    306,999,995 | `2d5f3c77…a75056`    | OK       |
| `falsafe-siasi-qwen3-embed-4b`  | OK     |    658,671,811 | `ba4a4932…198283`    | OK       |
| `import-test-06b`               | OK     |      1,911,196 | `899ad6e5…c93ddc`    | OK       |
| `mesbah`                        | OK     |  1,237,285,830 | `8ce44e1b…6d5323`    | OK       |
| `neo4j`                         | OK     |          6,074 | `f854b4a2…e313f7`    | OK       |
| `radio`                         | OK     |    701,087,091 | `27d843ce…c8fe9a`    | OK       |
| `radio-4b`                      | OK     |  1,527,416,034 | `00bf0fe9…c4e261b`   | OK       |
| `system`                        | OK     |         22,572 | `7ba00014…ad16c7c`   | OK       |
| `taghrir`                       | OK     |    199,545,034 | `9b4987e3…77cd231`   | OK       |
| `taghrir-10`                    | OK     |  1,722,337,234 | `e140f39b…a271853`   | OK       |
| `taghrir-50`                    | OK     |  8,732,488,494 | `64afe4d7…815f7fb6`  | OK       |
| `taghrir-100`                   | OK     | 17,275,115,670 | `0dbdb734…868bc3bc6` | OK       |
| `tasnim-qwen3-embed-06b`        | OK     |    410,974,537 | `f79242fa…a87849f6`  | OK       |

(مقادیر کامل در `checksums.sha256`.)

---

## 12. تأیید متادیتای کاربران/رول‌ها

سه شاهد مستقل:

1. **آزمون تفاضلی روی سرور production:** پشتیبان‌گیری از `import-test-06b` (دادهٔ یکسان) یک‌بار با `--include-metadata=all` و یک‌بار با `none`:

| پرچم   |     bytes | SHA-256                   |
| ------ | --------: | ------------------------- |
| `all`  | 1,911,420 | `6dda11d0c863abb7…acc3b7` |
| `none` | 1,909,650 | `51488021514477bf…6e7fd8` |

اختلاف **+1,770 بایت** و hash متفاوت ⇒ payload متادیتا واقعاً داخل artifact نوشته می‌شود.

2. **شاهد رفتاری در حین بازیابی:** بازیابی هر artifact دارای متادیتا پیام می‌دهد که برای بازگردانی مجوزها باید اسکریپت تولیدشده اجرا شود:
   `In order to restore the database permissions, you need to execute /data/scripts/<db>/restore_metadata.cypher … --param "database => '<db>'"`.

3. **محتوای اسکریپت‌ها:** برای ۱۳ دیتابیس کاربر، فایل ۴۸ خطی با **۵ `CREATE ROLE`، ۴۲ `GRANT`، ۱ `CREATE USER`** تولید شد (نسخهٔ sanitized در `meta/metadata-scripts/`). اجرای هر ۱۳ فایل با `rc=0` موفق بود و مجموعهٔ مجوزهای `admin` پس از اجرا شامل همان grantهای per-database شد.

> `--inspect-path` متادیتا را نمایش نمی‌دهد؛ بنابراین اثبات از مسیر بالا انجام شد، نه از inspect.

---

## 13. مشخصات محیط بازیابی (Restore Environment)

| مورد               | مقدار                                                |
| ------------------ | ---------------------------------------------------- |
| Container          | `r1a2_restore` (ایزوله، سپس حذف‌شده)                 |
| Image              | `neo4j:2025.10.1-enterprise` (همان نسخهٔ Production) |
| Volume             | `r1a2_restore_data` (مستقل، سپس حذف‌شده)             |
| Network            | `r1a2_net` (مستقل، سپس حذف‌شده)                      |
| Port منتشرشده      | **هیچ** (`docker port` خالی)                         |
| مسیر داده          | فقط volume ایزوله — هیچ bind production استفاده نشد  |
| نام‌های production | استفاده نشد (`neo4j_db` و volume تولیدی دست‌نخورده)  |
| ترافیک خارجی       | هیچ                                                  |

---

## 14. نتایج آزمون بازیابی

### E1 — بازیابی دیتابیس‌ها — **VERIFIED**

هر ۱۴ دیتابیس در نمونهٔ ایزوله `online`: `falsafe-siasi-1000-embed-06b`, `falsafe-siasi-qwen3-embed-06b`, `falsafe-siasi-qwen3-embed-4b`, `import-test-06b`, `mesbah`, `neo4j`, `radio`, `radio-4b`, `system`, `taghrir`, `taghrir-10`, `taghrir-100`, `taghrir-50`, `tasnim-qwen3-embed-06b`.

### E2 — بازیابی متادیتا — **VERIFIED**

`SHOW USERS` = `neo4j` با `[admin, PUBLIC]`؛ `SHOW ROLES` = همان ۶ رول production؛ `SHOW ROLE admin PRIVILEGES AS COMMANDS` پس از اجرای اسکریپت‌ها شامل grantهای per-database برای هر ۱۳ دیتابیس شد (هم‌ارز معنایی با grantهای wildcard تولیدی). هیچ password/hash چاپ یا کپی نشد.

### E3 — یکپارچگی کورپس Radio — **VERIFIED**

- `radio`: Chunk = **79,350** (Production = 79,350)، nodes = 79,350
- `radio-4b`: Chunk = **79,350** (Production = 79,350)، nodes = 79,350
- `size(keys(chunk)) = 38` (هم‌راستا با Production)
- indexها در هر دو: `index_1b9dcc97` (LOOKUP/REL)، `index_460996c0` (LOOKUP/NODE)، `vector_index_chunk` (VECTOR روی `embedding`) — همه **ONLINE**
- سایر دیتابیس‌ها (nodes): `mesbah`=126,296، `taghrir`=22,113، `taghrir-10`=191,728، `taghrir-50`=971,738، `taghrir-100`=1,921,783، `import-test-06b`=200، `falsafe-siasi-1000-embed-06b`=348,139، `falsafe-siasi-qwen3-embed-06b`=32,183، `falsafe-siasi-qwen3-embed-4b`=32,183، `tasnim-qwen3-embed-06b`=78,022

### E4 — اثبات ایزولاسیون — **VERIFIED**

Production در تمام مدت: `state=running`, `health=healthy`, `restarts=0`, `started_at` بدون تغییر (`08:32:45Z`)، شمارش `radio`/`radio-4b` بدون تغییر (79,350/79,350). Container بازیابی: بدون port، فقط روی `r1a2_net`، فقط volume ایزوله.

### E5 — پاک‌سازی — **VERIFIED**

`r1a2_restore` حذف شد، `r1a2_restore_data` و `r1a2_net` حذف شدند؛ پشتیبان اصلی دست‌نخورده (۳۴G)؛ فضای دیسک به 294G بازگشت؛ لاگ‌های sanitized حفظ شدند.

---

## 15. مقایسهٔ شمارش Chunk

| دیتابیس    | Production | Restored | نتیجه |
| ---------- | ---------: | -------: | ----- |
| `radio`    |     79,350 |   79,350 | MATCH |
| `radio-4b` |     79,350 |   79,350 | MATCH |

---

## 16. تأیید Vector Index و هم‌ارزی جست‌وجو

پروب ثابت ۱۰۲۴-بعدی (همان پروب R1-A.1) روی `vector_index_chunk`، `top-3`:

| رتبه | Production         | Restored           |
| ---- | ------------------ | ------------------ |
| 1    | 0.5511904954910278 | 0.5511904954910278 |
| 2    | 0.5501537322998047 | 0.5501537322998047 |
| 3    | 0.5468377470970154 | 0.5468377470970154 |

**نتیجه:** تطابق کامل (۱۶ رقم اعشار) ⇒ هم دادهٔ برداری و هم index بازیابی شده‌اند. هر دو index پيش از پرس‌وجو `ONLINE` بودند (indexها در پشتیبان فیزیکی حفظ می‌شوند و بازسازی طولانی لازم نشد).

---

## 17. ارزیابی اثر بر Production

- هیچ restart، recreate، stop، upgrade یا تغییر config: **صفر**.
- بار اضافه محدود به خواندن transaction log از طریق backup service داخلی loopback در ۴ دقیقه و ۵۰ ثانیه.
- پشتیبان‌های موجود حذف نشدند؛ `/home/saber/backups/radio/` تازه ساخته شد.
- حجم دیسک از 327G آزاد به 294G رسید (۳۳٫۶ GiB پشتیبان + مصارف موقت آزمون که آزاد شد).

---

## 18. دستورالعمل Rollback

این مأموریت چیزی را در Production تغییر نداد، بنابراین rollback عملیاتی لازم نیست. برای ابطال کامل اثر:

1. حذف پشتیبان (فقط با مجوز صریح): `rm -rf /home/saber/backups/radio/R1-A2-20261112-123345`
2. هیچ تغییر دیگری برای بازگرداندن وجود ندارد (هیچ config/container/DB تولیدی تغییر نکرد).

برای **بازیابی اضطراری Production** به §19 و سند [`docs/operations/radio-neo4j-backup-restore.md`](../operations/radio-neo4j-backup-restore.md) مراجعه کنید — اجرای آن نیازمند مجوز جداگانهٔ کاربر است.

---

## 19. دستورالعمل بازیابی (خلاصه؛ جزئیات در سند operations)

### Procedure A — آزمون بازیابی ایزوله (اجراشده در این مأموریت)

```bash
D=/home/saber/backups/radio/R1-A2-20261112-123345
IMG=neo4j:2025.10.1-enterprise

docker network create r1a2_net
docker volume create r1a2_restore_data
docker run -d --name r1a2_restore --network r1a2_net \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT=yes -e NEO4J_AUTH="neo4j/<temp-password>" \
  -e NEO4J_server_memory_pagecache_size=512M -v r1a2_restore_data:/data $IMG
# پس از READY: برای هر دیتابیس
#   CREATE DATABASE <db>;  STOP DATABASE <db>;
#   docker run --rm -u 0 --entrypoint sh -v $D/db:/backups:ro -v r1a2_restore_data:/data $IMG -c \
#     "mkdir -p /data/_t && neo4j-admin database restore --from-path=/backups/<db>-<ts>.backup \
#        --to-path-data=/data/databases --to-path-txn=/data/transactions \
#        --temp-path=/data/_t --overwrite-destination=true && chown -R 7474:7474 /data"
#   START DATABASE <db>;
#   docker exec r1a2_restore cypher-shell -d system -u neo4j -p '<pw>' \
#     --param "database => '<db>'" -f /data/scripts/<db>/restore_metadata.cypher
```

### Procedure B — بازیابی اضطراری Production (فقط مستند؛ اجرا نشده)

نیازمند: مجوز صریح کاربر، توقف سرویس‌های مصرف‌کننده، backup قبلی از وضعیت فعلی، و پنجرهٔ نگهداشت. مراحل کامل در سند operations.

---

## 20. محدودیت‌های شناخته‌شده

1. **بازیابی artifact `system` در نمونه‌ای با هویت متفاوت** به‌تنهایی کار نمی‌کند: پس از بازیابی `system` + دیتابیس‌های کاربر در یک نمونهٔ تازه، همهٔ دیتابیس‌ها `unknown / Server is unavailable` شدند (تخصیص‌های catalog به member قدیمی اشاره می‌کنند) و `neo4j-admin server unbind` نیز آن را رفع نکرد. رویهٔ کارآمد (و آزمون‌شده): نمونهٔ تازه ← `CREATE DATABASE` ← `STOP` ← `restore --overwrite-destination` ← `START` ← اجرای `restore_metadata.cypher`. برای بازیابی «همان هویت» (روی همان نمونهٔ تولیدی) این مشکل انتظار نمی‌رود، اما **آزمون نشده است** (ممنوع بود).
2. **`neo4j` (دیتابیس default) اسکریپت `restore_metadata.cypher` تولید نکرد** (فقط ۱۳ دیتابیس دیگر). دلیل مستند نشده؛ برای بازیابی کامل هویت/مجوزها، مسیر `system` یا `SHOW ROLE … PRIVILEGES AS COMMANDS` (که در `meta/privileges.txt` ذخیره شده) پشتیبان اطلاعاتی است.
3. **`--inspect-path` متادیتا را نشان نمی‌دهد** ⇒ تأیید متادیتا فقط رفتاری/تفاضلی ممکن است.
4. **`cypher-shell -i` در 2025.10.1 وجود ندارد** (فقط `--non-interactive`).
5. **`RETURN 1` روی دیتابیس `system` مجاز نیست** (`42N17`); برای readiness از دیتابیس default استفاده شود.
6. **بازیابی نیاز به `--temp-path` قابل نوشتن** دارد؛ اگر پوشهٔ artifact فقط-خواندنی mount شود، استخراج temp کنار منبع شکست می‌خورد.
7. فایل‌های بازیابی‌شده باید مالک کاربر اجرایی Neo4j (`7474`) باشند، وگرنه سرور آن‌ها را نمی‌پذیرد.
8. اسکنِ secret یک هشدار کاذب روی `config/docker-compose.graph-rag.yml` داد؛ علت، placeholder `${NEO4J_PASSWORD}` است و هیچ مقدار واقعی در آن فایل نیست.
9. پشتیبان روی همان دیسک سرور است (327G آزاد)؛ **off-site copy انجام نشده** (خارج از دامنهٔ مجوز این مأموریت).

---

## 21. اطلاعات Git

- سند گزارش: `docs/reports/RADIO_R1A2_BACKUP_RESTORE.md`
- سند رویه: `docs/operations/radio-neo4j-backup-restore.md`
- Commit: `docs(radio): document verified Neo4j backup and restore`
- SHA کامیت محلی: در بخش تحویل نهایی گزارش می‌شود.
- Push: طبق سیاست مخزن و فقط در صورت مجوز؛ این مأموریت push انجام نداد.

---

## 22. حکم نهایی (Final Verdict)

**`BACKUP_AND_RESTORE_VERIFIED`**

- پشتیبان کامل production: **VERIFIED** (۱۴/۱۴ دیتابیس، ۳۳٫۶ GiB، metadata 포함)
- تأیید یکپارچگی SHA-256: **VERIFIED** (۲۴ OK، صفر mismatch، بازبینی نهایی RC=0)
- بازیابی ایزوله: **VERIFIED** (۱۴/۱۴ online)
- متادیتای کاربر/رول: **VERIFIED** (embed + اجرای ۱۳/۱۳ اسکریپت با rc=0)
- تطابق شمارش Chunk: **VERIFIED** (79,350 = 79,350 در هر دو)
- index برداری ONLINE: **VERIFIED**
- پرس‌وجوی برداری نماینده: **VERIFIED** (امتیازهای دقیقاً یکسان)
- دست‌نخوردن Production: **VERIFIED**
- بازیابی `system` در هویت متفاوت به‌تنهایی: **NOT TESTED / محدودیت مستند**
- آماده برای پشتیبانی Change A: **بله**

**این مأموریت در همین‌جا متوقف می‌شود.** Change A، Change B، تغییر port publishing، restart/recreate، R1-B و بازیابی روی Production همگی نیازمند مجوز جداگانهٔ کاربر هستند.
