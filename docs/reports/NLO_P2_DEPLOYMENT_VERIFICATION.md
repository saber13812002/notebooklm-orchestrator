# NLO P1/P2 Deployment Verification

Mission: **NLO-ACCESS-REBASELINE-01** — companion report (Phase F).
Date: 2026-11-14. Read-only.

## 1. Principle

"Source file exists" ≠ "capability installed/running/configured". Every
capability is therefore proven at three levels: (a) present in the git tree,
(b) present in the running process, (c) enabled in runtime configuration.

## 2. SHA chain (VERIFIED against real git)

All 14 reference SHAs exist and are in order:

```
81e86a8 → 0c4047c → 6e09259 → 09b2b11 → 8446118 → b6dd4c9 → e01dbc8
→ 7be9c72 → 936aa34 → 5f04cb9 → 21d8090 → 6f3bd98 → d232e5e → 278273a
```

then docs-only `4e2d533` (current local + `origin/main` HEAD).

## 3. Per-environment comparison

| Item                                 | Local (Windows)                                                        | Production (172.30.0.133)                                             |
| ------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Git HEAD                             | `4e2d533` (docs)                                                       | `278273a`                                                             |
| Code actually served                 | `278273a` tree (processes started 11:12 / 11:22 UTC, before `4e2d533`) | `278273a`                                                             |
| Worker version                       | `nbl_worker.py` contains `generate_audio` (grep count 1)               | identical (count 1)                                                   |
| Webhook module                       | routes in live OpenAPI; migration 6 applied; 0 endpoints               | migration 6 applied 2026-11-14T11:40:01Z; tables present; 0 endpoints |
| E2E runner                           | `scripts/e2e-live.ts`, `scripts/verify-live.ts` present                | same tree                                                             |
| FFmpeg executable                    | **not installed**                                                      | **installed** (6.1.1, `/usr/bin/ffmpeg`)                              |
| FFmpeg configured (`NLO_FFMPEG_BIN`) | **absent** → `not_configured`                                          | **absent** → `not_configured`                                         |
| Node                                 | v24.14.0                                                               | v22.23.4                                                              |
| Python                               | 3.13.15                                                                | 3.12.3                                                                |
| notebooklm-py                        | 0.8.5                                                                  | 0.8.5                                                                 |
| DB location                          | `data/nlo.sqlite`                                                      | `/home/saber/.../data/nlo.sqlite`                                     |
| Artifact storage                     | `data/` (0 artifacts)                                                  | `data/` (0 artifacts)                                                 |

## 4. P2 capability proofs (VERIFIED)

- **Audio pipeline:** `generate_audio` present in the worker on both
  environments; audio-download routes present in the live OpenAPI spec.
- **Webhook outbox:** `/webhooks…` routes in the live spec (both
  environments); tables exist in both databases; 0 endpoints / 0 deliveries
  → installed and idle.
- **Artifact delivery:** `/artifacts/{artifactId}/download` route present;
  0 artifacts stored → the feature has never produced output (no audio job
  has ever run).
- **FFmpeg:** the one P2 dependency that is **not configured in either
  environment** (local: binary missing; server: binary present but env var
  absent).

## 5. Deployment evidence (2026-11-14, prior user-approved deploy mission)

- `bash deploy/deploy.sh origin/main` → **DEPLOY SUCCESS `278273a`**
  (previous good `8abf18a`); DB + `.env` backed up by the script; service
  restarted; health + ready green; `data/deployed-commit` = `278273a`.
- Post-deploy verification: all endpoint probes 200; migration 0006 applied
  at boot.

## 6. Conclusions

1. P1 + P2 code is **installed and running** in both environments
   (`278273a` in both).
2. P2 audio capability is **present but unexercised** (0 artifacts) and
   **unconfigured** (missing `NLO_FFMPEG_BIN` in both).
3. Webhooks are installed and idle.
4. No version drift between what local and production serve.
5. "Live audio accepted end-to-end" remains **NOT VERIFIED** — mock/E2E
   passed; no real audio job has ever completed in either environment.
