# NLO Local Runtime Audit (Windows workstation)

Mission: **NLO-ACCESS-REBASELINE-01** — companion report (Phase B).
Date: 2026-11-14. All commands were read-only. Every claim labeled.

## 1. Scope

- Environment: Windows 10 workstation, repository
  `c:/Users/s.tabatabaei/Documents/saberprojects/notebooklm-orchestrator`.
- Goal: record exactly which processes run NLO locally, which ports they bind,
  what they serve, and which versions are in use.

## 2. Git / tree state (VERIFIED)

- Branch: `main`; HEAD: `4e2d533` (= `origin/main`).
- The tree actually **served** by both local processes is `278273a`:
  both processes were started before the docs-only commit `4e2d533`, so the
  running code equals the deployed production tree.

## 3. Process inventory (VERIFIED — `tasklist` / `wmic process` / `netstat -ano`)

| PID       | Parent | Image      | Role                                                  | Started (+0330) |
| --------- | ------ | ---------- | ----------------------------------------------------- | --------------- |
| 14192     | –      | cmd.exe    | launcher (4870)                                       | –               |
| 31180     | 14192  | node (npx) | `npx tsx`                                             | –               |
| 13988     | 31180  | cmd.exe    | `set NLO_PORT=4870&& npx tsx apps/server/src/main.ts` | –               |
| 20164     | 13988  | tsx-cli    | TS loader                                             | –               |
| **2520**  | 20164  | **node**   | **owns `127.0.0.1:4870`**                             | 14:42:28        |
| 22644     | –      | esbuild    | tsx compiler helper                                   | –               |
| 32692     | –      | cmd.exe    | launcher (4871)                                       | –               |
| 32624     | 32692  | node (npx) | `npx tsx`                                             | –               |
| 31832     | 32624  | cmd.exe    | `set NLO_PORT=4871&& npx tsx apps/server/src/main.ts` | –               |
| 10548     | 31832  | tsx-cli    | TS loader                                             | –               |
| **21388** | 10548  | **node**   | **owns `127.0.0.1:4871`**                             | 14:52:47        |
| 8916      | –      | node       | **NOT NLO** — `openclaw` gateway on `127.0.0.1:18789` | –               |

- All NLO processes: session 2, working directory = repository root.
- Launch commands (verbatim from the terminals):
  `set NLO_PORT=4870&& npx tsx apps/server/src/main.ts` and the same for 4871.

## 4. Ports / binding (VERIFIED — `netstat -ano`)

- `127.0.0.1:4870` → PID 2520 (loopback only)
- `127.0.0.1:4871` → PID 21388 (loopback only)
- No `0.0.0.0` / IPv6 NLO listeners on the workstation.

## 5. HTTP probes (VERIFIED — curl from the same workstation)

| Path                     | :4870                                                          | :4871 |
| ------------------------ | -------------------------------------------------------------- | ----- |
| `/`                      | 200, 490 B SPA shell, etag `W/"1ea-1a1d6e5237f"`               | 200   |
| `/api/health`            | 200                                                            | 200   |
| `/api/health/ready`      | 200 (`ready:true`, worker probe ≈ 0.35 s, `liveDisabled:true`) | 200   |
| `/api/openapi.json`      | 200, 91,766 B                                                  | 200   |
| `/api/docs` (Swagger UI) | 200                                                            | 200   |
| `/openapi.json` (root)   | 200 — SPA fallback, **not** a contract path                    | 200   |

P2 paths present in the live OpenAPI document (both ports):
`/artifacts/{artifactId}/download`, `/jobs/{id}/audio/download`, `/webhooks`,
`/webhooks/{id}`, `/webhooks/{id}/deliveries`, `/webhooks/{id}/test`.

## 6. Runtime versions (VERIFIED)

- Node: **v24.14.0** (`C:\Program Files\nodejs`)
- Python (worker venv `data/venv`): **3.13.15**
- notebooklm-py: **0.8.5**
- FFmpeg: **NOT in PATH** → transcode capability reports `not_configured` locally.

## 7. Configuration (key names only — no values)

Local `.env` key names: `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`,
`NLO_PROXY_RUNTIME`, `NLO_PYTHON_BIN`, `NLO_LOGIN_BROWSER`,
`NLO_ALLOW_DIRECT_EGRESS`.

- `NLO_FFMPEG_BIN` is **absent** locally.

## 8. Database `data/nlo.sqlite` (VERIFIED — opened `mode=ro`)

- Migrations 1–6 applied (migration 6 = webhook tables).
- Jobs: **23** (6 SUCCEEDED / 12 FAILED / 5 CANCELLED / 0 RUNNING /
  0 NEEDS_ATTENTION).
- Last three jobs: SUCCEEDED 2026-11-10 (`j_599f…d66c`), SUCCEEDED
  2026-11-06, FAILED 2026-11-06.
- Artifacts: **0** (no audio job has ever completed locally).
- Webhook endpoints: 0; deliveries: 0 (outbox installed, idle).
- Job directories: 23 under `data/jobs`.
- Sessions: `nlo-acc_315776aeb5b74e33.json`, `nlo-acc_9ef8fd4d431c49fc.json`
  (+ `.lock`, `.rotate.lock`).

## 9. Workstation network context (VERIFIED)

- Workstation IP: `172.27.128.1`; DNS server `172.22.6.1`.

## 10. Conclusions

1. Both local instances are healthy and serve the P2 tree (`278273a` code).
2. They are loopback-only by design (loopback-only invariant).
3. There is **no local browser-access problem**: `http://127.0.0.1:4870/` and
   `http://127.0.0.1:4871/` work on the workstation itself.
4. Local FFmpeg gap (not installed) is a capability configuration item, not a
   runtime fault.
