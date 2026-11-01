# Operations

The production service runs as systemd unit `nlo.service`, port `4870`
(loopback) on the production host.

> **Status (2026-11-01):** the legacy host s52 (`172.20.1.52`) is
> decommissioned (unreachable). NLO is **not yet running on the new host**
> `172.30.0.133` — re-deployment is pending (endpoint-migration addendum,
> Phase G). GitLab and Wiki.js are already live on the new host. All
> procedures below are host-agnostic and apply once NLO is deployed.

## Canonical docs

- Deployment procedure (git-based, backup/verify/rollback):
  [`../deployment/s52-deploy.md`](../deployment/s52-deploy.md)
- Service unit: `deploy/systemd/nlo.service` (tracked, secret-free)
- Deploy script: `deploy/deploy.sh`

## Day-2 operations

| Task          | How                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------- |
| Check health  | `curl -s http://127.0.0.1:4870/api/health` and `/api/health/ready` (expect `ready:true`) |
| Check service | `systemctl status nlo`                                                                   |
| View logs     | `journalctl -u nlo --since "1 hour ago" --no-pager`                                      |
| Deploy        | `bash deploy/deploy.sh origin/main` (only reviewed commits)                              |
| Rollback      | `ROLLBACK=1 bash deploy/deploy.sh <previous-good-commit>`                                |
| Restore DB    | from `data/backups/nlo-<TS>-<sha>.sqlite` (stop service, copy, start)                    |
| Backups       | DB + `.env` auto-backed-up per deploy, 5 newest kept in `data/backups/`                  |

## Runtime data (never in git, must survive recreate)

`data/` — SQLite DB, job archives, vault (AES-256-GCM, 0600 key), session
files (0700), `data/vendor/xray` (proxy binary + geo data), `data/venv`
(Python worker). Docker Compose (local runs) mounts `./data` as a volume.

## Environment notes

- On the current production host, Node is at `/home/saber/.local/node22/bin`
  (the systemd unit + deploy.sh harden `PATH` for non-interactive shells).
- The Xray binary is a vendored drop-in in `data/vendor/xray/` (not in the
  repo — it is a binary).
- `NLO_LIVE_TESTS` gates live _tests_ (off by default). The live _provider_
  is selected by `NLO_PROVIDER=python-worker` + `NLO_PROXY_RUNTIME=xray`.

## Planned (Phase F)

External access via `nlo.ai.ismc.ir` (DNS A record already exists) behind an
auth-capable reverse proxy + TLS. Until then: **no external exposure by
design.**
