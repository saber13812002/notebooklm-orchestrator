import { describe, expect, it } from "vitest";
import {
  CAPABILITY_LEVELS,
  NOTEBOOKLM_LIVE_OP_MAP,
  PROVIDER_OPERATIONS,
  deriveNotebookLmDescriptor,
  providerDescriptorSchema,
  type LiveProviderFacts,
} from "../src/provider-descriptor.js";

/**
 * NLO-P4-1A: provider descriptor contract (shared).
 *
 * Unit-level conformance gate for the capability contract defined in
 * docs/architecture/NLO_PROVIDER_CAPABILITY_CONTRACTS.md:
 *  - the canonical 31-operation union (`PROVIDER_OPERATIONS`) is the ONLY
 *    vocabulary a descriptor may use;
 *  - levels are the 5-value honest scale;
 *  - `deriveNotebookLmDescriptor()` maps contract operations to the live
 *    worker operations that back them and copies levels VERBATIM — never
 *    inflated, never deflated;
 *  - F-C1: the worker fuses `notebook.create + source.add + chat.ask` into
 *    a single job run, and the four fused operations must carry the
 *    fusion note (the provider never advertises three independent ops);
 *  - a contract operation the worker does not offer is `unsupported`
 *    (never guessed).
 *
 * The two snapshots below are recorded VERBATIM from the providers as of
 * baseline f07ac1f (mock: apps/server/src/providers/mock-provider.ts,
 * python-worker: apps/server/src/providers/python-worker/python-worker-provider.ts).
 * If a provider's matrix changes, update the snapshot HERE first, then the
 * provider — that is the anti-drift gate.
 */

const MOCK_LIVE: LiveProviderFacts = {
  name: "mock",
  isMock: true,
  capabilities: [
    { operation: "validateConfiguration", level: "implemented_tested" },
    { operation: "getAccountStatus", level: "implemented_tested" },
    {
      operation: "uploadAudioSource",
      level: "implemented_tested",
      note: "simulated; real provider supports .wav (mp3 unverified)",
    },
    { operation: "ask", level: "implemented_tested" },
    { operation: "retrieveResult", level: "implemented_tested" },
    {
      operation: "retrieveArtifacts",
      level: "implemented_tested",
      note: "only provider-returned files are surfaced; mock returns one sample",
    },
    { operation: "cancelJob", level: "implemented_tested", note: "mock honors cancel" },
    {
      operation: "addTextSource",
      level: "implemented_tested",
      note: "simulated (H1 text-to-notebook); real mechanism verified in notebooklm-py 0.8.5",
    },
    {
      operation: "generateAudio",
      level: "implemented_tested",
      note: "simulated (NLO-P2); deterministic task ids, no real generation",
    },
    {
      operation: "getAudioStatus",
      level: "implemented_tested",
      note: "simulated (NLO-P2); state controlled by test hooks",
    },
    {
      operation: "downloadAudio",
      level: "implemented_tested",
      note: "simulated (NLO-P2); writes a minimal real WAV file, verified size/hash",
    },
  ],
  inputCapabilities: [
    { format: "text", level: "implemented_tested", note: "simulated (H1 text-to-notebook)" },
    {
      format: "txt",
      level: "implemented_tested",
      note: "simulated; validated and submitted verbatim in the app layer",
    },
    {
      format: "docx",
      level: "implemented_tested",
      note: "simulated; extracted to plain text in the app layer (mammoth)",
    },
    {
      format: "srt",
      level: "implemented_tested",
      note: "simulated; validated in the app layer, submitted verbatim",
    },
    { format: "wav", level: "implemented_tested", note: "simulated; real provider supports .wav" },
    { format: "mp3", level: "implemented_tested", note: "simulated; real support unverified" },
    { format: "m4a", level: "implemented_tested", note: "simulated; real support unverified" },
    { format: "ogg", level: "implemented_tested", note: "simulated; real support unverified" },
    { format: "flac", level: "implemented_tested", note: "simulated; real support unverified" },
  ],
};

const LIVE_WORKER: LiveProviderFacts = {
  name: "python-worker",
  isMock: false,
  capabilities: [
    {
      operation: "validateConfiguration",
      level: "implemented_tested",
      note: "worker ping + import check",
    },
    {
      operation: "getAccountStatus",
      level: "implemented_untested_live",
      note: "verify against real service",
    },
    {
      operation: "login",
      level: "implemented_untested_live",
      note: "interactive Playwright browser sign-in",
    },
    {
      operation: "submitAudioJob",
      level: "implemented_untested_live",
      note: "real upload + ask via notebooklm-py",
    },
    {
      operation: "retrieveTextJob",
      level: "implemented_untested_live",
      note: "real add_text + ask via notebooklm-py 0.8.5",
    },
    {
      operation: "retrieveResult",
      level: "implemented_untested_live",
      note: "real grounded answer",
    },
    {
      operation: "retrieveArtifacts",
      level: "unsupported",
      note: "chat answers are text; no downloadable artifacts in this workflow",
    },
    {
      operation: "cancelJob",
      level: "experimental",
      note: "kills the worker; in-flight server op may still finish",
    },
    {
      operation: "generateAudio",
      level: "implemented_untested_live",
      note: "real Audio Overview submit via notebooklm-py artifacts.generate_audio (NLO-P2)",
    },
    {
      operation: "getAudioStatus",
      level: "implemented_untested_live",
      note: "real task polling via artifacts.poll_status (NLO-P2)",
    },
    {
      operation: "downloadAudio",
      level: "implemented_untested_live",
      note: "real artifact download + verification via artifacts.download_audio (NLO-P2)",
    },
  ],
  inputCapabilities: [
    { format: "text", level: "implemented_untested_live", note: "submitted via sources.add_text" },
    {
      format: "txt",
      level: "implemented_untested_live",
      note: "submitted verbatim as a text source",
    },
    {
      format: "srt",
      level: "implemented_untested_live",
      note: "validated in the app layer, submitted verbatim",
    },
    {
      format: "docx",
      level: "implemented_untested_live",
      note: "extracted to plain text in the app layer (mammoth)",
    },
    {
      format: "wav",
      level: "implemented_untested_live",
      note: "live-verified real NotebookLM upload 2026-11-06",
    },
    { format: "mp3", level: "experimental", note: "not live-verified on the real service" },
    { format: "m4a", level: "experimental", note: "not live-verified on the real service" },
    { format: "ogg", level: "experimental", note: "not live-verified on the real service" },
    { format: "flac", level: "experimental", note: "not live-verified on the real service" },
  ],
};

type Descriptor = ReturnType<typeof deriveNotebookLmDescriptor>;

function levelOf(d: Descriptor, op: string): string {
  return d.capabilities.find((c) => c.operation === op)?.level ?? "<absent>";
}

function noteOf(d: Descriptor, op: string): string {
  return d.capabilities.find((c) => c.operation === op)?.note ?? "";
}

const UNSUPPORTED_OPS = [
  "source.add.url",
  "source.add.audio",
  "source.add.video",
  "source.add.pdf",
  "source.add.docx",
  "source.add.md",
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
  "artifact.download.batch",
  "usage.introspect",
] as const;

const FUSION_OPS = ["notebook.create", "source.add.text", "source.add.file", "chat.ask"] as const;

const AUDIO_GEN_OPS = [
  "generate.audio.deep_dive",
  "generate.audio.brief",
  "generate.audio.critique",
  "generate.audio.debate",
  "generate.audio.language.en",
  "generate.audio.language.fa",
  "generate.audio.language.other",
] as const;

describe("PROVIDER_OPERATIONS / CAPABILITY_LEVELS (contract vocabulary)", () => {
  it("is the canonical 31-operation union from NLO_PROVIDER_CAPABILITY_CONTRACTS.md", () => {
    expect(PROVIDER_OPERATIONS).toHaveLength(31);
    expect(new Set(PROVIDER_OPERATIONS).size).toBe(PROVIDER_OPERATIONS.length); // no duplicates
    for (const op of [
      "notebook.create",
      "chat.ask",
      "generate.audio.deep_dive",
      "generate.video.explainer",
      "artifact.download",
      "artifact.download.batch",
      "usage.introspect",
      "session.verify",
    ]) {
      expect(PROVIDER_OPERATIONS).toContain(op);
    }
  });

  it("exposes exactly the five honest capability levels", () => {
    expect([...CAPABILITY_LEVELS]).toEqual([
      "implemented_tested",
      "implemented_untested_live",
      "experimental",
      "unsupported",
      "unavailable",
    ]);
  });

  it("NOTEBOOKLM_LIVE_OP_MAP only references live worker ops and known contract ops", () => {
    for (const [contractOp, liveOps] of Object.entries(NOTEBOOKLM_LIVE_OP_MAP)) {
      expect(PROVIDER_OPERATIONS).toContain(contractOp as (typeof PROVIDER_OPERATIONS)[number]);
      expect(liveOps.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("providerDescriptorSchema (zod validation)", () => {
  const mockDescriptor = deriveNotebookLmDescriptor(MOCK_LIVE);

  it("round-trips a derived mock descriptor", () => {
    expect(providerDescriptorSchema.parse(mockDescriptor)).toEqual(mockDescriptor);
  });

  it("rejects an unknown operation", () => {
    const bad = structuredClone(mockDescriptor);
    (bad.capabilities[0] as { operation: string }).operation = "notebook.delete";
    expect(() => providerDescriptorSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown capability level", () => {
    const bad = structuredClone(mockDescriptor);
    (bad.capabilities[0] as { level: string }).level = "excellent";
    expect(() => providerDescriptorSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown provider kind", () => {
    const bad = structuredClone(mockDescriptor);
    (bad as { kind: string }).kind = "remote";
    expect(() => providerDescriptorSchema.parse(bad)).toThrow();
  });

  it("rejects unknown top-level fields (strict)", () => {
    const bad = structuredClone(mockDescriptor);
    (bad as Record<string, unknown>).marketingClaim = "100% coverage";
    expect(() => providerDescriptorSchema.parse(bad)).toThrow();
  });
});

describe("deriveNotebookLmDescriptor — MOCK snapshot (levels copied verbatim)", () => {
  const d = deriveNotebookLmDescriptor(MOCK_LIVE);

  it("declares every contract operation exactly once (31 total)", () => {
    expect(d.capabilities).toHaveLength(31);
    expect(new Set(d.capabilities.map((c) => c.operation)).size).toBe(31);
  });

  it("maps fused/foundational ops to their live backing with verbatim levels (no inflation)", () => {
    // Mock live levels are all implemented_tested; the descriptor must match
    // the BACKING live op's level exactly.
    expect(levelOf(d, "notebook.create")).toBe("implemented_tested");
    expect(noteOf(d, "notebook.create")).toContain("uploadAudioSource");
    expect(levelOf(d, "source.add.text")).toBe("implemented_tested");
    expect(noteOf(d, "source.add.text")).toContain("addTextSource");
    expect(levelOf(d, "source.add.file")).toBe("implemented_tested");
    expect(noteOf(d, "source.add.file")).toContain("uploadAudioSource");
    expect(levelOf(d, "chat.ask")).toBe("implemented_tested");
    expect(noteOf(d, "chat.ask")).toContain("ask");
    for (const op of AUDIO_GEN_OPS) {
      expect(levelOf(d, op), op).toBe("implemented_tested");
    }
    expect(levelOf(d, "artifact.download")).toBe("implemented_tested");
    expect(levelOf(d, "session.verify")).toBe("implemented_tested");
  });

  it("F-C1: the four fused operations carry the fusion note", () => {
    for (const op of FUSION_OPS) {
      expect(noteOf(d, op), op).toMatch(/F-C1 fusion/);
    }
  });

  it("undeclared contract operations are unsupported (never guessed)", () => {
    for (const op of UNSUPPORTED_OPS) {
      expect(levelOf(d, op), op).toBe("unsupported");
    }
  });

  it("attaches input formats to the right contract operations only", () => {
    const text = d.capabilities.find((c) => c.operation === "source.add.text")!;
    const file = d.capabilities.find((c) => c.operation === "source.add.file")!;
    expect(text.formats).toEqual(["text", "txt", "docx", "srt"]);
    expect(file.formats).toEqual(["wav", "mp3", "m4a", "ogg", "flac"]);
    const ask = d.capabilities.find((c) => c.operation === "chat.ask")!;
    expect(ask.formats).toBeUndefined();
  });

  it("identity + auth are honest for the mock (no real credential claimed)", () => {
    expect(d.id).toBe("notebooklm.web");
    expect(d.name).toBe("NotebookLM (mock)");
    expect(d.kind).toBe("native");
    expect(d.transport).toBe("web-batchexecute");
    expect(d.egressPolicy).toBe("tunnel");
    expect(d.maxConcurrent).toBe(1);
    expect(d.version).toBe("nlo-mock/1.0");
    expect(d.status).toBe("active");
    expect(d.verifiedAt).toBe("2026-11-16");
    expect(d.authRequirement.credentialKinds).toEqual([]);
    expect(d.authRequirement.hostProfiles).toEqual([]);
  });
});

describe("deriveNotebookLmDescriptor — PYTHON-WORKER snapshot (no inflation to tested)", () => {
  const d = deriveNotebookLmDescriptor(LIVE_WORKER);

  it("keeps implemented_untested_live levels verbatim (live ops are NOT claimed as tested)", () => {
    expect(levelOf(d, "notebook.create")).toBe("implemented_untested_live");
    expect(noteOf(d, "notebook.create")).toContain("submitAudioJob");
    expect(levelOf(d, "source.add.text")).toBe("implemented_untested_live");
    expect(noteOf(d, "source.add.text")).toContain("retrieveTextJob");
    expect(levelOf(d, "source.add.file")).toBe("implemented_untested_live");
    expect(levelOf(d, "chat.ask")).toBe("implemented_untested_live");
    // The worker has no standalone `ask` op — chat.ask is backed by retrieveResult.
    expect(noteOf(d, "chat.ask")).toContain("retrieveResult");
    for (const op of AUDIO_GEN_OPS) {
      expect(levelOf(d, op), op).toBe("implemented_untested_live");
    }
    expect(levelOf(d, "artifact.download")).toBe("implemented_untested_live");
    expect(levelOf(d, "session.verify")).toBe("implemented_untested_live");
  });

  it("still marks unsupported ops unsupported and fused ops carry F-C1 notes", () => {
    for (const op of UNSUPPORTED_OPS) {
      expect(levelOf(d, op), op).toBe("unsupported");
    }
    for (const op of FUSION_OPS) {
      expect(noteOf(d, op), op).toMatch(/F-C1 fusion/);
    }
  });

  it("identity + auth are honest for the live worker", () => {
    expect(d.id).toBe("notebooklm.web");
    expect(d.name).toBe("NotebookLM (Web)");
    expect(d.version).toBe("notebooklm-py/0.8.5");
    expect(d.status).toBe("active");
    expect(d.authRequirement.credentialKinds).toEqual(["storage_state"]);
    expect(d.authRequirement.hostProfiles).toEqual(["consumer"]);
  });

  it("attaches the worker's declared input formats (docx via app-layer extraction)", () => {
    const text = d.capabilities.find((c) => c.operation === "source.add.text")!;
    const file = d.capabilities.find((c) => c.operation === "source.add.file")!;
    expect(text.formats).toEqual(["text", "txt", "docx", "srt"]);
    expect(file.formats).toEqual(["wav", "mp3", "m4a", "ogg", "flac"]);
  });
});
