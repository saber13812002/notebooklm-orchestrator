import type { CapabilityLevel } from "./types.js";

/** Audio formats the app layer accepts on the audio job path (config-restricted at runtime). */
export const AUDIO_INPUT_FORMATS = ["wav", "mp3", "m4a", "ogg", "flac"] as const;
/** Document formats accepted on the file path (validated/extracted to text). */
export const DOCUMENT_INPUT_FORMATS = ["txt", "docx", "srt"] as const;
/** Every input format the unified workflow answers for ("text" = plain JSON text). */
export const ALL_INPUT_FORMATS = [
  "text",
  ...DOCUMENT_INPUT_FORMATS,
  ...AUDIO_INPUT_FORMATS,
] as const;

export type InputFormat = (typeof ALL_INPUT_FORMATS)[number];

/** A provider's declared support for a single input format (honest level). */
export interface ProviderInputCapability {
  format: string;
  level: string;
  note?: string;
}

/** Effective (config + provider) input capability for one format. */
export interface InputCapability {
  format: string;
  level: CapabilityLevel;
  /** Whether the app layer currently accepts this format (config-driven). */
  accepted: boolean;
  note?: string;
}

const KNOWN = new Set<string>(ALL_INPUT_FORMATS);

/** Map a filename to a known input format, or null (unknown/missing extension). */
export function inputFormatFromFilename(filename: string): string | null {
  const name = (filename ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return KNOWN.has(ext) ? ext : null;
}

/**
 * Build the effective input matrix for the API: app-layer acceptance (from
 * the configured allowed audio/document extensions) combined with the honest
 * provider capability level per format. A format the provider does not
 * declare is reported "unavailable" — never guessed, never inflated.
 */
export function buildInputMatrix(
  config: { audio: string[]; documents: string[] },
  provider: ProviderInputCapability[],
): InputCapability[] {
  const byFormat = new Map(provider.map((p) => [p.format, p]));
  const configured = new Set([...config.audio, ...config.documents]);
  return ALL_INPUT_FORMATS.map((format) => {
    const p = byFormat.get(format);
    return {
      format,
      level: (p?.level ?? "unavailable") as CapabilityLevel,
      accepted: format === "text" ? true : configured.has(format),
      ...(p?.note ? { note: p.note } : {}),
    };
  });
}
