# RADIO-FINAL — P1 TLS (Let's Encrypt) — وضعیت و شواهد

**Mission:** RADIO-FINAL-GOLIVE-2026-11 / Phase P1
**Target:** `radio.ai.ismc.ir` (edge `172.30.0.133`, BT-Panel nginx)
**Date (UTC):** 2026-11-13 03:11–03:18
**Status:** `BLOCKED — upstream inbound TCP/80 blocked (not a server-side fault)`

---

## 1. خلاصه

صدور گواهی معتبر برای `radio.ai.ismc.ir` **در لبهٔ سرور ممکن نیست**، چون Let's Encrypt نمی‌تواند چالش HTTP-01 را از اینترنت دریافت کند: از دید اعتبارسنجی LE، اتصال به `185.213.10.25:80` **timeout** می‌شود، در حالی که همان پورت از شبکهٔ داخلی ما پاسخ می‌دهد. رفع آن نیازمند باز کردن ورودی ۸۰ روی لبهٔ عمومی/ISP است (مسیر B که کاربر انتخاب کرد)، یا DNS-01 (مسیر A).

---

## 2. Baseline (LIVE-VERIFIED, read-only)

| مورد                | مقدار                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| nginx               | `1.31.4`، `active`، `nginx -t` = **ok**                                                                                                     |
| vhost               | `/www/server/panel/vhost/nginx/radio.ai.ismc.ir.conf` — ۳۸ خط                                                                               |
| checksum vhost      | `sha256:ad4f865cc33dbdb7e3a7b3a45f9bdef5090b79dbf78821fd0016eb4c72b058d7`                                                                   |
| TLS فعلی            | **self-signed** `issuer=CN=radio.ai.ismc.ir`, `SAN=DNS:radio.ai.ismc.ir`, `notBefore=Nov 12 09:27:18 2026`, `notAfter=Feb 10 09:27:18 2027` |
| upstream            | `proxy_pass http://172.20.1.53:8044` (SSE settings دست‌نخورده: buffering off، timeout 600s)                                                 |
| ACME webroot        | `/www/acme/.well-known/acme-challenge/` — موجود؛ مسیر داخلی → `404` برای توکن جعلی (یعنی location درست سرو می‌شود)                          |
| certbot             | `2.9.0`، **پلاگین nginx نصب نیست**                                                                                                          |
| روش مستقر DGE       | **webroot** — ۱۳ renewal conf: `authenticator=webroot`, `webroot_path=/www/acme`, `server=acme-v02`                                         |
| renewal برای radio  | **وجود ندارد** (`/etc/letsencrypt/renewal/radio.ai.ismc.ir.conf` = absent)                                                                  |
| DNS                 | `radio.ai.ismc.ir → 185.213.10.25`                                                                                                          |
| اپ (از 133)         | `8044` = 200 · `8043/api/health` = 200                                                                                                      |
| اپ (از workstation) | `https://radio.ai.ismc.ir/` با `-k` = **200** · بدون `-k` = **000** (self-signed)                                                           |

---

## 3. علت قطعی شکست صدور (شاهد مستقیم)

لاگ تلاش‌های اپراتور قبلی (`/tmp/m25cert_retry.log`، ۷۰ تلاش، آخرین 03:12Z):

```
Certbot failed to authenticate some domains (authenticator: webroot).
  Domain: radio.ai.ismc.ir
  Type:   connection
  Detail: 185.213.10.25: Fetching http://radio.ai.ismc.ir/.well-known/acme-challenge/<token>:
          Timeout during connect (likely firewall problem)
2026-11-13T03:12:33Z [70] certonly_rc=1
```

**آزمون متقابل ما:**

| مبدأ                                     | نتیجه              |
| ---------------------------------------- | ------------------ |
| workstation → `http://185.213.10.25/`    | **200**            |
| workstation → `http://radio.ai.ismc.ir/` | **301** (به HTTPS) |
| اعتبارسنج LE (multi-region)              | **timeout**        |

⇒ DNAT برای ۸۰ وجود دارد ولی ورودی از اینترنت (به‌ویژه از رنج‌های LE) مسدود است. **هیچ تغییری روی ۱۳۳ این را رفع نمی‌کند.**

**هشدار rate-limit:** ۵ اعتبارسنجی ناموفق در ساعت برای هر account+hostname؛ با ۷۰ تلاش، احتمال قفل موقت وجود دارد. تکرار HTTP-01 تا باز شدن پورت مضر است.

---

## 4. بستهٔ اجرا (آماده، یک فرمان)

اسکریپت روی edge staged شده و از نظر syntax تأیید شده است:

```
/home/saber/radio-tls-activate.sh   (mode 750)
```

اجرا (توسط root — BT-Panel یا sudo):

```
sudo bash /home/saber/radio-tls-activate.sh
```

مراحل اسکریپت (idempotent):

1. بکاپ vhost + checksum + نسخهٔ رندرشده در `/home/saber/backups/radio-edge-tls-<TS>/` (0700)
2. اگر cert معتبر LE موجود باشد، از صدور مجدد صرف‌نظر می‌کند
3. `certbot certonly --webroot -w /www/acme -d radio.ai.ismc.ir --cert-name radio.ai.ismc.ir -n --agree-tos --keep-until-expiring --deploy-hook "systemctl reload nginx"`
4. در صورت موفقیت: **فقط دو خط** `ssl_certificate`/`ssl_certificate_key` به `/etc/letsencrypt/live/radio.ai.ismc.ir/` تغییر می‌کند
5. `nginx -t` → `systemctl reload nginx`؛ اگر تست شکست خورد، بکاپ بازگردانده و reload قبلی حفظ می‌شود
6. تأیید: `https` بدون `-k`، `/api/health`، issuer/SAN، و `certbot renew --dry-run`

**Rollback دستی:** `cp /home/saber/backups/radio-edge-tls-<TS>/radio.ai.ismc.ir.conf.bak <vhost>` → `nginx -t` → `systemctl reload nginx`

**دسترسی لازم:** `certbot` هنوز در NOPASSWD نیست (تأیید شد در 03:17) و دایرکتوری vhost برای `saber` قابل نوشتن نیست ⇒ اجرا با root یا اجرای همان یک فرمان توسط مالک سرویس.

---

## 5. پس از باز شدن پورت ۸۰ (چک‌لیست P1)

- [ ] یک اجرا (نه بیشتر) از اسکریپت بالا
- [ ] `issuer = C=US, O=Let's Encrypt`
- [ ] `SAN` شامل `radio.ai.ismc.ir`
- [ ] `https://` بدون `-k` = 200 (از شبکهٔ داخلی و یک vantage بیرونی)
- [ ] `/api/health` = 200 با `neo4j_online:true`
- [ ] `/openapi.json` = 200
- [ ] `renewal/radio.ai.ismc.ir.conf` ایجاد شده و `certbot.timer` فعال
- [ ] `certbot renew --dry-run` = موفق
- [ ] بدون ریدایرکت به CMS/`/login` و بدون سرو شدن cert دامنهٔ دیگر

---

## 6. آنچه تغییر نکرد

- هیچ فایل/سرویس روی ۱۳۳ یا ۵۳ تغییر نکرد (فقط یک اسکریپت در `/home/saber` نوشته شد)
- vhost، cert خودامضا، Nginx، DNS، firewall: **بدون تغییر**
- هیچ cert دامنهٔ دیگری دست‌نخورده باقی ماند
- اپراتور هم‌زمان: هیچ فایل مشترکی overwrite نشد

---

## 7. حکم

**`TLS = BLOCKED`** — علت اثبات‌شده: ورودی ۸۰ از دید Let's Encrypt مسدود است (نه خطای سرور، نه خطای Nginx، نه خطای webroot).
مسیرهای رفع: (B) بازکردن ۸۰ توسط تیم شبکه + یک اجرا، یا (A) DNS-01 با credential منطقه.
