/**
 * H1 — text-to-notebook support (shared, provider-agnostic).
 *
 * Versioned master prompts + title derivation. Prompts are versioned
 * constants so every job records WHICH prompt version produced its result
 * (`JobInput.promptVersion`). See docs/architecture/h1-text-to-notebook.md.
 */

export interface MasterPrompt {
  version: string;
  text: string;
}

/**
 * v1 — bilingual (Persian + English) structured summary prompt.
 * Rules: faithful (no invention), structured, matches the dominant source
 * language, bounded length.
 */
export const MASTER_PROMPT_VERSIONS: Record<string, MasterPrompt> = {
  v1: {
    version: "v1",
    text: [
      "Summarize the provided source text as a faithful, structured digest.",
      "Do not invent facts; only use information present in the source.",
      "",
      "Structure the answer as:",
      "1. Overview: 3-5 sentences of the source's main content and purpose.",
      "2. Key points: a bullet list of the most important claims, facts, and decisions.",
      "3. Notable items: notable names, dates, numbers, and places (only if present).",
      "",
      "Language: write the summary in the dominant language of the source text",
      "(Persian source -> Persian summary; English source -> English summary).",
      "Keep the whole answer under 500 words.",
    ].join("\n"),
  },
};

export const DEFAULT_MASTER_PROMPT_VERSION = "v1";

/**
 * Resolve which prompt a text job should run.
 * A non-empty `requested` prompt wins (version "custom"); otherwise the
 * default versioned master prompt is used.
 */
export function resolveMasterPrompt(requested?: string | null): { version: string; text: string } {
  if (requested !== null && requested !== undefined && requested.trim() !== "") {
    return { version: "custom", text: requested };
  }
  const v = MASTER_PROMPT_VERSIONS[DEFAULT_MASTER_PROMPT_VERSION];
  if (!v) throw new Error("default master prompt version is missing");
  return { version: v.version, text: v.text };
}

/**
 * Derive a human-friendly title from raw text: the first non-empty
 * line/sentence, whitespace-collapsed, truncated to `maxLen` characters.
 * The source language is preserved (no translation/normalization).
 */
export function deriveTitleFromText(text: string, maxLen = 80): string {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    // Prefer a sentence-like start: cut at the first sentence terminator
    // if it lands within the limit, otherwise hard-truncate.
    let t: string;
    if (collapsed.length <= maxLen) {
      t = collapsed;
    } else {
      const end = collapsed.indexOf(" ", maxLen - 1);
      t = collapsed.slice(0, end !== -1 && end < maxLen ? end : maxLen).trimEnd();
    }
    return t;
  }
  return "Untitled text source";
}
