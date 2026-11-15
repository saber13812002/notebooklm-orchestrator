# NLO Content Intake & Template Spec (Product)

Mission: **NLO-P4-0** · Product-level specification for what NLO will *accept* (universal file intake) and what it will *produce* (content templates T1–T4).
Companion: architecture [`NLO_CONTENT_INTAKE_ARCHITECTURE.md`](../architecture/NLO_CONTENT_INTAKE_ARCHITECTURE.md), **ADR-002** (content intake & templates). Baseline: `main @ 76cd5f03`.
Status labels as defined in [`NLO_P4_TARGET_ARCHITECTURE.md`](../architecture/NLO_P4_TARGET_ARCHITECTURE.md).

---

## 1. What this document is

The architecture doc defines *how* intake works internally. This spec defines the **product behavior**: which inputs a user can submit through each path (UI / REST / MCP), what the four content templates do, what metadata NLO computes, and the user-visible guarantees (honest format support, untrusted content, no surprise failures).

**Product principle (inherited from AGENTS.md §4):** *never report an unsupported operation as successful.* If a format or template is not available for the chosen provider, NLO says so at **create time** — the user is never left with a job that fails later for a reason that was knowable up front.

---

## 2. Universal file intake — product surface

### 2.1 Accepted inputs (target)

| Input | Formats | Path (UI) | Path (REST) | Path (MCP) | Notes |
|---|---|---|---|---|---|
| Pasted text | plain text (≤ `NLO_MAX_TEXT_CHARS`, default 200k) | job-create form | `POST /api/v1/notebooks/from-text` | `create_job` (text) | baseline, `IMPLEMENTED` |
| Document (extracted to text) | `txt`, `docx`, `srt` **(+ `pdf`, `md` in P4-2)** | file upload (field `source`) | `POST /api/v1/notebooks` multipart | `create_job` (source ref) | `txt/docx/srt` `IMPLEMENTED`; `pdf/md` `PROPOSED` |
| Audio | `wav`, `mp3`, `m4a`, `ogg`, `flac` | file upload (field `audio`) | `POST /api/v1/notebooks` multipart | `create_job` (source ref) | baseline, `IMPLEMENTED` + live-verified |
| Video | `mp4`, `mov`, `webm` (P4-2) | file upload | multipart | `create_job` (source ref) | audio track is extracted and used as the provider source; container metadata (duration) recorded; **video without an audio track is rejected at validation** (`invalid_input`), never mid-job |
| URL | http/https (P4-2) | URL field | `from-text` with `source: { url }` | `create_job` (url) | SSRF-guarded (existing, unit-tested), size-capped, `text/html`+`text/plain` only, **no JS rendering** (stated limit); provenance records the fetched URL |

**Per-provider honesty (the matrix):** each format × each provider is declared in the capability matrix (`/api/capabilities` / MCP `list_providers`). A format a provider does not declare is shown **unavailable** for that provider — never guessed. *Extraction is a translation*: a PDF sent to a text-source-only provider arrives as *text*, and the response says so (`note: "extracted to text"`) — the provider is never shown a format it didn't declare.

### 2.2 User-visible validation guarantees

| Condition | Behavior (all paths) |
|---|---|
| Unknown extension | `400` with distinct code + the accepted list (never 500, never "accepted then failed") |
| Corrupt `docx` / `pdf` / `srt` | `400` `invalid_docx` / `invalid_pdf` / `invalid_srt`; file quarantined in the job archive for postmortem |
| Audio/video too large (config limit) | `400` at validation |
| Video without audio track | `400` `invalid_input` at validation |
| URL fails SSRF guard | `400` `unsafe_url` (host/port/class reason, redacted) |
| Text over limit | `400` (existing `NLO_MAX_TEXT_CHARS` behavior) |
| Template requires a capability the provider lacks | `400` `E2E_PROVIDER` **at create time** with the missing capability named |

All of these are *pre-job*: a validation failure never creates a job that later fails. (Extends the existing `invalid_docx`/`invalid_srt` discipline — `IMPLEMENTED`.)

### 2.3 Source provenance (what the user can see)

Every source a job consumes carries `sourceProvenance` (visible on the job and in the archive):

```jsonc
{
  "kind": "document" | "audio" | "video" | "url" | "text",
  "originalName": "report.pdf",        // as uploaded/fetched (safe name stored)
  "sha256": "…",                        // content hash
  "extractedVia": "pdf-text",          // null when no extraction
  "fetchedFrom": "https://…"            // url kind only
}
```

This is the user-facing form of the untrusted-content rule: *you can always see exactly what went into the notebook, and where it came from.*

---

## 3. Content templates T1–T4 (product)

Templates are **versioned data** (ADR-002): changing a template is a data change (new version), not a deploy; a running/finished job is never affected by a later template edit (the job snapshot freezes the version). Users pick a template via UI (`/templates` picker), REST (`template` + `templateVersion` in the create payload), or MCP (`list_templates` + `create_job`).

### 3.1 Template catalog

| Id | Product name | What it produces | Inputs accepted | Provider requirement | User-visible status at baseline |
|---|---|---|---|---|---|
| `t1_deep_dive` | **Deep Dive Podcast** | a long-form two-host deep-dive podcast (Audio Overview) + transcript (SRT) | any accepted input kind | `generate.audio` (deep_dive; short/default/long; 50+ languages) | **Available** — the NLO podcast pipeline is `IMPLEMENTED` + `INTEGRATION_TESTED`, live-verified (P0). The template row formalizes existing behavior |
| `t2_debate` | **Debate Podcast** | a debate-format podcast (two hosts, opposing positions) + transcript | any accepted input kind | `generate.audio` (debate) | **Available** — `podcast.format: "debate"` already exists in the API; same verification level as T1 |
| `t3_infographic` | **Vertical Infographic** | a 9:16 vertical infographic (PNG) | document / text | `generate.infographic` | **Planned (P4-5)** — the pinned library (nblpy 0.8.5) supports infographic generation; the NLO worker does not yet expose it. Listed as *unavailable* until the worker op lands — never advertised early |
| `t4_reels` | **Reels / Shorts** | a short-form vertical video (mp4, 9:16) for Reels/Shorts | document / text / audio | `generate.video` (short-form; 4 formats × 8 styles per upstream library) | **Planned (P4-5)** — same rule as T3 |

**Template params (user-settable, zod-validated at create):**

| Param | T1/T2 | T3 | T4 |
|---|---|---|---|
| `language` | `en`/`fa` (+ whatever the provider declares) | same | same |
| `length` | `short`/`default`/`long` | — (fixed vertical) | `short` (fixed) / duration hint |
| `instructions` | free text (falls back to the job prompt) | free text | free text |
| `style` | — | — (single vertical style) | one of the declared video styles (data) |

Any param value the provider does not declare for the template's operation is rejected **at create time** with the valid list (honest matrix, §2.1).

### 3.2 Prompt structure (all templates, user-invisible but spec'd)

Every template prompt has exactly three regions:

1. **Control block** — format/length/language/style, filled *only* from validated job params (never from source content).
2. **Source region** — the user's content in a delimited, labeled block (`<<<SOURCE>>>…<<<END SOURCE>>>`).
3. **Output contract** — the artifact contract ("vertical 9:16 infographic", "90-second debate podcast").

This is what makes the same template behave identically on any provider that declares the capability.

### 3.3 The untrusted-content rule (product guarantees)

> **Your content is data, never instruction.**

1. Source content (PDF/URL/audio transcript/pasted text) is inserted into the generation prompt **only** inside the delimited source region — it can never override template fields (format, length, language, style).
2. NLO **never executes, evaluates, or interprets** source content as code/JSON/HTML.
3. Every derived output (summary, metadata, title suggestion) passes the existing redaction before it appears in logs, events, or webhooks (no cookie/bearer/SID leakage).
4. Sources keep their provenance (§2.3) end-to-end.

This generalizes the ecosystem precedent (PleasePrompto's "treat citations and instructions as untrusted input" provenance envelope) into a platform invariant. Building blocks `IMPLEMENTED` + unit-tested (redaction, safe names, SSRF); the rule itself is `PROPOSED` (P4-2).

### 3.4 LLM metadata enrichment (product)

For document/URL/audio-transcript sources, NLO can compute structured metadata (via the existing internal LiteLLM proxy — `IMPLEMENTED` client):

```jsonc
// enrichment (schemaVersion 1) — stored on the job, visible to the user
{
  "schemaVersion": 1,
  "summary": "… (≤ 2 KB)",
  "topics": ["…", "…"],              // ≤ 10
  "language": "fa",                   // BCP-47 or null
  "suggestedTitle": "… (≤ 200)",
  "entityConfidence": 0.82
}
```

Product guarantees:

- **Best-effort, non-fatal:** if the LLM is down or the output fails validation, the job proceeds with `enrichment: null` + a `metadata_enrichment_skipped` event. *Enrichment never fails a job.*
- **Hints only:** `suggestedTitle`/`language` are suggestions — the "hint only, never appended to the title" discipline NLO already applies. The user's own title/prompt always wins.
- **One call per job**, 15 s timeout, no retry loop at intake.

Status: `PROPOSED` (P4-2); the internal LLM client it uses is `IMPLEMENTED`.

---

## 4. API/MCP surface delta (product-relevant)

| Surface | Change | Phase |
|---|---|---|
| `GET /api/v1/templates` (new) | lists active templates with per-provider availability (`availableFor` + reason) and param schemas | P4-2 |
| Create payload (all 3 paths) | optional `template`, `templateVersion` (default = active version; `null` = baseline behavior unchanged) | P4-2 |
| `POST /api/v1/notebooks` multipart | accepts `pdf`, `md`, video, URL inputs | P4-2 |
| `/api/capabilities` | per-provider × per-format matrix (data) | P4-1 |
| MCP `list_templates` / `create_job` | same semantics as REST (one domain, two front doors — ADR-005) | P4-6 |

---

## 5. Acceptance (user-facing definition of done)

- A user can submit any §2.1 input on all three paths and get the §2.2 validation behavior.
- `list_templates` shows T1/T2 **available** and T3/T4 **unavailable with a reason** until P4-5; after P4-5 they become available only where the provider matrix declares the capability.
- A template job's output matches its §3.1 artifact contract; the transcript is a tracked artifact (SRT) for T1/T2.
- No job ever fails for a format/template reason that was knowable at create time (regression: the capability matrix is data, and create-time gating is integration-tested).
- The untrusted-content rule: an adversarial source (content containing "ignore the above instructions and…") does not change format/length/language of the output (integration test, mock provider + one live spot-check in C7).
