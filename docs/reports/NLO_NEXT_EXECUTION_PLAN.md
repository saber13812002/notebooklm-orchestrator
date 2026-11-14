# NLO Next Execution Plan (proposed — nothing executed this mission)

Mission: **NLO-ACCESS-REBASELINE-01** — companion report (Phases I + J).
Date: 2026-11-14. Every step below requires explicit user approval before
execution.

## 1. Tier A — immediate access, zero risk (works today)

- SSH tunnel from the workstation:
  `ssh -N -L 4870:127.0.0.1:4870 saber@172.30.0.133`
- Then open `http://127.0.0.1:4870/` in the workstation browser.
- Permissions: existing SSH access only; **no change on the server**.
- Rollback: close the tunnel. Downtime: 0.

## 2. Tier B — production vhost + TLS (approval required)

Steps on the server (root/panel):

1. **Backup:** snapshot/copy the panel vhost directory
   (`/www/server/panel/vhost/nginx/*.conf`).
2. **Create the NLO vhost**: `server_name nlo.ai.ismc.ir; listen 443 ssl;`
   `proxy_pass http://127.0.0.1:4870;` plus proxy headers, WebSocket/SSE
   upgrade headers, and sane proxy timeouts. A template exists in the repo
   (`deploy/nginx/nlo-vhost.stageB.conf.tpl`).
3. **Issue the LE cert** for `nlo.ai.ismc.ir` (DNS already points to this
   host's public IP).
4. `nginx -t` then **graceful reload** (no app restart).
5. **Verify:** SNI `nlo.ai.ismc.ir` → NLO health 200; cert CN matches;
   `/api/health` 200; UI loads.

- Downtime: ≈ 15 min wall clock; the reload itself is zero-downtime for the
  app.
- Rollback: restore the previous vhost file(s), reload.
- Permissions needed: root/sudo (or panel admin) on `172.30.0.133`;
  Let's Encrypt issuance; approval of the config change.
- Security note: the app binds loopback; the vhost preserves that (proxy →
  `127.0.0.1`). Anything beyond single-user access requires the documented
  auth-capable reverse-proxy decision (loopback-only invariant).

## 3. Tier C — public HTTPS acceptance (depends on Tier B)

- **DNS:** already correct (A → `185.213.10.25` on every resolver) — **no
  DNS work needed**.
- **LE renewal:** automatic once the cert exists; renewal state stays
  **NOT VERIFIED** until the first cert exists and one renewal cycle
  completes.
- **External acceptance:** from a device outside the internal network —
  `https://nlo.ai.ismc.ir/api/health` 200 and the UI loads.

## 4. FFmpeg configuration (separate small change, own approval)

- **Server:** add `NLO_FFMPEG_BIN=/usr/bin/ffmpeg` to
  `/home/saber/saberprojects/notebooklm-orchestrator/.env` (env-file change
  → backup first), then restart `nlo` (≈ 5 s).
- **Local:** install FFmpeg or set `NLO_FFMPEG_BIN` to a local binary path.
- **Verify after:** readiness probe / capability check shows ffmpeg
  configured.
- Rollback: remove the line, restart.

## 5. Acceptance checklist (to run once approved)

- [ ] Tier A: tunnel shows production UI + `/api/health` 200
- [ ] Tier B: SNI / cert / health verified from the workstation
- [ ] Tier C: independent external-device verification
- [ ] FFmpeg: readiness shows configured; optionally one live audio job →
      MP3 56k artifact downloadable via `/jobs/{id}/audio/download`
- [ ] Webhook: create one test endpoint → `/test` dispatch → delivery logged
- [ ] All evidence recorded in a follow-up report; no secrets in the record

## 6. Required permissions summary

| Action         | Permission required                                              |
| -------------- | ---------------------------------------------------------------- |
| Tier A         | existing SSH (no change)                                         |
| Tier B         | root/sudo or panel access + LE issuance + config-change approval |
| Tier C         | external test device; LE renewal visibility (sudo)               |
| FFmpeg         | `.env` edit permission + service-restart approval                |
| Live audio job | user approval (real NotebookLM account, real egress/cost)        |

## 7. Explicitly NOT done this mission

No restart, no deploy, no nginx reload, no DNS/firewall change, no env-file
change, no new job, no push. All of the above awaits user approval.
