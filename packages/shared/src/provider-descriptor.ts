import { z } from "zod";
import type { CapabilityLevel } from "./types.js";

/**
 * NLO-P4-1A: Provider descriptor + the canonical capability contract.
 *
 * The descriptor is the machine-readable declaration of what a provider CAN
 * do, expressed in the contract vocabulary defined in
 * `docs/architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md`:
 *
 *  - operations use the canonical 31-operation union (`PROVIDER_OPERATIONS`);
 *  - levels use the existing 5-value honest scale (never a new value);
 *  - a capability the provider does NOT offer is `unsupported` — never
 *    guessed, never inflated;
 *  - F-C1 (honesty): the current NotebookLM worker fuses
 *    `notebook.create + source.add + chat.ask` into ONE job run
 *    (`job`/`job_text`). Those contract operations are therefore declared
 *    with an explicit "F-C1 fusion" note; the provider never advertises
 *    three independent operations.
 *
 * The server derives the live descriptor from the running provider's
 * capability matrix (`deriveNotebookLmDescriptor`); it never hand-writes
 * levels.
 */

/** The canonical capability-contract operation union (31 operations). */
export const PROVIDER_OPERATIONS = [
  "notebook.create",
  "source.add.text",
  "source.add.file",
  "source.add.url",
  "source.add.audio",
  "source.add.video",
  "source.add.pdf",
  "source.add.docx",
  "source.add.md",
  "chat.ask",
  "generate.audio.deep_dive",
  "generate.audio.brief",
  "generate.audio.critique",
  "generate.audio.debate",
  "generate.audio.language.en",
  "generate.audio.language.fa",
  "generate.audio.language.other",
  "generate.video.explainer",
  "generate.video.cinematic",
  "generate.video.short",
  "generate.slide_deck",
  "generate.infographic",
  "generate.quiz",
  "generate.flashcards",
  "generate.mind_map",
  "generate.report",
  "generate.data_table",
  "artifact.download",
  "artifact.download.batch",
  "usage.introspect",
  "session.verify",
] as const;

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/** The five honest capability levels — no new values. */
export const CAPABILITY_LEVELS = [
  "implemented_tested",
  "implemented_untested_live",
  "experimental",
  "unsupported",
  "unavailable",
] as const;

export type { CapabilityLevel };

const operationEnum = z.enum(PROVIDER_OPERATIONS);
const levelEnum = z.enum(CAPABILITY_LEVELS);

/**
 * One contract operation declared by a provider.
 *
 * `formats` / `maxInputBytes` / `maxConcurrent` / `egressPolicy` are
 * OPTIONAL enrichment fields: a provider may attach them to a capability it
 * declares, but their absence means "not declared" — never "unlimited".
 */
export const providerCapabilitySchema = z.object({
  operation: operationEnum,
  level: levelEnum,
  note: z.string().optional(),
  formats: z.array(z.string()).optional(),
  maxInputBytes: z.number().int().positive().nullable().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  egressPolicy: z.enum(["tunnel", "direct", "either"]).optional(),
});

export type ProviderCapabilityDeclaration = z.infer<typeof providerCapabilitySchema>;

/** Credential kinds a provider may require (no secrets ever in the descriptor). */
export const credentialKindsSchema = z.enum(["storage_state", "cookie_jar", "api_key", "oauth"]);
export const hostProfileSchema = z.enum(["consumer", "workspace", "business", "edu"]);

/**
 * The full provider descriptor (P4 target architecture, "Provider Registry").
 * `id` is the stable registry identifier used by `activeId` in
 * `GET /api/v1/capabilities`.
 */
export const providerDescriptorSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    kind: z.enum(["native", "mcp_client"]),
    /** Transport mechanism (informational; e.g. "web-batchexecute"). */
    transport: z.string().min(1).max(64),
    capabilities: z.array(providerCapabilitySchema),
    authRequirement: z.object({
      credentialKinds: z.array(credentialKindsSchema).default([]),
      hostProfiles: z.array(hostProfileSchema).default([]),
    }),
    /** Egress policy for the provider's traffic (fail-closed default: tunnel). */
    egressPolicy: z.enum(["tunnel", "direct", "either"]),
    /** Max concurrent jobs the provider is declared to accept (1 = serialized). */
    maxConcurrent: z.number().int().positive(),
    /** Implementation/adapter version string (e.g. "notebooklm-py/0.8.5"). */
    version: z.string().min(1).max(64),
    /** ISO date of the last verification evidence for this descriptor. */
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(["active", "candidate", "disabled"]),
  })
  .strict();

export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;

/**
 * The live provider facts needed to derive the NotebookLM descriptor.
 * Mirrors `capabilities()` / `inputCapabilities()` of the
 * `NotebookLMProvider` interface (kept here in `packages/shared` so the
 * derivation is unit-testable without the server).
 */
export interface LiveProviderFacts {
  name: string;
  isMock: boolean;
  capabilities: { operation: string; level: string; note?: string }[];
  inputCapabilities: { format: string; level: string; note?: string }[];
}

/**
 * NOTEBOOKLM_LIVE_OP_MAP — the honest mapping from each contract operation
 * to the LIVE worker operations that back it.
 *
 * F-C1: `notebook.create`, `source.add.text`, `source.add.file` and
 * `chat.ask` are NOT independent operations in the current worker — they are
 * fused into a single `job`/`job_text` run (upload/add + ask in one Python
 * invocation). The map says which live op(s) evidence each contract op; the
 * derived level is copied VERBATIM from the first backing live op that the
 * provider declares (never inflated).
 */
export const NOTEBOOKLM_LIVE_OP_MAP: Record<string, string[]> = {
  // F-C1 fused operations (one job run does all of these):
  "notebook.create": ["submitAudioJob", "uploadAudioSource"],
  "source.add.text": ["retrieveTextJob", "addTextSource"],
  "source.add.file": ["submitAudioJob", "uploadAudioSource"],
  "chat.ask": ["ask", "retrieveResult"],
  // Audio generation (the NLO-P2 podcast pipeline):
  "generate.audio.deep_dive": ["generateAudio"],
  "generate.audio.brief": ["generateAudio"],
  "generate.audio.critique": ["generateAudio"],
  "generate.audio.debate": ["generateAudio"],
  "generate.audio.language.en": ["generateAudio"],
  "generate.audio.language.fa": ["generateAudio"],
  "generate.audio.language.other": ["generateAudio"],
  // Artifact delivery (podcast audio download):
  "artifact.download": ["downloadAudio"],
  // Session/credential verification:
  "session.verify": ["getAccountStatus"],
};

/** The four F-C1 fused contract operations (single job run). */
export const FUSION_OPERATIONS: readonly string[] = [
  "notebook.create",
  "source.add.text",
  "source.add.file",
  "chat.ask",
];

const FUSION_NOTE =
  "F-C1 fusion: part of one fused job run (notebook.create + source.add + chat.ask in a single " +
  "worker invocation); backing live op(s): {ops}.";

/** Text-family input formats (map to `source.add.text`). */
const TEXT_FORMATS = ["text", "txt", "docx", "srt"] as const;
/** Audio-family input formats (map to `source.add.file`). */
const AUDIO_FORMATS = ["wav", "mp3", "m4a", "ogg", "flac"] as const;

/**
 * Derive the `notebooklm.web` descriptor from the LIVE provider facts.
 *
 * Rules:
 *  - Every one of the 31 contract operations appears exactly once.
 *  - Declared ops: level copied VERBATIM from the first backing live op in
 *    `NOTEBOOKLM_LIVE_OP_MAP` that the provider declares (its `note` is
 *    kept, and the F-C1 fusion note is appended for the four fused ops).
 *  - Undeclared contract ops: `unsupported` (never guessed).
 *  - Input formats are attached to `source.add.text` / `source.add.file`
 *    only for formats the provider actually declares.
 */
export function deriveNotebookLmDescriptor(live: LiveProviderFacts): ProviderDescriptor {
  const byOp = new Map(live.capabilities.map((c) => [c.operation, c]));

  const declaredFormats = (family: readonly string[]): string[] => {
    const declared = new Set(live.inputCapabilities.map((i) => i.format));
    return family.filter((f) => declared.has(f));
  };

  const capabilities: ProviderCapabilityDeclaration[] = PROVIDER_OPERATIONS.map((op) => {
    const backing = NOTEBOOKLM_LIVE_OP_MAP[op];
    const liveOp = backing?.map((o) => byOp.get(o)).find(Boolean);
    const fusion = FUSION_OPERATIONS.includes(op);

    if (liveOp) {
      const level = liveOp.level as CapabilityLevel;
      const noteParts = [
        liveOp.note ?? "",
        fusion ? FUSION_NOTE.replace("{ops}", (backing as string[]).join(", ")) : "",
      ];
      const note = noteParts.filter(Boolean).join(" ");
      const cap: ProviderCapabilityDeclaration = {
        operation: op,
        level,
        ...(note ? { note } : {}),
      };
      // Attach input formats to the source-add operations (declared only).
      if (op === "source.add.text") {
        const formats = declaredFormats(TEXT_FORMATS);
        if (formats.length > 0) cap.formats = formats;
      } else if (op === "source.add.file") {
        const formats = declaredFormats(AUDIO_FORMATS);
        if (formats.length > 0) cap.formats = formats;
      }
      return cap;
    }
    return { operation: op, level: "unsupported" as const };
  });

  return {
    id: "notebooklm.web",
    name: live.isMock ? "NotebookLM (mock)" : "NotebookLM (Web)",
    kind: "native",
    transport: "web-batchexecute",
    capabilities,
    authRequirement: live.isMock
      ? { credentialKinds: [], hostProfiles: [] }
      : { credentialKinds: ["storage_state"], hostProfiles: ["consumer"] },
    egressPolicy: "tunnel",
    maxConcurrent: 1,
    version: live.isMock ? "nlo-mock/1.0" : "notebooklm-py/0.8.5",
    // Last verification evidence for the descriptor shape: the P4-1 preflight
    // (2026-11-16). The descriptor is re-derived from live facts on every
    // request, so only this static metadata is "verified" as a date.
    verifiedAt: "2026-11-16",
    status: "active",
  };
}
