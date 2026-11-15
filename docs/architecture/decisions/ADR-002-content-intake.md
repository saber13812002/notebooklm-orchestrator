# ADR-002: Content Intake as a Bounded Context (formats, untrusted content, templates as data)

**Status:** `PROPOSED` (NLO-P4-0) · **Date:** 2026-11-15 · **Baseline:** `main @ 76cd5f03`
**Companion:** [`NLO_CONTENT_INTAKE_ARCHITECTURE.md`](../NLO_CONTENT_INTAKE_ARCHITECTURE.md), product spec [`NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md`](../../product/NLO_CONTENT_INTAKE_AND_TEMPLATE_SPEC.md)

## Context

NLO already accepts `text`, `txt`/`docx`/`srt` (extracted to text), and `wav`/`mp3`/`m4a`/`ogg`/`flac` (audio), and it already applies the **honest matrix** rule — `buildInputMatrix()` reports a format the provider does not declare as `unavailable`, *never guessed* ([`buildInputMatrix`](../../../../packages/shared/src/input-capabilities.ts:49)). The mission generalizes this to **universal intake** (PDF, Markdown, video, URL, pasted text) across **multiple providers**, and introduces **content templates T1–T4** and **LLM metadata enrichment**.

The open questions: (a) how do we add formats without per-format code branches; (b) how do we keep user-supplied content from being treated as instruction (a real injection class once content flows into prompts); (c) how do we make T1–T4 configurable product behavior rather than in-code constants.

## Decision

1. **Content Intake is a bounded context** (see ADR-001) that produces a validated `JobInput` (+ template resolution) and hands off to Job Orchestration. It **never mutates job state**; admission errors are `400`-class, never a job that later fails.
2. **Formats are config + capability data, not code.** The extension whitelist stays config-driven (`NLO_ALLOWED_*_EXTENSIONS`); the per-provider matrix is *data* served via `/api/capabilities`. Extraction is a **translation** (PDF→text does not make a provider "support PDF" — the matrix says `level = <provider text-source level>, note: "extracted to text"`).
3. **Untrusted-content rule (context-wide invariant):** all source content (PDF/URL/audio-transcript/pasted) is **data, never instruction**. Content enters prompts only through the template's controlled interpolation inside a delimited, labeled region (`<<<SOURCE>>>…<<<END SOURCE>>>`); content never overrides template fields; every source records `sourceProvenance { kind, originalName, sha256, fetchedFrom?, extractedVia? }`; derived text passes the existing redaction module before it reaches logs/events/webhooks.
4. **Templates T1–T4 are versioned data** (`content_templates` table, migration P4-2), not code. A job snapshot freezes `template` + `templateVersion`; the baseline `promptVersion` ("v1"/"custom") mechanism is generalized (version now points at a DB row, `"custom"` still means caller-supplied). A template's required `capabilities` are checked against the provider matrix **at create time** (honest 400, pre-run).
5. **LLM metadata enrichment is best-effort** via the existing `internal-llm.ts` client: one validated (zod) call per job, `enrichment: null` + `metadata_enrichment_skipped` event on any failure — **enrichment failure never fails a job**.

### The four templates (honest status at baseline)
| Id | Name | Required capability | Status |
|---|---|---|---|
| `t1_deep_dive` | DEEP DIVE PODCAST | `generate.audio` (deep_dive) | **runnable today** — podcast pipeline `IMPLEMENTED`+`INTEGRATION_TESTED`, live-verified P0 |
| `t2_debate` | DEBATE PODCAST | `generate.audio` (debate) | **runnable today** — `JobInput.podcast.format: "debate"` exists |
| `t3_infographic` | VERTICAL INFOGRAPHIC | `generate.infographic` | `NOT_IMPLEMENTED` in the NLO worker (library supports it); worker extension P4-5; declared `unavailable` until then |
| `t4_reels` | REELS/SHORTS | `generate.video` (short-form) | `NOT_IMPLEMENTED` in the NLO worker; worker extension P4-5; declared `unavailable` until then |

A template whose required capabilities are not all `implemented_tested`+ on the target provider is **listed but marked** (`availableFor: []` + reason) — never advertised as available.

## Rationale
- **Generalize the pattern that already works:** the honest matrix and the `invalid_docx`/`invalid_srt` distinct-error discipline are proven; P4 extends them to more kinds rather than inventing a new model.
- **Injection is the new risk:** once URLs/PDFs/audio transcripts feed prompts, "the content says 'ignore the above and…'" is a live threat; the delimited-region + control-block-from-validated-inputs rule is the cheapest correct control.
- **Templates-as-data** is what makes `list_templates` (the one genuinely new capability in the MCP surface) and per-template capability gating possible without a deploy per template change.

## Consequences
**Positive:** new formats/kinds are config+capability changes; T1–T4 are product-configurable; injection is contained; `list_templates` becomes real.
**Negative / risks:** extraction adds dependencies (PDF library, ffmpeg audio-track probing) — chosen in P4-2, kept behind the "text out, provenance in" contract; URL fetch is *not* JS-rendering (stated limit); enrichment depends on the internal LiteLLM proxy being up (best-effort, non-fatal).

## Alternatives considered
- **Per-format code branches:** rejected — the baseline already proves the data-driven matrix is cleaner and honest.
- **A separate "Template Management" context:** rejected — templates are intake+prompt presets, so folded into Content Intake (ADR-001).
- **Treat source content as trusted (direct prompt interpolation):** rejected — injection class; the untrusted-content rule is mandatory.

## Evidence
- Matrix + honesty rule: [`packages/shared/src/input-capabilities.ts`](../../../../packages/shared/src/input-capabilities.ts) + [`test/input-capabilities.test.ts`](../../../../packages/shared/test/input-capabilities.test.ts).
- Text/docx/srt extraction: [`apps/server/src/api/job-create.ts`](../../../../apps/server/src/api/job-create.ts), [`apps/server/src/domain/docx.ts`](../../../../apps/server/src/domain/docx.ts); tests `test/document-sources.test.ts`, `test/from-text.test.ts`.
- Versioned master prompt: `promptVersion` at [`job-create.ts:258`](../../../../apps/server/src/api/job-create.ts:258).
- Enrichment client: [`apps/server/src/internal-llm.ts`](../../../../apps/server/src/internal-llm.ts) (config-only endpoint, key never logged).
- SSRF guard (URL intake): [`packages/shared/src/ssrf.ts`](../../../../packages/shared/src/ssrf.ts) + `test/ssrf.test.ts`.
- Podcast formats: `JobInput.podcast.format` in [`packages/shared/src/types.ts:202`](../../../../packages/shared/src/types.ts:202).
