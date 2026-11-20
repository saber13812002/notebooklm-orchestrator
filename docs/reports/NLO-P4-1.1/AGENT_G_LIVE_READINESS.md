# Agent G — Live Acceptance Readiness Audit (NLO-P4-1.1)

- **Agent role:** Live Acceptance Readiness (Qwen)
- **Mode:** readiness assessment **only** — no real job was executed, no session was refreshed, no
  retry was triggered. Executed sequentially in a separate context (no true subagents — see
  CONSOLIDATED §parallelism).
- **Executed:** 2026-11-17 ~16:27–16:35 UTC. Probes: local dev server `127.0.0.1:4871` (running,
  mock-capable), `data/` directory inspection, `.env` key inspection (key names only — **no values
  of secrets** printed).

---

## 1. Readiness matrix (per mission checklist)

| Component | Local workstation (4871) | Production (172.30.0.133) | Verdict |
|---|---|---|---|
| **Google Session** | ✅ 3 storage-state files + rotate-locks present in `data/sessions/` (real accounts from prior live phases) — **file presence VERIFIED**; session *validity* NOT re-checked (no verify call executed this audit) | BLOCKED (no SSH; no NLO instance there yet) | **READY-ON-PAPER / validity NOT-VERIFIED** |
| **Account** | account CRUD/health routes integration-tested (green, Agent D); local DB has account rows (sessions dir implies ≥3 accounts) | BLOCKED | **MOCK-VERIFIED locally** |
| **Proxy (nodes)** | 52 VLESS nodes historically imported (`_add-nodes.py`); node rows live in DB (not re-listed this audit — read-only scope kept minimal); `NLO_PROXY_RUNTIME=xray` set | BLOCKED | **PARTIALLY-VERIFIED** (config present, DB state not re-queried) |
| **Egress (xray runtime)** | `data/vendor/xray.exe` + `data/vendor/cfg` present; `/api/health/ready` → `proxyRuntime: {"state":"available","name":"xray"}` | BLOCKED | **READY locally (VERIFIED via ready probe)** |
| **NotebookLM provider** | `NLO_PROVIDER=python-worker` set; **ready probe shows `provider.configured:false`** with issue: `worker start failed: python worker exited unexpectedly (code=3221225794, signal=none)` (0xC0000006 — Windows native-handle error, typical of a broken venv / missing native dep) | BLOCKED | **NOT READY locally — worker cannot start** (G-BL-01) |
| **Worker (python venv)** | `data/venv/Scripts/python.exe` present (`NLO_PYTHON_BIN` points at it); but the spawn check above fails → venv install is incomplete/corrupt on this machine | BLOCKED | **BLOCKED locally** (G-BL-01) |
| **FFmpeg (transcode)** | **NOT configured** — no `NLO_FFMPEG_BIN` in `.env`, `where ffmpeg` finds nothing. By design this is non-fatal: transcode status `not_configured`, original artifact stays canonical | n/a (prod: set per `s52-deploy.md` when needed) | **ACCEPTED-ABSENT** (documented behavior) |
| **Artifact storage** | `data/jobs/` present; artifact storage/download tests green (Agent D); safe-name generation unit-tested | BLOCKED | **READY locally (CODE-VERIFIED + UNIT-VERIFIED)** |
| **Download API** | `GET /api/jobs/:id/artifacts/:artId` + audio download routes — integration-tested green; UI download links exist | BLOCKED | **READY locally (INTEGRATION-VERIFIED)** |
| **Webhook** | dispatcher integration-tested (exactly-once, HMAC, dead-letter); allowlist empty by default → **fail-closed** (no deliveries until `NLO_WEBHOOK_ALLOWLIST` configured) | BLOCKED | **READY for opt-in (INTEGRATION-VERIFIED); currently fail-closed** |
| **Job recovery** | boot `resetAll → recoverInFlight → queue.start` (Agent B §Q8); `settle-once.test.ts` + `worker-queue-recovery.test.ts` green; runbook `docs/operations/JOB_RECOVERY_RUNBOOK.md` exists | BLOCKED | **READY locally (UNIT/INTEGRATION-VERIFIED)** |
| **Monitoring** | `/api/health` (200, `ok:true`) + `/api/health/ready` (200, `ready:true` overall); production would add `journalctl -u nlo` + deploy-script journal check | BLOCKED (no service) | **BASIC-READY locally; no external alerting (no PM2/Prometheus/alertmanager in scope)** |

**Overall local live readiness: NOT READY** — the single blocking item is the python worker
spawn failure (G-BL-01). Everything else is in place. **Overall production readiness: BLOCKED** —
no instance exists on the new host (Agent E E-BL-01); readiness there is undefined until
re-deployment.

## 2. The one concrete local blocker (evidence, no guessing)

`GET http://127.0.0.1:4871/api/health/ready` (read-only probe, 2026-11-17 16:27 UTC):

```json
{
  "ok": true, "ready": true,
  "provider": {
    "name": "python-worker", "configured": false,
    "issues": ["worker start failed: python worker exited unexpectedly (code=3221225794, signal=none); stderr: "]
  },
  "proxyRuntime": { "state": "available", "name": "xray" },
  "liveDisabled": true
}
```

- `3221225794` = `0xC0000006` (STATUS_INVALID_HANDLE) — a Windows-native failure during worker
  process startup, most commonly a corrupt/incomplete venv or a missing native dependency.
- The server itself is healthy (`ok:true`, `ready:true` overall — the *provider* sub-check fails,
  which is exactly the honest fail-closed reporting the architecture promises).
- Note: `ready:true` overall while `provider.configured:false` is the correct semantics (service
  ready, live provider not available) — but it means **any live job right now on this workstation
  would fail at worker spawn**. Mock jobs are unaffected (mock provider needs no worker).
- **Fix candidate (for the owner, not executed here):** `data/venv` reinstall per
  `docs/deployment/s52-deploy.md` §first-time-setup step 3, or `npm run worker:setup`
  (Windows: recreate venv + `pip install -r apps/server/python-requirements.txt`).

## 3. Runbook A — one TEXT job (mock provider, local; executable today)

Prereq: `NLO_PROVIDER=mock` (dev server) or the same server with mock selection; port 4871.

1. **Health gate (read-only):** `curl http://127.0.0.1:4871/api/health` → expect `{"ok":true}`.
2. **Create (REST, no token needed in default mode):**
   `POST /api/notebooks/from-text` with `{"text":"…","summary":"…","title":"…"}` → expect
   `202 {"jobId":"j_…","statusUrl":"/api/v1/jobs/j_…"}`.
   (UI path: Create job page → text form → submit.)
3. **Poll:** `GET /api/jobs/j_…` every ~1 s until terminal (`SUCCEEDED` / `FAILED` /
   `NEEDS_ATTENTION`). Inspect `GET /api/jobs/j_…/events` and `/attempts` for the stage trail.
4. **Artifacts:** `GET /api/jobs/j_…/artifacts` → expect markdown/text artifact rows; download via
   `GET /api/jobs/j_…/artifacts/<artId>` (UI: Job details → download).
5. **Provenance check:** `resultProvenance` must be `"mock"` (never `"real"` in mock mode).
6. **Cancel variant (optional negative):** create a second job, `POST /api/jobs/<id>/cancel`
   mid-run → expect terminal `CANCELLED`, no artifacts.
7. **Record:** job id, status, artifact names, provenance, wall-clock. (This runbook is what a
   mock-level acceptance run documents; it is also the shape of the live variant in §4.)

## 4. Runbook B — one AUDIO job (live provider; **requires G-BL-01 fixed first**)

Prereqs: worker spawn fixed (§2), a **valid** Google session (`POST /api/sessions/<acc>/verify`
→ 200), ≥1 healthy enabled proxy node (`POST /api/proxies/<nid>/health` target `notebooklm` →
`ok:true`, egress IP recorded), `NLO_PROXY_RUNTIME=xray`, `NLO_ALLOW_DIRECT_EGRESS` unset (off).

1. **Health + readiness gate:** `/api/health` ok **and** `/api/health/ready` → `provider.configured:true`.
2. **Session gate:** verify the account's session (read-only-ish: verify does not consume a job).
   If `needsReauth`, stop — do not start the job (avoid an ambiguous in-flight job).
3. **Proxy gate:** health-check the preferred node; record egress IP as evidence.
4. **Create:** `POST /api/jobs` (multipart audio: `wav|mp3|m4a|ogg|flac`, ≤ 200 MB) or via UI
   Create job → audio upload. → `202 {"id":"j_…","status":"CREATED"}`.
5. **Poll:** `GET /api/jobs/j_…` → watch `QUEUED → RUNNING → (audio ops) → SUCCEEDED`; inspect
   `/events` (stage trail incl. `externalOperationId`s) and `/attempts` (node used per attempt).
   **Never retry an `ambiguous`/`UNKNOWN_EXTERNAL_STATE` job automatically** — park it
   (`NEEDS_ATTENTION`) and follow `docs/operations/JOB_RECOVERY_RUNBOOK.md` (settle-once: first
   engine action after recovery is a *poll* of the external op, not a re-submit).
6. **Artifacts:** podcast MP3 + SRT transcript rows; download each; if
   `NLO_FFMPEG_BIN` set, transcode status `succeeded`; otherwise `not_configured` (original
   artifact canonical — expected, not a failure).
7. **Provenance:** `resultProvenance` must be `"real"`; record it.
8. **Evidence record:** job id, session account id (not the cookie), proxy node id + egress IP,
   duration, artifact sizes/hashes, provenance. This satisfies the P4-8-style live-acceptance
   evidence requirement for one audio job.

## 5. Monitoring readiness (honest scope)

- In-service: `/api/health`, `/api/health/ready` (provider + proxyRuntime sub-checks), structured
  job events in DB, webhook outbox (opt-in), journal logging on the production host.
- **Not present:** external alerting (no Prometheus/Healthchecks/uptime pinger in repo), no log
  aggregation, no SLO dashboard. For a single-user operational service this is acceptable today;
  the deploy script's post-restart journal scan is the closest thing to a canary.
  **Status: BASIC (implemented) / external alerting NOT-IMPLEMENTED** (backlog G-BL-04, P3).

## 6. Findings summary (Agent G)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| G-BL-01 | **P1 (local blocker)** | python worker spawn fails on the workstation (`0xC0000006`) → live jobs impossible here until `data/venv` is repaired; mock path unaffected | §1, §2 |
| G-BL-02 | **P0 (ops, shared with E)** | no production instance on the new host → "live acceptance" is currently only possible on the workstation (once G-BL-01 fixed); production live acceptance waits on re-deploy | Agent E §1–3 |
| G-BL-03 | P2 | Session validity for the 3 stored Google sessions NOT re-verified this audit (no verify call); assume stale until checked before any live job | §1 |
| G-BL-04 | P3 | No external alerting/monitoring beyond in-service health endpoints + journal | §5 |
| G-BL-05 | INFO | FFmpeg absent locally → transcode `not_configured` (documented non-fatal); set `NLO_FFMPEG_BIN` for MP3 output | §1 |
| G-BL-06 | INFO | Both runbooks (§3 mock-text, §4 live-audio) are executable today/fixed-venv; no real job was run in this audit | §3–4 |

## 7. What this agent did NOT do

- No real job (text, audio, or podcast), no session verify/login, no proxy health-check POST,
  no worker fix, no venv change, no production probe beyond read-only HTTP/TCP.
