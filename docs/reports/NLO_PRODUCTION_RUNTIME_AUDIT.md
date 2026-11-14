# NLO Production Runtime Audit (172.30.0.133)

Mission: **NLO-ACCESS-REBASELINE-01** — companion report (Phase C).
Date: 2026-11-14. All commands read-only over SSH (`saber@172.30.0.133`).
No service was restarted or reloaded during this mission.

## 1. Host identity (VERIFIED)

- Hostname: `AI-TOOLS`
- OS: Ubuntu 24.04.4 LTS; kernel `6.8.0-147-generic`
- Uptime: 14 days; 12 logged-in users; load ≈ 2.7
- Disk: 686 G total / 249 G used (38 %)
- RAM: 78 Gi (54 Gi available)
- Interface: `ens33 = 172.30.0.133/20` (plus docker bridge/veth interfaces)
- Host is a Docker host (multiple container networks observed)

## 2. systemd unit (VERIFIED — verbatim from `/etc/systemd/system/nlo.service`)

```ini
[Unit]
Description=NotebookLM Orchestrator (single-user, loopback)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=saber
Group=saber
WorkingDirectory=/home/saber/saberprojects/notebooklm-orchestrator/apps/server
Environment=PATH=/home/saber/.local/node22/bin:...
ExecStart=/home/saber/saberprojects/notebooklm-orchestrator/node_modules/.bin/tsx src/main.ts
Restart=always
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nlo
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Notes:

- **No `EnvironmentFile`** — the application loads `<repo>/.env` itself.
- Auto-restart: `Restart=always`, `RestartSec=5`.
- Hardening: `NoNewPrivileges=true`, `PrivateTmp=true`.
- Unit description matches observed behavior: single-user, loopback bind.

## 3. Service state (VERIFIED)

- `systemctl status nlo` → **active (running)**.
- MainPID **1260062** (tsx, started 2026-11-14 11:40 UTC) → child **1260079**
  (node; owns `127.0.0.1:4870`).

## 4. Ports (VERIFIED — `ss -ltnp`)

- `127.0.0.1:4870` → node, PID 1260079 (loopback only)
- `:4871` → **not listening** (connection refused) — production runs a
  single instance, as designed.
- 80 / 443 / 444 on `0.0.0.0` → nginx stacks (see
  `NLO_NETWORK_AND_NGINX_AUDIT.md`).

## 5. HTTP probes (VERIFIED — from the server itself)

| Path                | Status | Time   |
| ------------------- | ------ | ------ |
| `/`                 | 200    | 6.5 ms |
| `/api/health`       | 200    | 0.9 ms |
| `/api/health/ready` | 200    | 83 ms  |
| `/api/openapi.json` | 200    | 4.5 ms |
| `/api/docs`         | 200    | –      |

## 6. Runtime versions (VERIFIED)

- Node: **v22.23.4** (`/home/saber/.local/node22/bin`)
- Python (venv): **3.12.3**
- notebooklm-py: **0.8.5**
- FFmpeg: **6.1.1 installed** at `/usr/bin/ffmpeg` — **but**
  `NLO_FFMPEG_BIN` is **absent** from the server `.env`, so the adapter
  (`ffmpegBin: (env("NLO_FFMPEG_BIN") ?? "").trim()`) resolves to empty and
  transcode reports `not_configured`. Installed binary ≠ configured capability.

## 7. Repository state (VERIFIED)

- Path: `/home/saber/saberprojects/notebooklm-orchestrator`
- HEAD: `278273a` (`main`); 0/0 vs `origin/main`.
- Pre-existing untracked files (NOT introduced by this mission):
  - `apps/server/src/proxy/connect-proxy.ts.bak-curlfix` (6,867 B, Oct 26)
  - `apps/server/src/queue/job-runner.ts.bak-e2efix` (24,216 B, Oct 26)
  - `nul` (0 B, Oct 28)

## 8. Configuration (key names only — no values)

Server `.env` key names: `NLO_HOST`, `NLO_PORT`, `NLO_PROVIDER`,
`NLO_PYTHON_BIN`, `NLO_PROXY_RUNTIME`, `NLO_LOGIN_BROWSER`,
`NLO_ALLOW_DIRECT_EGRESS`, `NLO_RADIO_BASE`, `NLO_RADIO_TOKEN`,
`NLO_RADIO_TIMEOUT_MS`, `NLO_ORCH_NLO_TIMEOUT_MS`.

- `NLO_FFMPEG_BIN` is **absent**.

## 9. Database (VERIFIED — read-only)

- Migrations 1–6; migration 6 applied at `2026-11-14T11:40:01.243Z`
  (webhook tables `webhook_endpoints`, `webhook_deliveries` present).
- Jobs: **11** (5 SUCCEEDED / 6 FAILED). Last three all SUCCEEDED
  2026-11-12 21:02–21:11 UTC.
- Artifacts: 0; webhook endpoints: 0; deliveries: 0.
- `data/` layout: `backups`, `deployed-commit` (= `278273a`), `jobs`,
  `nlo.sqlite` (+ wal/shm), `sessions`, `tmp`, `vault`, `vault.key`, `vendor`,
  `venv`.
- Sessions: 1 file, `nlo-acc_5a03a60bbda24085.json`.
- `apps/web/dist/index.html` 490 B (Oct 25) — identical size to local.

## 10. Conclusions

1. Production is healthy and runs `278273a` (P1+P2 code) under systemd.
2. It is reachable **only** at `127.0.0.1:4870` on the host.
3. The single configuration gap found: FFmpeg binary installed but not wired
   via `NLO_FFMPEG_BIN`.
4. No restart, no state change, no new files during this mission.
