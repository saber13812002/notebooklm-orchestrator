# Phase G1 — New Internal Endpoint: Live Verification (read-only)

**Date:** 2026-11-02 (UTC) · **Author:** automated (read-only) · **Addendum phase:** G1
**Endpoint under test:** `http://172.30.0.133:4000` (OpenAI-compatible surface under `/v1`)
**Baseline:** local `main` = `origin/main` = `0e5b8b8` (clean tree; untracked scratch: `$out`, `HTTP`, `tmp/`)
**Authorization boundary honored:** READ-ONLY. No inference requests, no
production change, no `.env` change, no restart, no deploy, no DNS/proxy/TLS change.

## 1. Mission

Verify the new internal endpoint from the authorized company environment:
network reachability, service identity, authentication method, model-listing
behavior, response times, and secret hygiene. Distinguish **TCP connectivity**
from **authenticated API connectivity**.

## 2. Initial state

| Item | State |
| --- | --- |
| Repo | `0e5b8b8`, in sync with `origin/main`; untracked: `$out`, `HTTP`, `tmp/` (scratch, never staged) |
| Local dev server | `127.0.0.1:4871` running (python-worker, xray; log `tmp/dev4871-repro.log`) — untouched this phase |
| Stale 4870 instance | still present locally (per standing note: do not kill without approval) |
| LLM API key | **not available** on this workstation (no key variable in local `.env`; none documented) |
| Old host `172.20.1.52` | not probed (decommissioned; Phase B evidence stands) |

## 3. Actual commands and results

Probes: `tmp/g1-probe.ps1`, `tmp/g1-probe2.ps1` (gitignored scratch; GET-only,
5–15 s timeouts, no credentials sent). Executed from the Windows workstation
on the company network (the authorized company environment).

### 3.1 TCP connectivity — port 4000

| Check | Command (abbrev.) | Result |
| --- | --- | --- |
| TCP `172.30.0.133:4000` | `TcpClient.BeginConnect` (5 s budget) | **connected = true, 112 ms** |
| TCP `172.30.0.133:22` (SSH) | same, 5 s budget | **connected = true, 15 ms**, banner `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20` |
| Negative control TCP `172.30.0.133:4870` | same, 5 s budget | **refused/timeout (2193 ms)** → NLO is **not** running on the new host (re-confirms Phase B) |

**Verdict: TCP-level reachability = VERIFIED (port 4000 and 22; 4870 closed).**

### 3.2 HTTP probes — service identification

| Probe | Status | Latency | Evidence |
| --- | --- | --- | --- |
| `GET /` | **200** | 60 ms | Swagger UI page, `<title>LiteLLM API - Swagger UI</title>` |
| `GET /openapi.json` | **200** | 222 ms | 1,517,449 bytes; `info.title = "LiteLLM API"`; **`info.version = "1.101.0"`**; description: "Proxy Server to call 100+ LLMs in the OpenAI format" |
| `GET /health/liveliness` | **200** | 3 ms | body `"I'm alive!"` (unauthenticated) |
| `GET /health/readiness` | **200** | 5 ms | body `{"status":"healthy","db":"connected"}` (unauthenticated) |
| `GET /health` | **401** | 23 ms | `{"error":{"message":"Authentication Error, No api key passed in.","type":"auth_error","param":"None","code":"401"}}` |
| `GET /v1/models` (no key) | **401** | 64 ms | identical 401 auth envelope |
| `GET /v1/models` (no key, repeat) | **401** | 48 ms | identical — deterministic |

Readiness latency over 5 consecutive calls: **6, 3, 2, 2, 3 ms** (stable, sub-10 ms;
well inside the client's 15 s default timeout in
[`apps/server/src/internal-llm.ts`](../../apps/server/src/internal-llm.ts)).

### 3.3 Determinations (G1 checklist)

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Network reachability from authorized company environment | ✅ **VERIFIED** (TCP + HTTP 200) |
| 2 | TCP connectivity on port 4000 | ✅ **VERIFIED** (112 ms) |
| 3 | HTTP response from `/v1` surface | ✅ **VERIFIED** (auth-gated 401 envelope; `/` + `/openapi.json` open) |
| 4 | `GET /v1/models` if supported | ⚠️ **Path exists (LiteLLM OpenAI surface) but requires an API key** — model list **not** retrievable unauthenticated. 401 `auth_error` is the documented "no key" case, not a missing route. |
| 5 | Service is LiteLLM or another compatible API | ✅ **LiteLLM v1.101.0** — OpenAI-compatible proxy (version from its own `/openapi.json` `info.version`; matches the Phase C doc claim) |
| 6 | Required authentication method | ✅ **`Authorization: Bearer <api-key>`** (HTTP 401 `auth_error` "No api key passed in" on all `/v1/*` and `/health` without a key) |
| 7 | Model listing / response format | ⚠️ **Format confirmed (OpenAI-compatible JSON), listing blocked** pending key — see §4 |
| 8 | Response time / timeout behavior | ✅ **VERIFIED** (readiness 2–6 ms; openapi 222 ms; no timeouts at 15 s) |
| 9 | API keys never printed/stored in reports | ✅ **VERIFIED** — no key was sent or received; all captured bodies re-checked for key material before writing; none present |
| 10 | If credentials unavailable → request secure provisioning | ✅ **Requested below (§4)** — no key is requested in chat |

### 3.4 Connectivity verdict — explicit distinction

| Level | State |
| --- | --- |
| TCP to `172.30.0.133:4000` | **PROVEN** (112 ms) |
| Unauthenticated HTTP API | **PROVEN** (200 on public routes; deterministic 401 on `/v1/*`) |
| **Authenticated** API (`/v1/models` with Bearer key) | **NOT PROVEN — blocked solely by missing API key** |

## 4. Authentication status (without secrets)

- The proxy enforces a master/key auth model: every `/v1/*` (and `/health`)
  request without `Authorization: Bearer <key>` returns 401 `auth_error`.
- LiteLLM additionally exposes key management at `/ui` (admin panel,
  "Create, Edit Keys with SSO" per its OpenAPI description) — key creation is
  an operator action **on the LiteLLM side**, not something this repository
  can or should do unilaterally.
- **Provisioning request (secure path, no key in chat):** the LiteLLM
  operator needs to (a) create a scoped API key for NLO, (b) deliver it via
  the existing secret store convention (host-side `0600` file or vault —
  same pattern as the NLO vault key and the Phase 2 admin token), and
  (c) confirm which models/scopes the key may use. Until then, authenticated
  `/v1/models` verification and any inference call remain a manual gate.
  **No inference request was made in this phase (out of scope by mission).**

## 5. Configuration cross-check (client ↔ live endpoint)

- Variable: `NLO_INTERNAL_API_BASE_URL` (default `http://172.30.0.133:4000`)
  — [`apps/server/src/config.ts:147`](../../apps/server/src/config.ts);
  local `.env` does **not** set it, so the default (the live-verified address)
  is exactly what runs.
- Client path whitelist `/^\/v1(?:\/[A-Za-z0-9._~-]+)+$/` + `..` rejection
  matches the live surface; the live 401 body shape
  `{"error":{"message":…,"type":"auth_error",…}}` matches the client's
  `OpenAiErrorBody` handling exactly (only `error.message` is surfaced —
  never a key).
- Client default timeout 15 s vs. observed 2–222 ms response times:
  comfortable margin; the `llm_timeout`/`llm_unreachable` paths are unit-tested
  (Phase E, `internal-llm.test.ts`).

## 6. Current deployment SHA

| Where | SHA |
| --- | --- |
| Local `main` / `origin/main` | `0e5b8b8` |
| Production (legacy s52, decommissioned) | last known `b5e9ad3` (historical) |
| New host `172.30.0.133` (NLO) | **no deployment** (`:4870` refused this run) |

## 7. Outstanding risks (G1)

1. **R1 — Unauthenticated 200s on public routes** (`/`, `/openapi.json`,
   `/health/liveliness`, `/health/readiness`): the proxy discloses its version
   (1.101.0) and OpenAPI doc to any LAN client. Low risk on an internal LAN;
   noted for the LiteLLM operator. No action authorized in this phase.
2. **R2 — Authenticated path unproven**: G3's "real LiteLLM connectivity"
   claim stays **unverifiable** until a key is provisioned. This is the single
   gate between G1 and a confident G3.
3. **R3 — Plain HTTP on the internal segment** (`http://`, no TLS): the Bearer
   key will transit cleartext on the company LAN. Acceptable only if the LAN
   segment is trusted; otherwise request a TLS front. Flag for the
   domain/TLS workstream (kept separate per mission).

## 8. Recommended next action

Provision the scoped LiteLLM API key via the secret store (request in §4),
then — with separate approval — a one-shot authenticated `GET /v1/models`
through the existing `listModels()` client to close R2. **No production
change is recommended by G1.** G3 remains behind an explicit approval gate.

## 9. Mandatory STOP

G1 is complete. **No production was modified, no service restarted, no
`.env` changed, no deployment performed, no reverse proxy / DNS / TLS
touched, no inference request submitted.** Evidence presented; awaiting
explicit approval before Phase G3.
