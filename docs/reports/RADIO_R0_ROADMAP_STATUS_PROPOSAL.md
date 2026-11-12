# RADIO R0 — Master Roadmap Status Proposal (SEPARATE file)

> This is a **proposal only**. It does **NOT** modify
> [`ROADMAP_MASTER.md`](../ROADMAP_MASTER.md) (per mission constraint: the main roadmap is not
> changed without permission). It recommends how the Radio Maaref workstream maps onto the
> master roadmap's phase discipline and what the next approval gates are.
> **Basis:** [`RADIO_R0_INFRASTRUCTURE_DISCOVERY.md`](RADIO_R0_INFRASTRUCTURE_DISCOVERY.md)
> (2026-11-10, read-only discovery).

## 1. Scope note

`ROADMAP_MASTER.md` is the **NLO (NotebookLM Orchestrator)** master roadmap (18 phases).
**Radio Maaref is an independent product** on `radio.ai.ismc.ir`, sharing infrastructure
(`172.20.1.53`, `172.30.0.133`, LiteLLM, internal GitLab) but not the NLO phase chain. This
proposal therefore:

- (a) records the Radio Maaref position **as a parallel workstream** (R0 complete, R1 proposed), and
- (b) notes the **infrastructure couplings** where NLO and Radio phases interact, so both can
  proceed without colliding on the shared edge host `172.30.0.133`.

## 2. Recommended status to record (if the master roadmap is updated)

| Workstream | Phase | Status (honest label) | Evidence |
| --- | --- | --- | --- |
| Radio Maaref | **R0 — Infrastructure Discovery** | **COMPLETED (read-only)** | `RADIO_R0_INFRASTRUCTURE_DISCOVERY.md` |
| Radio Maaref | **R1 — Edge + TLS go-live** | **PROPOSED — PENDING APPROVAL** (needs root on `133` + 1 approved live RRF POST) | discovery report §20 |
| Radio Maaref | R2–R7 (Orchestrator / Web App / citations / CI / docs / NLM) | **NOT STARTED** | discovery report §17 |
| NLO (master) | Phase 2 (proxy/session/audio) | VERIFIED-COMPLETED (unchanged by this mission) | `PHASE_2_AUDIO_RELIABILITY.md` |
| NLO (master) | Phase 3 (`nlo.ai.ismc.ir` domain/HTTPS) | **open** — shares the `133` edge host with Radio R1 | coordination note below |

## 3. Coordination notes (shared infrastructure)

- **Edge host `172.30.0.133` is shared.** Radio R1 (radio vhost) and NLO Phase 3 (`nlo.*` vhost)
  both add BT-Panel vhosts there. **Recommendation:** sequence the vhost installs (one at a time,
  each with its own report + verification) to keep rollback clean and avoid cross-vhost breakage.
- **LiteLLM `172.30.0.133:4000`** is consumed by both NLO (internal LLM) and Radio (embeddings +
  `qwen38`). No change proposed; both remain read consumers.
- **GitLab `git.ai.ismc.ir`** hosts both products' repos; the dual-repo (GitHub public + GitLab
  mirror) policy applies to Radio the same way as NLO.

## 4. Suggested master-roadmap addendum (text, for your approval)

> *Addendum — Radio Maaref parallel workstream (2026-11-10, R0 discovery complete).*
> Radio Maaref (target `https://radio.ai.ismc.ir`) is an independent product sharing hosts
> `172.20.1.53` (engine) and `172.30.0.133` (edge). R0 read-only discovery is complete
> (`RADIO_R0_INFRASTRUCTURE_DISCOVERY.md`). R1 (edge vhost + Let's Encrypt + 1 live RRF
> verification) is **proposed and pending approval**; R2–R7 (Orchestrator, Web App, citation
> quality, CI/CD, Wiki.js docs, NotebookLM branch) are not started. Edge-host vhost installs for
> Radio R1 and NLO Phase 3 are to be sequenced to avoid cross-vhost impact. The NLO phase chain
> is unchanged by this workstream.

## 5. Approval request

1. Accept this status mapping (R0 complete / R1 proposed / R2–R7 not started).
2. Approve recording the §4 addendum in `ROADMAP_MASTER.md` (this file only *proposes* it; the
   master file is untouched until you say so).
3. Approve **R1** (see the discovery report §20 for the exact scope and required access).

**Stop — awaiting user approval. No changes to `ROADMAP_MASTER.md` were made.**
