# Phase B — Server Endpoint Connectivity Verification (Read-Only)

**Date:** 2026-11-01 (UTC) · **Author:** automated (read-only) · **Addendum phase:** B
**Target:** `http://172.30.0.133:4000/v1` (new internal endpoint from the addendum)
**Method:** pure network probes from this workstation (TCP/HTTP via `curl`, DNS via
`nslookup`). **Zero mutating calls.** No tokens requested, received, or printed.

---

## 1. Executive summary

> **`172.30.0.133:4000` is LiteLLM v1.101.0** — an OpenAI-format LLM proxy
> ("Proxy Server to call 100+ LLMs in the OpenAI format"). It is **NOT** the NLO
> web address, not an SSH host, not GitLab, not the reverse proxy.
>
> The whole s52 workload appears re-homed to `172.30.0.133`: GitLab (`:81`),
> Wiki.js (`:8888`) answer there, and all three org domains (`nlo.`/`git.`/
> `docs.ai.ismc.ir`) now resolve to it. The old host `172.20.1.52` is **down**
> (all probes time out). **NLO itself is not running on the new host yet**
> (`:4870` connection refused).
>
> OpenAI-compatible base URL: **`http://172.30.0.133:4000/v1`**
> (also `…/v1/models`, `…/v1/chat/completions`, …). Auth: `Authorization: Bearer <key>`
> (401 `auth_error` when absent).

## 2. Service identification — LiteLLM

Evidence (all from this session):

| Probe               | Result                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`             | **200** — HTML titled **"LiteLLM API - Swagger UI"**; loads `url: '/openapi.json'`                                                                                                                                                                                                                                                                                   |
| `GET /openapi.json` | **200**, 1,517,449 bytes, 1.93 s (saved to gitignored `tmp/litellm-openapi.json`; summary in `tmp/litellm-oas-summary.txt`)                                                                                                                                                                                                                                          |
| OpenAPI `info`      | `title: "LiteLLM API"`, `version: "1.101.0"`, description "Proxy Server to call 100+ LLMs in the OpenAI format… Admin Panel on /ui"                                                                                                                                                                                                                                  |
| Paths               | **618** paths, all core OpenAI ones present with `/v1` aliases: `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/audio/*`, `/v1/files`, `/v1/batches`, `/v1/responses`, plus provider passthrough (`/openai/`, `/anthropic/`, `/azure/`, `/vertex_ai/`, …) and admin surface (`/health/*`, `/key/*` family, `/ui`) |

### Response headers (observed)

```
HTTP/1.1 <code>
date: Sun, 01 Nov 2026 20:11:06 GMT
content-type: application/json | text/html; charset=utf-8
x-frame-options: DENY
content-security-policy: frame-ancestors 'none'
x-content-type-options: nosniff
```

No `server:` header (LiteLLM behind a fronting layer that strips it; `/` Swagger
page references `/swagger/*` asset paths).

## 3. Route-by-route probe results (read-only)

| Probe                                             | HTTP                | Body / behavior                                                                                                       | Interpretation                                                         |
| ------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET http://172.30.0.133:4000/v1`                 | **404**             | `{"detail":"Not Found"}`                                                                                              | `/v1` itself is a prefix, not a route — expected for OpenAI-style APIs |
| `GET http://172.30.0.133:4000/`                   | **200**             | LiteLLM Swagger UI HTML                                                                                               | public docs shell                                                      |
| `GET …/openapi.json`                              | **200**             | full spec (1.5 MB)                                                                                                    | contract available without auth                                        |
| `GET …/health`                                    | **401**             | `{"error":{"message":"Authentication Error, No api key passed in.","type":"auth_error","param":"None","code":"401"}}` | health requires a key (LiteLLM key-based)                              |
| `GET …/health/liveliness`                         | **200**             | `"I'm alive!"`                                                                                                        | **liveness is unauthenticated** — use for monitors                     |
| `GET …/health/readiness`                          | **200**             | `{"status":"healthy","db":"connected"}`                                                                               | DB (SQLite/Postgres) connected; no key needed                          |
| `GET …/v1/models`                                 | **401**             | auth_error above                                                                                                      | needs `Authorization: Bearer <key>`                                    |
| `GET …/v1/chat/completions`                       | **405**             | `{"detail":"Method Not Allowed"}` + `allow: POST`                                                                     | route exists, POST-only                                                |
| `POST …/v1/chat/completions` (no key, empty body) | **401**             | auth_error                                                                                                            | auth gate fires **before** body validation — key check is first        |
| `GET …/ui`                                        | **307**             | redirect (admin UI login flow)                                                                                        | admin panel present                                                    |
| `GET …/swagger/swagger-ui.css` etc.               | served by same host | —                                                                                                                     | self-hosted swagger assets (air-gap friendly)                          |

### Latency (this workstation → 172.30.0.133)

| Metric                       | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| TCP connect                  | 17–25 ms                                                               |
| Full response (small routes) | 9–43 ms                                                                |
| `/openapi.json` (1.5 MB)     | 1.93 s                                                                 |
| Timeout budget used          | 15 s (nothing near it)                                                 |
| Error response shape         | consistent JSON envelope `{"error":{"message","type","param","code"}}` |

**Auth method proven:** LiteLLM master/user API key via `Authorization: Bearer`.
No key → 401 `auth_error` on all data routes. Liveness/readiness are the
unauthenticated exceptions. **No token was requested or used** — model listing /
call validation deferred to Phase E (needs a key from the user via secret store).

## 4. Is it OpenAI-compatible? — YES (base URL proven by structure)

- Exact OpenAI path set with `/v1` prefix: `/v1/chat/completions`, `/v1/models`,
  `/v1/embeddings`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/files`,
  `/v1/batches`, `/v1/moderations`, `/v1/responses`, `/v1/assistants`, `/v1/threads`.
- 405 on GET `/v1/chat/completions` with `allow: POST` = real OpenAI-shaped handler.
- **Recommended base URL for clients:** `http://172.30.0.133:4000/v1`
  (OpenAI SDKs also accept `http://172.30.0.133:4000` and append `/v1` themselves).
- Model IDs: **unknown without a key** (deferred to Phase E).

## 5. Host-level reconnaissance (read-only)

| Probe                                         | Result                                                                        | Meaning                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `http://172.30.0.133:81/`                     | **302** → `https://172.30.0.133:81/users/sign_in`, `Server: nginx`            | **GitLab** is on the new host (port 81, same as on s52)                                                                             |
| `http://172.30.0.133:8888/`                   | **200**                                                                       | **Wiki.js** is on the new host (same port as s52)                                                                                   |
| `http://172.30.0.133:4870/api/health`         | **connection refused** (2.05 s)                                               | **NLO is not yet running on the new host**                                                                                          |
| `https://nlo.ai.ismc.ir/api/health`           | **404** `{"message":"مورد مورد نظر یافت نشد."}` (default-vhost answer, 99 ms) | domain points at new host but **no NLO vhost yet**                                                                                  |
| `nslookup nlo.ai.ismc.ir`                     | **→ 172.30.0.133**                                                            | DNS already migrated (was 172.20.1.52 per Phase 0 report; 80.191.92.189 per PHASE_A_AUDIT — the earlier reports are now historical) |
| `nslookup git.ai.ismc.ir` / `docs.ai.ismc.ir` | **→ 172.30.0.133** (both)                                                     | GitLab/Wiki.js DNS migrated with the host                                                                                           |
| `http://172.20.1.52:4870` / `:81`             | **timeout** (6 s each)                                                        | **old host unreachable — decommissioned/moved**                                                                                     |

## 6. Local NLO baseline (4871)

| Probe                                        | Result                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET http://127.0.0.1:4871/api/health`       | **200** `{"ok":true,"service":"notebooklm-orchestrator",…}` (2–91 ms)                                                                                                                                                                                                                                                                     |
| `GET http://127.0.0.1:4871/api/health/ready` | **200** `{"ok":true,"ready":true,"provider":{"name":"python-worker","configured":true,"issues":[]},"proxyRuntime":{"state":"available","name":"xray"},"liveDisabled":true}` (0.4–1.2 s; ×3 stable)                                                                                                                                        |
| Worker lifecycle                             | spawn → SIGTERM clean each cycle; log `tmp/dev4871-repro.log`                                                                                                                                                                                                                                                                             |
| Incident                                     | the _previous_ long-lived 4871 instance (PID 23320) crashed once during a `/api/health/ready` (curl 56, then port closed); replaced by a stable instance (PID 27528) in this phase. No `uncaughtException` handler in [`apps/server/src/main.ts`](../../apps/server/src/main.ts) — follow-up hardening recommended, **not changed here**. |
| Stale 4870 (PID 8380)                        | **untouched** — still serving `/api/health` 200                                                                                                                                                                                                                                                                                           |

## 7. Conclusions

1. **Identity proven:** `172.30.0.133:4000` = **LiteLLM v1.101.0** LLM proxy,
   OpenAI-compatible, Bearer-key auth, DB healthy, 618 documented routes.
2. **It is not NLO** — and must never be substituted for NLO's web address,
   SSH host, GitLab, or proxy. The addendum's "critical distinction" is confirmed.
3. **Migration state:** GitLab + Wiki.js **already migrated** (services answering
   on new host, DNS moved); NLO **pending** (no listener on :4870, no vhost on the
   domain); old host **dead**.
4. **Phase C design input:** add `NLO_INTERNAL_API_BASE_URL`
   (default `http://172.30.0.133:4000`) documented explicitly as _the internal
   LLM proxy (OpenAI-compatible)_; auth via existing secret conventions
   (env/vault, never in repo/chat).
5. **Phase E input:** unauthenticated monitor endpoints = `/health/liveliness`
   (200) and `/health/readiness` (200); authenticated checks = `/v1/models` with a
   key (401 without) — these make a clean integration-test matrix.

## 8. Safety statement

- GET/HEAD-only + two intentionally-failing POST/GET combos to document error
  behavior; **no mutating requests** (no key creation, no model config, no
  completions with a key).
- No credentials were requested, captured, or printed; no secrets in this report.
- No local file/config/service was modified; 4871 restored and running.

**Status:** Phase B **Complete — STOP, awaiting user approval for Phase C.**
