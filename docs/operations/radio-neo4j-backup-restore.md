# Radio Neo4j — رویهٔ پشتیبان‌گیری و بازیابی (Runbook)

**دامنه:** نمونهٔ Neo4j اشتراکی روی `172.20.1.53` (container `neo4j_db`، نسخهٔ `2025.10.1-enterprise`) که دیتابیس‌های `radio` و `radio-4b` و ۱۱ دیتابیس محصول دیگر را میزبانی می‌کند.
**پشتیبان:** `/home/saber/backups/radio/R1-A2-YYYYMMDD-HHMMSS/`
**گزارش تأیید:** [`docs/reports/RADIO_R1A2_BACKUP_RESTORE.md`](../reports/RADIO_R1A2_BACKUP_RESTORE.md)

> این سند دو رویه دارد: **Procedure A** (آزمون بازیابی ایزوله — اجرایشده و تأییدشده) و **Procedure B** (بازیابی اضطراری Production — فقط مستند، اجرا نشده، نیازمند مجوز جداگانه).

---

## 0. قواعد ایمنی (قبل از هر عملیات)

1. **هیچ بازیابی روی دیتابیس‌های Production بدون مجوز صریح کاربر اجرا نشود.**
2. قبل از هر تغییر: وضعیت فعلی را ثبت کنید (`SHOW DATABASES`, counts, `docker inspect neo4j_db`).
3. هرگز `neo4j.conf`, `.env`, volume یا container تولیدی را بدون مجوز تغییر/بازسازی نکنید.
4. هیچ password/hash در لاگ، تیکت یا Git نوشته نشود. برای عبور رمز از متغیر محیطی یا فایل `0600` استفاده کنید.
5. `data/` و مسیرهای پشتیبان را هرگز حذف نکنید.
6. پشتیبان را قبل از هر بازیابی، دوباره با `sha256sum -c` تأیید کنید.

---

## 1. محل پشتیبان

```
/home/saber/backups/radio/R1-A2-<UTC-TIMESTAMP>/
  db/<database>-<TS>.backup        # ۱۴ artifact فیزیکی فشرده
  config/{neo4j.conf, docker-compose.graph-rag.yml, docker-inspect.redacted.json, env.redacted, versions.txt}
  logs/{backup.log, inspect.txt, verify.log, restore-*.log}
  meta/{databases.txt, users.txt, roles.txt, privileges.txt, counts-pre.txt, verified_count.txt, metadata-scripts/}
  manifest.txt
  checksums.sha256
```

پشتیبان تأییدشدهٔ فعلی: `R1-A2-20261112-123345` (۳۳٫۶ GiB، ۱۴ دیتابیس، SHA-256 تأییدشده).

---

## 2. فهرست دیتابیس‌ها

`system`, `neo4j` (default/home), `radio`, `radio-4b`, `mesbah`, `taghrir`, `taghrir-10`, `taghrir-50`, `taghrir-100`, `tasnim-qwen3-embed-06b`, `falsafe-siasi-1000-embed-06b`, `falsafe-siasi-qwen3-embed-06b`, `falsafe-siasi-qwen3-embed-4b`, `import-test-06b`.

---

## 3. نسخهٔ لازم

`neo4j:2025.10.1-enterprise` (Kernel 2025.10.1، Cypher 5/25). بازیابی با نسخهٔ دیگر پشتیبانی نمی‌شود مگر با تأیید رسمی Neo4j.

---

## 4. تأیید یکپارچگی پشتیبان

```bash
D=/home/saber/backups/radio/R1-A2-<TS>
cd "$D" && sha256sum -c checksums.sha256        # باید همه OK
docker exec neo4j_db neo4j-admin database backup --inspect-path=/data/...   # یا مسیر معادل artifact
```

معیار قبولی: صفر mismatch، و در inspect برای هر artifact: `FULL=true`, `COMPRESSED=true`, `RECOVERED=true`.

---

## 5. بازیابی — دستورات پایه

نکات تجربی الزامی (همه در آزمون R1-A.2 کشف/تأیید شد):

- **`--temp-path` باید قابل نوشتن باشد**؛ در غیر این صورت استخراج موقت کنار منبع (احتمالاً فقط-خواندنی) شکست می‌خورد.
- فایل‌های بازیابی‌شده باید مالک کاربر اجرایی Neo4j (`7474`) باشند.
- دیتابیس هدف باید **متوقف** باشد و `--overwrite-destination=true` داده شود.
- بازیابی یک دیتابیس کاربر، آن را در catalog ثبت نمی‌کند؛ ابتدا `CREATE DATABASE` لازم است.
- برای هر artifact دارای متادیتا، باید `restore_metadata.cypher` تولیدشده اجرا شود.

```bash
IMG=neo4j:2025.10.1-enterprise
D=/home/saber/backups/radio/R1-A2-<TS>
VOL=<volume-هدف>

docker run --rm -u 0 --entrypoint sh -v "$D/db":/backups:ro -v "$VOL":/data "$IMG" -c "
  mkdir -p /data/_t
  neo4j-admin database restore \
    --from-path=/backups/<database>-<TS>.backup \
    --to-path-data=/data/databases \
    --to-path-txn=/data/transactions \
    --temp-path=/data/_t \
    --overwrite-destination=true --verbose
  chown -R 7474:7474 /data/databases /data/transactions
  rm -rf /data/_t"
```

---

## 6. بازیابی متادیتا (کاربران/رول‌ها)

پس از هر بازیابی موفق، neo4j-admin مسیر اسکریپت را چاپ می‌کند:

```
In order to restore the database permissions, you need to execute
/data/scripts/<database>/restore_metadata.cypher
```

اجرا (روی دیتابیس `system`):

```bash
docker exec -i <restore-container> cypher-shell -d system -u neo4j -p '<password>' \
  --param "database => '<database>'" \
  -f /data/scripts/<database>/restore_metadata.cypher
```

اسکریپت تأییدشده: ۴۸ خط شامل ۵ `CREATE ROLE`، ۴۲ `GRANT`، ۱ `CREATE USER` (برای هر دیتابیس). معیار قبولی: `rc=0` و سپس `SHOW USERS` / `SHOW ROLES` مطابق `meta/users.txt` و `meta/roles.txt`.

> اگر `restore_metadata.cypher` در دسترس نبود، از `meta/privileges.txt` (که با `SHOW ROLE <r> PRIVILEGES AS COMMANDS` تولید شده) استفاده کنید.

---

## 7. بازیابی indexها و تأیید ONLINE

indexهای فیزیکی در پشتیبان حفظ می‌شوند (در آزمون، بی‌درنگ `ONLINE` بودند). تأیید:

```bash
docker exec -i <ctr> cypher-shell -d radio  -u neo4j -p '<pw>' \
  "SHOW INDEXES YIELD name, type, entityType, properties, state RETURN *;"
docker exec -i <ctr> cypher-shell -d radio-4b -u neo4j -p '<pw>' \
  "SHOW INDEXES YIELD name, type, entityType, properties, state RETURN *;"
```

انتظار: `index_1b9dcc97` (LOOKUP/REL)، `index_460996c0` (LOOKUP/NODE)، `vector_index_chunk` (VECTOR روی `embedding`) — همه `ONLINE`.

---

## 8. بررسی سلامت پس از بازیابی

```bash
# شمارش‌ها (انتظار: radio=79350, radio-4b=79350)
docker exec -i <ctr> cypher-shell -d radio    -u neo4j -p '<pw>' "MATCH (n:Chunk) RETURN count(n);"
docker exec -i <ctr> cypher-shell -d radio-4b -u neo4j -p '<pw>' "MATCH (n:Chunk) RETURN count(n);"

# پرس‌وجوی برداری نماینده (انتظار: 0.5511904954910278, 0.5501537322998047, 0.5468377470970154)
docker exec -i <ctr> cypher-shell -d radio -u neo4j -p '<pw>' \
  "CALL db.index.vector.queryNodes('vector_index_chunk',3,<1024-dim constant vector>)
   YIELD node, score RETURN score ORDER BY score DESC;"
```

---

## 9. نقاط تصمیم (Decision Points)

| وضعیت                                                 | اقدام                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| checksum mismatch                                     | توقف فوری؛ پشتیبان معیوب است؛ از نسخهٔ دیگر استفاده کنید                   |
| بازیابی یک دیتابیس شکست خورد                          | متوقف شوید؛ artifact و لاگ را نگه دارید؛ رویهٔ اضطراری را اجرا نکنید       |
| دیتابیس پس از START `unknown / Server is unavailable` | artifact `system` را از نمونهٔ دیگر بازیابی نکرده‌اید؟ رویهٔ §10 را ببینید |
| index پس از دقایقی `ONLINE` نشد                       | صبر و پایش؛ در صورت شکست، پشتیبانی Neo4j                                   |
| شمارش Chunk با Production اختلاف داشت                 | بازیابی ناقص/ناسازگار؛ rollback به پشتیبان قبلی                            |

---

## 10. بازیابی «هویت متفاوت» (محدودیت مستندشده)

اگر artifact `system` از نمونه‌ای با هویت دیگر بازیابی شود، تخصیص‌های catalog به member قدیمی اشاره می‌کنند و همهٔ دیتابیس‌ها `unknown / Server is unavailable` می‌شوند. `neo4j-admin server unbind` این را در آزمون رفع نکرد.

رویهٔ کارآمد (تأییدشده): نمونهٔ تازه → برای هر دیتابیس `CREATE DATABASE` → `STOP DATABASE` → `restore --overwrite-destination=true` → `chown 7474` → `START DATABASE` → اجرای `restore_metadata.cypher`.

---

## 11. Procedure A — آزمون بازیابی ایزوله (تأییدشده)

```bash
D=/home/saber/backups/radio/R1-A2-<TS>
IMG=neo4j:2025.10.1-enterprise

docker network create r1a2_net
docker volume  create r1a2_restore_data
docker run -d --name r1a2_restore --network r1a2_net \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT=yes -e NEO4J_AUTH="neo4j/<temp-password>" \
  -e NEO4J_server_memory_pagecache_size=512M -v r1a2_restore_data:/data $IMG

# readiness:  (توجه: RETURN 1 روی system مجاز نیست → از دیتابیس default استفاده کنید)
until docker exec r1a2_restore cypher-shell -u neo4j -p '<temp-password>' "RETURN 1;" >/dev/null 2>&1; do sleep 5; done

# برای هر ۱۳ دیتابیس کاربر:
#   CREATE DATABASE <db>;  STOP DATABASE <db>;
#   restore با --overwrite-destination و --temp-path (بخش ۵)
#   chown -R 7474:7474 /data/databases /data/transactions
#   START DATABASE <db>;
#   اجرای restore_metadata.cypher (بخش ۶)

# تأییدها: بخش‌های ۷ و ۸
# پاک‌سازی:
docker stop r1a2_restore && docker rm r1a2_restore
docker volume rm r1a2_restore_data
docker network rm r1a2_net
```

**معیار پذیرش:** ۱۴/۱۴ online، متادیتا اعمال‌شده، `radio`/`radio-4b` = 79,350، هر سه index ONLINE، امتیازهای VQ یکسان با Production، Production بدون restart.

---

## 12. Procedure B — بازیابی اضطراری Production (فقط مستند)

> **اجرا نشده و نیازمند مجوز صریح جداگانه است.**

1. اعلام پنجرهٔ نگهداشت و توقف مصرف‌کننده‌ها (radio_api, sources_api, mesbah_api, eiis_api, taghrir_api, tasnim_api, ragportal).
2. پشتیبان تازه از وضعیت فعلی بگیرید (حتی اگر خراب به‌نظر می‌رسد).
3. توقف سرویس‌های مصرف‌کننده (نه حذف): `docker stop <api containers>`.
4. توقف `neo4j_db` (فقط با مجوز): `docker stop neo4j_db`.
5. بازیابی artifactهای موردنیاز روی مسیر دادهٔ تولیدی با `--overwrite-destination=true` (بخش ۵). برای `system`، فقط در همان هویت نمونه مجاز است.
6. `chown -R 7474:7474` روی مسیرهای داده/تراکنش.
7. `docker start neo4j_db` و انتظار برای `healthy`.
8. اجرای `restore_metadata.cypher` برای دیتابیس‌های بازیابی‌شده.
9. اجرای بررسی‌های بخش‌های ۷ و ۸ و سپس راه‌اندازی مصرف‌کننده‌ها.
10. ثبت گزارش پس‌ازحادثه در `docs/reports/`.

**Rollback Procedure B:** بازگرداندن پشتیبان مرحلهٔ ۲ با همان روند، سپس راه‌اندازی مجدد سرویس‌ها.

---

## 13. خرابی‌ها و رفتار مورد انتظار (Failure Handling)

| خطا                                                        | علت                                 | راه‌حل                                         |
| ---------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| `Read-only file system … -temp-extracted-artifacts-N`      | استخراج temp کنار منبع فقط-خواندنی  | `--temp-path` قابل نوشتن بدهید                 |
| `unrecognized arguments: '-i'`                             | در 2025.10.1 گزینهٔ `-i` وجود ندارد | از `--non-interactive` یا حذف آن استفاده کنید  |
| `42N17 … 'RETURN 1' is not allowed on the system database` | پرس‌وجوی نامعتبر روی system         | برای readiness از دیتابیس default استفاده کنید |
| `22N51 … graph reference not found`                        | دیتابیس در catalog ثبت نشده         | `CREATE DATABASE` پیش از restore               |
| `unknown / Server is unavailable`                          | بازیابی system در هویت دیگر         | رویهٔ §10                                      |
| سرور دیتابیس را نمی‌پذیرد                                  | مالکیت فایل‌ها                      | `chown -R 7474:7474`                           |

---

## 14. چک‌لیست دوره‌ای

- [ ] پشتیبان تازه (حداقل روزانه/پیش از هر تغییر امنیتی)
- [ ] `sha256sum -c` سبز
- [ ] آزمون بازیابی ایزولهٔ دوره‌ای (Procedure A)
- [ ] کپی off-site (نیازمند مجوز/مقصد جداگانه)
- [ ] پایش فضای دیسک (`/home` و `/var/lib/docker`)
