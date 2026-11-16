# طراحی VLESS Proxy

## ۱. دامنه

مدیریت نودهای VLESS (افزودن از URI یا دستی، ویرایش، enable/disable، حذف با تأیید، priority و fallback، تست health، نمایش masked). **پیاده‌سازی اختصاصی پروتکل VLESS انجام نمی‌شود** — runtime از Xray (binary رسمی) استفاده می‌کند، فعلاً به‌صورت **stub + mock** (نصب واقعی نیازمند تأیید کاربر).

## ۲. فرمت URI و قوالب parser

`vless://<uuid>@<server>:<port>?<params>#<name>`

- parser با `URL` + تحلیل صریح query؛ **percent-decoding** درست (`decodeURIComponent` با کنترل خطا)
- URI نامعتبر → خطای بازمگشت‌شده به UI (بدون swallow)
- پارامترهای معنی‌دار: `type`(tcp|ws|grpc)، `security`(none|tls|reality)، `sni`، `host`(ws)، `path`(ws)، `pbk`، `sid`، `spx`، `flow`، `encryption`، `alpn`
- **پارامترهای ناشناخته حذف نمی‌شوند** → در `extra_json` با warning «ناشناخته» نگهداری می‌شوند
- ترکیب‌های نامعتبر (مثلاً `ws` بدون `path`) → خطای اعتبارسنجی صریح
- **masking:** UUID هرگز در log/خطا/UI کامل نمایش داده نمی‌شود؛ نمایش `••••-••••-XXXX` (۴ کاراکتر آخر). URI کامل فقط هنگام ورود است.

## ۳. مدل نود

```
proxy_nodes(
  id, name UNIQUE, server, port,
  uuid_ref → secrets(vault),
  transport, security, sni, ws_host, ws_path,
  extra_json, enabled, priority (کمتر = اولویت بالاتر),
  created_at, updated_at
)
proxy_health(node_id, last_checked_at, ok, egress_ip, latency_ms, error)
proxy_health_history(...)
```

**Fallback order** = نودهای enabled مرتب‌شده بر اساس `priority`؛ نود «preferred» = بالاترین اولویت + flag. انتخاب خودکار job: اولین نود enabled و سالم؛ اگر health-check فعلی ناموفق باشد، نود بعدی؛ اگر هیچ نود سالمی نباشد و job پروکسی را **نیاز** داشته باشد → job `FAILED` با دلیل واضح (fail-closed).

## ۴. runtime و انزوا

```
ProxyRuntime (interface)
 ├── MockProxyRuntime      # پیش‌فرض: deterministic؛ listener شبیه‌سازی‌شده؛ state از config test
 └── XrayProxyRuntime      # stub: تا نصب/تأیید، status = "runtime not configured"
```

**استراتژی انزوا (هدف، فعلاً mock-tested):**

- هر tunnel → **listener محلی اختصاصی** روی `127.0.0.1:<port>` (SOCKS5 یا HTTP CONNECT) که Xray بالا می‌آورد
- worker provider **فقط** به آن listener وصل می‌شود (env proxy فقط روی فرزند)
- **routing سیستمی، VPN سیستمی، تغییر DNS/firewall انجام نمی‌شود** — مرز امنیتی = listener + frزند فرآیند
- اگر listener بالا نیامد / tunnel قطع شد → transport worker خطا می‌دهد (fail-closed)؛ **هرگز** direct fallback

**محدودیت شفاف:** فعلاً Xray نصب نیست و هیچ ترافیک واقعی نمی‌رود. «Tunnel up» در UI فعلی فقط وضعیت mock است و با برچسب مشخص نمایش داده می‌شود.

## ۵. Health-checkها

| تست                      | ورودی                                                                      | خروجی                                      |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------ |
| config validity          | فقط record دیتابیس                                                         | ok/invalid + دلیل (parser + ruleهای ترکیب) |
| tunnel connectivity      | runtime                                                                    | ok/down + latency                          |
| egress IP                | **فقط** endpointهای allowlist (پیش‌فرض: یک سرویس عمومی تشخیص IP)           | ip + تطابق با انتظار                       |
| destination reachability | **فقط** destinationهای allowlist‌شده (معمولاً `notebooklm.google.com:443`) | ok/blocked + زمان                          |

**SSRF:** endpointهای user-supplied دلخواه پذیرفته **نمی‌شوند**. `assertAllowedDestination()`:

- رد می‌کند: loopback، link-local، private (10/8, 172.16/12, 192.168/16)، cloud metadata (169.254.169.254)، port 22/23/3389 و…
- accept: فقط entries در allowlist (host:port صریح در settings) + public IP/hostname عمومی
- resolve می‌شود و **IP نهایی** هم چک می‌شود (دفع DNS rebinding)

## ۶. testهای fail-closed (فاز 5 — همه قطعی، بدون شبکه)

1. proxy unavailable (هیچ نود enabled) → job FAIL با دلیل، **بدون direct egress**
2. tunnel down در حین job → RETRY_WAIT/FAILED، بدون direct
3. conf نامعتبر (ws بدون path) → خطای اعتبارسنجی
4. runtime crash (mock kill) → خطا، بدون direct
5. DNS failure (mock resolver fail) → خطا
6. upstream timeout (mock clock) → خطا + backoff
7. egress IP نادرست (mock egress ≠ expected) → node down، fallback؛ اگر fallback هم نباشد → FAIL
8. fallback node down → job FAIL
9. worker restart (mock worker death، نتیجه مبهم) → `NEEDS_ATTENTION`
10. app restart با job in-progress → job به `QUEUED` باز می‌گردد (test restart)

تست‌ها از **transport mock** استفاده می‌کنند که direct-connect را عمداً رد/ثبت می‌کند؛ اگر هر تستی مستقیم‌connection ثبت کند، test **fail** می‌شود.

## ۷. برنامه‌ی فعال‌سازی Xray (نیازمند تأیید کاربر)

1. دانلود binary رسمی Xray (linux-amd64) به `data/vendor/xray/` — **بدون** نصب سیستمی، بدون service
2. ارزیابی: لایسنس (MPL-2.0)، امضای integrity hash، platform
3. `XrayProxyRuntime` فعال‌سازی می‌شود (env `NLO_PROXY_RUNTIME=xray`)
4. egress verification واقعی: health-check + تست egress IP + reachability destination
5. فقط بعد از آن، jobهای live مجاز می‌شوند (و live provider هم جدا تأیید می‌خواهد)

## ۸. Egress Gateway (NLO-P4-1B — پیاده‌سازی‌شده + mock-tested)

تا P4-1B، تصمیم egress **داخل فراخوانی provider** بود: `tunnelEnv` (متغیرهای proxy) مستقیم روی worker تزریق می‌شد. حالا تصمیم egress یک **سرویس پلتفرم** است — [`EgressGateway`](../../apps/server/src/proxy/gateway.ts) (ADR-004):

```
EgressGateway
  ├── acquire(ctx, policy) → EgressAcquisition { endpoint, reason, rejected[] }
  │     ├── policy "tunnel-required": selectAuto؛ هر خطا → EgressAcquireError (fail-closed، پیام اصلی حفظ)
  │     └── policy "direct-allowed": direct فقط وقتی هیچ نود enabled نباشد AND NLO_ALLOW_DIRECT_EGRESS=1
  ├── release(endpoint) → idempotent (WeakSet) → runtime.stopTunnel(nodeId)
  └── endpointEnv(endpoint) → ۸ متغیر env proxy روی 127.0.0.1 (تنها منبع env برای worker)
```

- **`EgressEndpoint { nodeId, localPort, expectedEgressIp, evidenceRef }`** = descriptor سمت provider؛ provider **هرگز** `TunnelHandle` نمی‌بیند. `evidenceRef` = `proxy_health:<nodeId>@<lastCheckedAt>` (ردیف health که نود را واجد شرایط کرده — قابل audit).
- **Job runner** قبل از RUNNING یک `acquire` انجام می‌دهد، `proxy_selected` log می‌زند (با `reason`)، و در `finally` `release` می‌کند.
- **Auth ops** (login/refresh روی python worker) با `direct-allowed` acquire می‌شوند و release **نمی‌کنند** (tunnel عمر session را دارد).
- `endpoint: null` در requestهای provider → `DirectEgressBlockedError` (fail-closed در آدرسور egress provider).
- **تست‌ها:** `test/egress-gateway.test.ts` (۱۱ تست) + `describe` جدید در `test/fail-closed.test.ts` (۵ تست: بدون نود → fail-closed؛ نود سالم → SUCCEEDED با همه attempts `viaTunnel`؛ نود ناسالم → reject؛ release → listener بسته می‌شود، observable با connect→ECONNREFUSED).
- **حداکثر:** affinity account↔node، سقف concurrency per-node، و re-acquire میانه‌ی job هنوز **planned** (در ADR-004 مستند).
