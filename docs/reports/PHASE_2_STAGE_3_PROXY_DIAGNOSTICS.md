# Phase 2 — Stage 3: Proxy Diagnostics & Stability (NLO-PHASE-2-AUDIO-LIVE-2026-11)

**Date:** 2026-11-06 (evidence window 21:21 UTC — fresh, post-restart)
**Result:** france1-SeyedSaber **healthy for short ops** (re-confirmed live
today); England_1 **failing** (`read ECONNRESET`). No node was added,
disabled, or re-prioritized. **Long-held-connection stability remains
UNPROVEN** — it can only be validated by the Stage 4 real audio job, which is
currently blocked on the expired Google session (Stage 2).

---

## 1. Node inventory (live `GET /api/proxies`, UUIDs masked by the API)

| Node               | id                      | enabled | priority | endpoint            | transport / security                                    | fingerprint |
| ------------------ | ----------------------- | ------- | -------- | ------------------- | ------------------------------------------------------- | ----------- |
| france1-SeyedSaber | `node_23e81d9a6ca04d10` | true    | 100      | `api3.av-up.ir:443` | ws / tls (sni `api3.av-up.ir`, wsPath `/`)              | `fp=chrome` |
| England_1          | `node_1e238ac8aed440cb` | true    | 100      | `eng1.av-up.ir:443` | ws / tls (sni `eng1.av-up.ir`, wsPath `/download/list`) | `fp=chrome` |

Runtime: xray (`GET /api/proxies/runtime` → `{"state":"available","name":"xray"}`).
No VLESS URIs or UUIDs were printed anywhere (API masks them;
`maskUuid` in `@nlo/shared`).

## 2. Controlled health tests — **exactly ONE per node** (mission 3.x)

Both checks were executed by NLO's own staged health path
(`ProxyManager.selectAuto` self-heal, `proxy-manager.ts:182-220`) during the
Stage 2 official verify at **21:21:25–21:21:31 UTC** — against the real
allowlisted target `notebooklm.google.com:443`, through real xray tunnels:

| Node               | Stage                                   | Evidence (persisted per-node)                                                                                                | Verdict                                                               |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| England_1          | staged check `2026-11-06T21:21:25.983Z` | `HTTPS via tunnel 127.0.0.1:52196 -> notebooklm.google.com:443 failed` — `read ECONNRESET` after ~4.1 s; category `upstream` | **FAIL** (node/upstream reset — matches historical `read ECONNRESET`) |
| france1-SeyedSaber | staged check `2026-11-06T21:21:30.800Z` | `HTTPS GET via tunnel 127.0.0.1:52212 -> notebooklm.google.com:443 succeeded in 771ms`; category `nbl_access`                | **PASS** (771 ms)                                                     |

Selection behaviour (observed): `selectAuto` rejected England_1 (last check
failed), selected **france1-SeyedSaber** for the auth op (tunnel
`127.0.0.1:52217`). **Bonus live proof:** the full verify round-trip
(worker → tunnel → real NotebookLM → signed-out page response → worker)
completed _through france1_ in ~30 s — i.e. a **multi-second held tunnel
connection** worked today, including a TLS session to Google.

Per mission courtesy rule: **no additional health tests were run**
(the one check per node above stands; a second round would have needed a
stated technical reason, which the current evidence does not warrant).

## 3. Timeout & lifecycle audit (code-verified)

| Parameter                      | Value                                                                                                                                                               | Location                                                                                                              | Fit for real NotebookLM ops?                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Staged health check (per node) | 15 s (`--max-time` / req timeout)                                                                                                                                   | `connect-proxy.ts:238`, `:109-111`, `:225-226`                                                                        | OK — short single-RPC check                                                                                     |
| Health freshness TTL           | 10 min, self-healing via real staged check                                                                                                                          | `proxy-manager.ts:50-51, 182-220`                                                                                     | OK — keeps selection honest without manual clicks                                                               |
| Verify op (session)            | worker op `timeoutSec=120`; TS request cap 300 s                                                                                                                    | `python-worker-provider.ts:257-259`; log `op=verify timeoutMs=300000`                                                 | OK — real verify took ~30 s                                                                                     |
| **Audio job op**               | **30 min hard cap** (`jobTimeoutMs` default)                                                                                                                        | `python-worker-provider.ts:432, 479-488` (`waitSec:1800`, `timeoutSec=jobTimeout/1000`)                               | Fits observed real durations (H1 text ≈28 s; historical audio attempts reached 15–17.5 min before tunnel death) |
| Worker request timeout error   | settled as `timeout` (ambiguous) → `NEEDS_ATTENTION`, never auto-retried                                                                                            | `worker.ts:230-257` (settle-once, Phase 1 fix); `worker-queue-recovery.test.ts`                                       | OK — ambiguous ops are quarantined, not blindly re-run                                                          |
| Tunnel lifetime                | xray tunnel lives while the worker request is in flight; env `HTTP(S)_PROXY` points the worker at it; tunnel stopped after staged health checks and on worker close | `python-worker-provider.ts:172-185` (`tunnelEnv`), `proxy-manager.ts:268-270` ("tunnel is always stopped afterwards") | **This is the long-hold surface** (see §4)                                                                      |
| Provider-internal retry        | notebooklm-py retries failed RPCs itself (`backing off 1.2s then retrying (1/3)`)                                                                                   | worker stderr, attempt #5 log                                                                                         | OK as long as the tunnel survives; **a dead tunnel makes the retry hang** (observed)                            |

## 4. Long-connection failure diagnosis (mission 3.x — one level deep)

History (P0 attempts #4/#5, `PHASE_P0_AUDIO_RECOVERY.md` §13-14): france1
holds short RPCs fine but **dies on the multi-minute audio pipeline**
(upload → transcribe → `GET_NOTEBOOK` polling): `RPC GET_NOTEBOOK
(TransportServerError) ConnectTimeout` / `RemoteProtocolError`, after which
the library's own retry (1/3) hangs with zero progress until the server's
30-min worker timeout.

Mechanism analysis:

1. The audio op keeps **one** VLESS-WS connection to `api3.av-up.ir` open for
   the entire op (minutes). Shared VLESS nodes commonly cap idle/long-held
   WS sessions server-side (idle timeout or total-connection lifetime);
   `RemoteProtocolError` + `ConnectTimeout` is the client-side signature of
   the upstream silently killing or resetting the held session.
2. When the held connection dies mid-op, notebooklm-py retries over the
   **same** broken tunnel (env proxy is fixed for the worker's lifetime), so
   every retry attempt hits the dead route → apparent "hang".
3. England_1 fails at the _short_ stage today (`ECONNRESET` in 4 s) — the
   node/upstream itself is currently down, so it cannot carry audio either.

**Configured timeouts fit the real operation durations** (30-min job cap vs
15–17.5-min historical audio ops); the failure mode is **long-hold stability
of the shared france1 tunnel**, not a timeout being too small.

**Implication for Stage 4:**

- france1 is the only usable route today; the audio job must run through it.
- The P0 runbook applies: submit ONE job, monitor every ~20 s, early-stop at
  ~15 min via `POST /api/jobs/{id}/cancel` if the tunnel shows the same
  `GET_NOTEBOOK` failure pattern (clean stop before the 30-min timeout; no
  blind re-run), and check DB/NotebookLM state before any re-attempt.
- If the same long-hold failure reproduces, the correct escalation is a
  **new/better VLESS** with a higher long-connection tolerance
  (spec: supports multi-minute held WS sessions to `notebooklm.google.com:443`,
  stable TLS, low jitter; no secrets). That decision belongs to the user
  (stop-condition "new VLESS needed").

## 5. Proxy selection audit (mission 3.x)

- Priority: both nodes 100 (tie); preferred flag false on both.
- Health-based rejection works: England_1 was rejected with the persisted
  reason; france1 selected. Rejection reasons are persisted and visible in
  the API (`health.error`, `evidence`).
- Fail-closed egress enforced (`acquireAuthTunnel`, `python-worker-provider.ts:126-170`): with any node configured, direct egress is impossible.
- No disable/delete/priority changes performed (user-approval-gated).

## 6. PASS/FAIL — Stage 3

| #   | Criterion                                                                                                     | Result                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | No assumptions carried; fresh per-node check via NLO's own API                                                | **DONE** (21:21 UTC, one per node)                                                                    |
| 2   | Enabled / priority / availability / tunnel startup / TCP / TLS / HTTPS GET / latency / failure class recorded | **DONE** (§1, §2)                                                                                     |
| 3   | Long-connection failure diagnosed (timeouts, reuse, xray lifecycle, retry policy, ambiguous-op handling)      | **DONE** (§3, §4) — root: shared-node long-hold WS instability, not our timeouts                      |
| 4   | Proxy selection / failover / rejection reasons audited                                                        | **DONE** (§5)                                                                                         |
| 5   | No node disabled/deleted/re-prioritized without approval                                                      | **DONE** (zero mutations)                                                                             |
| 6   | No UUIDs / VLESS URIs printed                                                                                 | **DONE**                                                                                              |
| 7   | "Simple GET success ≠ healthy" acknowledged                                                                   | **DONE** — france1's short-GET pass does NOT certify the multi-minute audio hold; honest status below |

**Node status matrix (fresh, 2026-11-06 21:21 UTC):**

| Node               | Short op (≤30 s held)                               | Long op (multi-minute held)            | Actionable for audio job?                            |
| ------------------ | --------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| france1-SeyedSaber | **OK** (771 ms + 30 s live verify round-trip today) | **UNPROVEN** (3/3 historical failures) | **Yes — primary route** (with P0 runbook early-stop) |
| England_1          | **FAIL** (ECONNRESET 4.1 s)                         | not testable (already fails short)     | **No**                                               |

**Next:** Stage 4 is **BLOCKED** on the Stage 2 user action (expired Google
session). Once re-authenticated, the single real audio job proceeds via
france1 with the documented runbook.
