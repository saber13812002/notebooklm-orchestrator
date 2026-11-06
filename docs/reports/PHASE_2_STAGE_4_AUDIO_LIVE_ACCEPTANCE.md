# Phase 2 — Stage 4: Real Audio Live Acceptance (NLO-PHASE-2-AUDIO-LIVE-2026-11)

**Date:** 2026-11-06 (evidence window 23:12–23:18 UTC)
**Result:** **PASS — LIVE AUDIO VERIFIED.** Exactly ONE real audio job
(`j_367ea5baa8382e2ec42d7a29dcfe5b3b`) ran end-to-end against the **real
NotebookLM service** through the france1 VLESS tunnel: uploaded a Persian MP3,
created a real NotebookLM notebook + audio source, produced a real verbatim
Persian transcript. `simulated:false`, `provenance:"real"`, non-empty answer,
persisted in DB, visible in the UI data feed. No mock anywhere in this path.

---

## 1. Preconditions (all verified immediately before submission)

| Precondition                                                   | Evidence                                                                              | Time (UTC)                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------- |
| Local server healthy, worker spawns clean (Phase 1)            | PID 46924; settle-once cycles observed                                                | 21:00–21:10                 |
| Session re-authenticated via browser-import (Stage 2 §6)       | `POST /api/sessions/…/browser-import` → 200; `sess_8f079d7e3ebe4abc` AUTHENTICATED    | 23:06–23:07                 |
| Official re-verify against real service (Stage 2 §6.3)         | `POST …/verify` → `ok:true, "verified against service (453 notebooks)"`               | 23:07:51                    |
| `sessionUsable:true` (10-min TTL, `auth-sessions.repo.ts:131`) | `GET /api/sessions` → `sessionUsable:true`, `lastVerifiedAt 2026-11-06T23:07:51.195Z` | 23:08                       |
| Proxy node france1 healthy (Stage 3)                           | staged check PASS 771 ms; England_1 FAIL `read ECONNRESET`                            | 23:06:36 (fresh within TTL) |
| Audio file selected (user-chosen)                              | iranseda `sample_90s.mp3` (see §2)                                                    | 23:12                       |

Session `lastVerifiedAt` (23:07:51) was **9 min before** job submission
(23:15:22) — inside the 10-min eligibility TTL, so the job passed
`selectAccount()` on the first attempt.

## 2. Audio file (recorded facts — content never printed/committed)

| Field       | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path        | `C:\Users\s.tabatabaei\Documents\saberprojects\iranseda-corpus-wt\downloads\asr\roshan\3\sample_90s.mp3` (user's chosen candidate; outside the repo — **never git-added**) |
| Name        | `sample_90s.mp3`                                                                                                                                                           |
| Size        | **720,429 B**                                                                                                                                                              |
| MIME        | `audio/mpeg` (set on the multipart part; server echoes it in `input_json`)                                                                                                 |
| Duration    | 90 s (per corpus filename; **not independently measured** — no ffmpeg locally; the real service ingested it as audio)                                                      |
| **SHA-256** | **`85de5f0a24c5219112e13e382de646795fb716e1b22891dfe73becd77620748a`** (measured pre-submission with `Get-FileHash`)                                                       |
| Last write  | 2026-11-04T04:57:25Z                                                                                                                                                       |

Integrity: the server-persisted `input_json.audio.sha256` in the DB row is
**byte-identical** to the pre-submission measurement — the uploaded file is
exactly the file measured.

Note (honest): duration 90 s exceeds the mission-preferred 10–30 s; the user
explicitly selected this candidate as the shortest available.

## 3. Submission (exactly ONE job, API/UI path — no provider shortcuts)

- `POST /api/jobs` (multipart, the same contract the Web UI uses; fields
  `prompt`, `title`, `audio`, `preferredAccountId`):
  - `prompt`: "Transcribe this Persian speech audio into full verbatim text."
  - `title`: "Phase 2 audio live acceptance (single real job)"
  - `audio`: the file above (part name `sample_90s.mp3`, `audio/mpeg`)
  - `preferredAccountId`: `acc_315776aeb5b74e33` (strictly honored —
    no fallback account exists anyway)
- **Response: HTTP 201 in 0.2 s → `{"id":"j_367ea5baa8382e2ec42d7a29dcfe5b3b","status":"CREATED"}`** (23:15:22 UTC)
- **No second submission was made.** (Mission rule: no blind re-run.)

## 4. Execution trace (job events, `GET /api/jobs/{id}/events`)

| #       | at (UTC)                      | type                     | detail                                                                                                                                                                   |
| ------- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| evt_99  | 23:15:22.814                  | created                  | job created and queued                                                                                                                                                   |
| evt_100 | 23:15:22.841                  | validate                 | validating input                                                                                                                                                         |
| evt_101 | 23:15:22.848                  | account_selected         | `acc_315776aeb5b74e33` (label "صابر")                                                                                                                                    |
| evt_102 | 23:15:22.851                  | proxy_selected           | **france1-SeyedSaber `node_23e81d9a6ca04d10`**, tunnel `127.0.0.1:60890`, "enabled + config valid + healthy check fresh (2026-11-06T23:06:36.971Z) + tunnel established" |
| evt_103 | 23:15:22.854                  | proxy_candidate_rejected | `node_1e238ac8aed440cb` (England_1): "last check failed: read ECONNRESET" — consistent with Stage 3                                                                      |
| evt_104 | 23:15:22.857                  | running                  | attempt 1                                                                                                                                                                |
| evt_105 | 23:15:13.045→**23:16:13.045** | **succeeded**            | job completed                                                                                                                                                            |

**Total wall time: 50.2 s** (created 23:15:22.803Z → finished 23:16:13.040Z).
The P0 long-hold failure mode did **not** reproduce for this ~50 s hold.

### Worker log trail (`tmp\dev4871-phase2.log`, correlation `job:j_367ea…5b3b`)

```
[nlo:queue] queue: starting job j_367ea5baa8382e2ec42d7a29dcfe5b3b
[nlo:proxy] selected node france1-SeyedSaber (node_23e81d9a6ca04d10); tunnel at 127.0.0.1:60890
[nlo:worker job:j_367ea…] spawn pid=18544 python=…/data/venv/Scripts/python.exe
[nlo:worker job:j_367ea…] request sent id=1 op=ping timeoutMs=20000
[nlo:worker job:j_367ea…] response ok id=1 op=ping
[nlo:worker job:j_367ea…] request sent id=2 op=job timeoutMs=1800000
[nlo:worker job:j_367ea…] response ok id=2 op=job
[nlo:worker job:j_367ea…] close: requesting shutdown pid=18544
[nlo:worker job:j_367ea…] exit pid=18544 code=null signal=SIGTERM pending=0 …
[nlo:worker job:j_367ea…] cleanup: child pipes closed (pending=0)
```

Settle-once contract (commit `87f964b`) held: single `op=job` round-trip,
no duplicate settle, clean SIGTERM, zero pending.

## 5. Result & provenance (DB = source of truth)

`GET /api/jobs/{id}/result`:

```json
{"jobId":"j_367ea5baa8382e2ec42d7a29dcfe5b3b","status":"SUCCEEDED",
 "notebook":{"id":"19f65354-8641-446e-8987-84da22187a9c",
   "title":"Phase 2 audio live acceptance (single real job)"},
 "source":{"id":"97c79146-a8a6-4739-a317-3cf0391eca2b"},
 "summary":{"text":"Here is the full verbatim transcript of the audio
   recording **audio-sample_90s.mp3**: …(Persian transcript)…**"},
 "provenance":"real"}
```

DB row (`jobs`, read-only query):

| Column                   | Value                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                 | **SUCCEEDED** (progress 100, "operation completed")                                                                                                                                                                                                         |
| `account_id` / `node_id` | `acc_315776aeb5b74e33` / `node_23e81d9a6ca04d10`                                                                                                                                                                                                            |
| `notebook_id` / `title`  | `19f65354-8641-446e-8987-84da22187a9c` / "Phase 2 audio live acceptance (single real job)"                                                                                                                                                                  |
| `source_id`              | `97c79146-a8a6-4739-a317-3cf0391eca2b`                                                                                                                                                                                                                      |
| `conversation_id`        | `0facdc26-077e-47fe-8525-7aba84771308`                                                                                                                                                                                                                      |
| `result_provenance`      | **"real"**                                                                                                                                                                                                                                                  |
| `answer_markdown`        | non-empty, **correct UTF-8 Persian transcript** (begins «داشتند اونطوری که حضرت امیر می‌خواست …», contains real quote marks, diacritics-free colloquial Persian, and a `[1]` source reference marker — characteristic of the real provider, not a template) |
| `input_json.audio`       | `originalName:"sample_90s.mp3"`, `mediaType:"audio/mpeg"`, `size:720429`, `sha256:85de5f0a…` (matches §2), `providerConfirmed:false` (MP3 is not in the provider's verified list — see §7)                                                                  |

`result_provider_meta_json` (authoritative, from the worker):

```json
{
  "simulated": false,
  "provider": "python-worker",
  "email": "saber.tabatabaee@gmail.com",
  "sourceKind": "audio",
  "notebookId": "19f65354-8641-446e-8987-84da22187a9c",
  "notebookTitle": "Phase 2 audio live acceptance (single real job)",
  "sourceId": "97c79146-a8a6-4739-a317-3cf0391eca2b",
  "uploaded": true,
  "conversationId": "0facdc26-077e-47fe-8525-7aba84771308",
  "turnNumber": 1,
  "references": [{ "sourceId": "97c79146-a8a6-4739-a317-3cf0391eca2b", "quote": null }],
  "checkedAt": "2026-11-06T23:16:12.980217+00:00",
  "route": { "nodeId": "node_23e81d9a6ca04d10", "host": "127.0.0.1", "port": 60890 }
}
```

`GET /api/jobs/{id}/attempts`:

```json
[
  {
    "attempt": 1,
    "accountId": "acc_315776aeb5b74e33",
    "nodeId": "node_23e81d9a6ca04d10",
    "startedAt": "2026-11-06T23:15:22.859Z",
    "endedAt": "2026-11-06T23:16:13.038Z",
    "outcome": "ok",
    "detail": { "provider": "python-worker" }
  }
]
```

## 6. UI visibility

`GET /api/jobs?limit=3` (the exact data feed the React Web UI renders)
returns the job first: `j_367ea5baa8382e2ec42d7a29dcfe5b3b | SUCCEEDED |
Phase 2 audio live acceptance (single real job) | 2026-11-06T23:16:13.040Z`.
The job and its result are therefore visible in the Web UI (Jobs page +
detail/result view). No UI change was needed.

## 7. Honest caveats & observations

1. **MP3 is not in the provider's verified extension list**
   (`providerConfirmed:false`; code notes only `.wav` is provider-verified).
   The real service **accepted and processed the MP3 anyway** (this run is
   the live evidence). The capability matrix should not claim MP3 as
   "provider-verified" until a second confirmation; the verified label
   stays `.wav`, with MP3 noted as "live-observed working".
2. **Console encoding artifact:** the transcript renders as `?` when the
   API response is echoed through a legacy PowerShell 5.1 console (ANSI
   codepage). The **stored data is correct UTF-8 Persian** (verified by
   direct DB read, §5). This is a terminal display issue, not a data issue.
3. **P0 long-hold failure not re-tested:** this job held the tunnel ~50 s and
   succeeded. The P0 failure (15–17 min holds killed by the shared node) is
   a longer-hold scenario; it was not reproduced and is not claimed fixed —
   it simply did not occur. The 30-min job timeout still applies.
4. **`operation_ids_json` is `{}`** (no extra operation IDs reported by the
   provider this run) — the three canonical IDs (notebook/source/
   conversation) are all present in dedicated columns.
5. **`GET /api/jobs/{id}/artifacts` returns `[]`** — an audio-transcription
   job yields the answer text, not downloadable artifacts; nothing was
   fabricated to populate the list.
6. **England_1 (`node_1e238ac8aed440cb`)** was rejected by the selector
   (last check failed, `read ECONRESET`) and **no node was mutated**.
7. **The user's Chrome was force-killed** (Stage 2 §6.1) to release the
   cookie-DB lock; the morning tab session was not restored. The imported
   session file is intact and verified.

## 8. PASS/FAIL — Stage 4 (mission acceptance criteria)

| #   | Criterion                                                                                                                            | Result                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1   | Persian audio file chosen from project files first (none found) → user asked and selected                                            | **PASS** (user pick, §2; project checked first)              |
| 2   | File facts recorded (name/MIME/size/duration/SHA-256), never committed                                                               | **PASS** (§2; outside repo, git status clean)                |
| 3   | Upload path traced (multipart `POST /api/jobs` → server-side temp → safe name → archive → worker → provider)                         | **PASS** (code + live log)                                   |
| 4   | Root cause of `no eligible google account…` resolved (Stage 2 §3): server-side eligibility gate; satisfied by fresh verified session | **PASS** — job selected the account in 3 ms, no auth failure |
| 5   | Read real OpenAPI before requesting (Stage 1 §4: `POST /api/jobs` multipart contract)                                                | **PASS**                                                     |
| 6   | Execution order honored: account→session→proxy→worker→upload→job→poll→events→attempts→provider→IDs→answer→provenance                 | **PASS** (§4/§5)                                             |
| 7   | **Exactly ONE real test job** (UI/API path, no blind re-run)                                                                         | **PASS** — one 201, one success                              |
| 8   | Job SUCCEEDED                                                                                                                        | **PASS** (50.2 s)                                            |
| 9   | `simulated:false`                                                                                                                    | **PASS** (`result_provider_meta_json`)                       |
| 10  | `provenance:"real"`                                                                                                                  | **PASS** (`result_provenance` + `/result`)                   |
| 11  | Real NotebookLM operation IDs (notebook/source/conversation)                                                                         | **PASS** (§5)                                                |
| 12  | Non-empty, real Persian answer (audio→text)                                                                                          | **PASS** (verbatim Persian transcript, DB-verified UTF-8)    |
| 13  | DB persistence (status, IDs, answer, meta)                                                                                           | **PASS** (§5)                                                |
| 14  | UI-visible result                                                                                                                    | **PASS** (§6, same feed the UI renders)                      |
| 15  | No secrets/cookies/tokens/UUIDs (VLESS) printed; only service-side NotebookLM IDs (intended evidence)                                | **PASS**                                                     |
| 16  | No ambiguous timeout; no duplicate-notebook risk (single attempt, one notebook)                                                      | **PASS**                                                     |

**Stage 4 result: PASS — LIVE AUDIO VERIFIED.**

## 9. Next

Phase 5 (regression suites — `npm test` / `typecheck` / `lint` /
`format:check` / `build`) is expected to be green since **no code changed in
Stage 4** (operational actions only). Phase 6 then produces the consolidated
`PHASE_2_AUDIO_LIVE_ACCEPTANCE.md`, doc/changelog/README updates, separate
secret-scanned commits, FF push to GitHub, and the GitLab status check.
