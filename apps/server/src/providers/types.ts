import type { FailureClass } from "@nlo/shared";
import type { ProviderEgress } from "../proxy/egress.js";
import type { TunnelHandle } from "../proxy/runtime.js";

/**
 * Provider abstraction. The application never talks to NotebookLM directly;
 * it goes through this interface. Each implementation MUST declare honest
 * capability levels (never claim a fake capability).
 *
 * The "audio + prompt" workflow, concretely:
 *   uploadAudioSource -> add an audio file as a notebook source
 *   ask              -> submit the prompt against the notebook
 *   retrieveResult   -> read the grounded answer as Markdown
 *   retrieveArtifacts-> collect ONLY files the provider actually returned
 *
 * These are distinct operations and are not interchangeable with
 * "generate audio overview" (which is the opposite direction).
 */

export interface ProviderAccountStatus {
  ok: boolean;
  email: string | null;
  detail: string | null;
}

export interface ProviderJobRequest {
  jobId: string;
  accountId: string;
  /** Opaque per-account credential handle resolved by the provider (not a secret). */
  credentialRef: string;
  prompt: string;
  /**
   * Path to the uploaded audio (server-side, sanitized). `null` when the
   * request has no audio. The provider decides support.
   */
  audioPath: string | null;
  audioMediaType: string | null;
  /**
   * H1 (text-to-notebook): path to the stored text source (server-side,
   * fixed name input/text-source.md). `null` for audio jobs. When set, the
   * provider adds the text as a NotebookLM source (e.g. `sources.add_text`).
   */
  textPath?: string | null;
  /** H1: title used for the text source (idempotency anchor). */
  textTitle?: string | null;
  /**
   * H1: desired notebook title. Providers that reuse-or-create notebooks by
   * title use this; audio providers without a title keep their legacy
   * `nlo-<jobId>` fallback.
   */
  notebookTitle?: string | null;
  /**
   * NLO-P2 (podcast): the job wants an Audio Overview generated in the
   * created notebook AFTER the base workflow. The job runner drives the
   * audio ops (generate/status/download); this flag tells the provider the
   * job is podcast-enabled (the mock uses it to report notebook operation
   * IDs, mirroring the real worker).
   */
  podcast?: boolean | null;
  /**
   * The ONLY network route the provider may use. `null` means "no approved
   * tunnel" — a live provider MUST then refuse (fail-closed). Mock ignores.
   */
  tunnel: TunnelHandle | null;
  egress: ProviderEgress;
  signal: AbortSignal;
  onProgress: (progress: number, note: string) => void;
}

export interface ProviderJobResult {
  answerMarkdown: string | null;
  providerMeta: Record<string, unknown>;
  /** Files the provider actually produced. Application must not fabricate. */
  artifacts: { name: string; mediaType: string; path: string }[];
}

export interface ProviderError {
  failureClass: FailureClass;
  message: string;
  httpStatus?: number;
  /** True when the operation's completion is unknown (must NOT auto-retry). */
  ambiguous: boolean;
  /** True when this error indicates the account needs re-auth. */
  needsReauth: boolean;
}

export class ProviderFailure extends Error {
  constructor(public readonly info: ProviderError) {
    super(info.message);
    this.name = "ProviderFailure";
  }
}

export interface NotebookLMProvider {
  readonly name: string;
  capabilities(): { operation: string; level: string; note?: string }[];
  /**
   * Honest per-format INPUT capability (Phase 3.1). The app layer combines
   * this with its configured allowed extensions to answer "is this input
   * supported?" — levels are never inflated, formats the provider cannot
   * handle are simply not declared.
   */
  inputCapabilities(): { format: string; level: string; note?: string }[];
  validateConfiguration(): Promise<{ ok: boolean; issues: string[] }>;
  getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus>;
  /**
   * Run the full audio+prompt workflow for a job. Must throw ProviderFailure
   * on any error. Must not fabricate results.
   */
  runJob(req: ProviderJobRequest): Promise<ProviderJobResult>;
  cancel(jobId: string): Promise<{ accepted: boolean; note: string }>;

  // NLO-P2: Audio Overview (podcast) pipeline. These are OPTIONAL on the
  // interface (capability-gated): the app checks for their presence and
  // reports the operation as unsupported when absent. Providers that
  // implement them MUST throw ProviderFailure on any error and must never
  // fabricate a task id or an artifact file.

  /**
   * Submit (or resume) an Audio Overview generation in an EXISTING notebook.
   * When `resumeTaskId` is given, the provider MUST poll the recorded task
   * first and only re-submit on proven failure ("failed"). The returned
   * `status.taskId` is the ONLY recoverable handle for the external
   * operation and must be persisted by the caller.
   */
  generateAudio?(req: ProviderAudioGenerateRequest): Promise<ProviderAudioGenerateResult>;
  /** Poll a recorded generation task (task id == artifact id). */
  getAudioStatus?(req: ProviderAudioStatusRequest): Promise<ProviderAudioStatusResult>;
  /**
   * Fetch a completed audio artifact to a server-controlled destination path
   * and verify the transfer (exists, non-empty, within size limit). A
   * `ready: false` result means "not finished yet" (not an error).
   */
  downloadAudio?(req: ProviderAudioDownloadRequest): Promise<ProviderAudioDownloadResult>;
}

// ---------------------------------------------------------------------------
// NLO-P2: Audio Overview (podcast) generation types.
//
// Wire contract with the python worker (nbl_worker.py audio_* ops): the TS
// provider maps the flat worker payload onto the nested `status` object below.
// ---------------------------------------------------------------------------

export const AudioFormats = ["deep_dive", "brief", "critique", "debate"] as const;
export type AudioFormat = (typeof AudioFormats)[number];

export const AudioLengths = ["short", "default", "long"] as const;
export type AudioLength = (typeof AudioLengths)[number];

/**
 * Snapshot of a generation task's state. Values are the library's status
 * strings ("pending" | "in_progress" | "completed" | "failed" | "not_found" |
 * ...) plus boolean predicates — the caller decides policy from the flags.
 */
export interface ProviderAudioStatus {
  taskId: string | null;
  status: string | null;
  url: string | null;
  error: string | null;
  errorCode: string | null;
  metadata: Record<string, unknown> | null;
  isComplete: boolean;
  isFailed: boolean;
  isTerminal: boolean;
  isNotFound: boolean;
  isRateLimited: boolean;
}

export interface ProviderAudioGenerateRequest {
  jobId: string;
  accountId: string;
  /** Opaque per-account credential handle (resolved by the provider). */
  credentialRef: string;
  /** Existing NotebookLM notebook to generate in (created by runJob earlier). */
  notebookId: string;
  /** Sources to use; null/undefined = all notebook sources. */
  sourceIds?: string[] | null;
  /** Deep Dive instructions (optional). */
  prompt?: string | null;
  /** e.g. "en" / "fa"; library default when unset. */
  language?: string | null;
  audioFormat?: AudioFormat | null;
  audioLength?: AudioLength | null;
  /** Previously recorded task id — poll first, resubmit ONLY on proven failure. */
  resumeTaskId?: string | null;
  /** The ONLY network route; `null` => fail-closed refusal in live providers. */
  tunnel: TunnelHandle | null;
  egress: ProviderEgress;
  signal: AbortSignal;
  onProgress: (progress: number, note: string) => void;
}

export interface ProviderAudioGenerateResult {
  email: string | null;
  notebookId: string;
  /** True when a pre-existing task was kept (no new generation submitted). */
  resumed: boolean;
  /** Prior task status when the resume path re-submitted after a proven failure. */
  priorStatus: string | null;
  status: ProviderAudioStatus;
  instructionsProvided: boolean;
  checkedAt: string;
}

export interface ProviderAudioStatusRequest {
  jobId: string;
  accountId: string;
  credentialRef: string;
  notebookId: string;
  /** The task id returned by generateAudio (== the artifact id). */
  taskId: string;
  tunnel: TunnelHandle | null;
  egress: ProviderEgress;
  signal: AbortSignal;
  onProgress: (progress: number, note: string) => void;
}

export interface ProviderAudioStatusResult {
  notebookId: string;
  status: ProviderAudioStatus;
  checkedAt: string;
}

export interface ProviderAudioDownloadRequest {
  jobId: string;
  accountId: string;
  credentialRef: string;
  notebookId: string;
  artifactId: string;
  /**
   * Server-controlled destination path. The app MUST generate the name
   * (no user path components); the provider's parent dir is created as needed
   * and a stale file at the same path is replaced, never appended.
   */
  destPath: string;
  /** Hard size limit (bytes); an oversized transfer is removed + reported as an error. */
  maxBytes?: number | null;
  tunnel: TunnelHandle | null;
  egress: ProviderEgress;
  signal: AbortSignal;
  onProgress: (progress: number, note: string) => void;
}

export interface ProviderAudioDownloadResult {
  /** False = artifact exists but is not finished yet (not an error). */
  ready: boolean;
  notebookId: string;
  artifactId: string;
  /** Verified file location — only set when `ready` is true. */
  path?: string;
  size?: number;
  sha256?: string;
  durationSeconds?: number | null;
  artifactTitle?: string | null;
  /** Library artifact status string (e.g. "in_progress", "completed"). */
  artifactStatus?: string;
  checkedAt: string;
}

/** Capability level constants (mirror shared). */
export const CapLevel = {
  implementedTested: "implemented_tested",
  implementedUntestedLive: "implemented_untested_live",
  experimental: "experimental",
  unsupported: "unsupported",
  unavailable: "unavailable",
} as const;

/**
 * Honest capability declaration helper. Providers must list every operation
 * they might be asked to do, with a truthful level.
 */
export function capabilityMatrix(ops: Record<string, { level: string; note?: string }>): {
  operation: string;
  level: string;
  note?: string;
}[] {
  return Object.entries(ops).map(([operation, v]) => ({ operation, ...v }));
}
