/**
 * Notebook title generation + language heuristics (Phase 3.3).
 *
 * Title policy (checked in this order):
 *   1. caller-provided override (trimmed)
 *   2. cleaned original filename (basename only, no extension)
 *   3. first meaningful line/sentence of the text content
 *   4. stable "Untitled notebook"
 *
 * A language hint (fa/en) is persisted as job metadata — it is deliberately
 * NOT appended to the title (the target format "تفسیر موضوعی عدالت — جلسه اول"
 * has no language suffix).
 */

/** Collapse whitespace, then truncate at a word boundary; hard-cut otherwise. */
export function truncateAtWordBoundary(text: string, maxLen = 80): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  // The slice already ends on a word boundary (next char is a space).
  if (s[maxLen] === " ") return cut;
  const space = cut.lastIndexOf(" ");
  if (space > Math.floor(maxLen / 2)) return cut.slice(0, space);
  return cut;
}

/**
 * Clean an original upload filename into a title candidate.
 * Uses the basename only (any path components are dropped — traversal-safe),
 * strips the LAST extension, maps `-`/`_` to spaces, collapses whitespace.
 * Returns null when nothing usable remains.
 */
export function cleanFilename(original: string, maxLen = 120): string | null {
  const name = (original ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name.startsWith(".") ? "" : name;
  const t = truncateAtWordBoundary(stem.replace(/[-_]+/g, " "), maxLen);
  return t.length > 0 ? t : null;
}

const FA_RE = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const EN_RE = /[A-Za-z]/g;

/**
 * Dominant-script heuristic: counts Persian/Arabic-script letters vs Latin
 * letters. Returns "fa" when the Persian/Arabic script clearly dominates,
 * "en" when Latin clearly dominates, null when there is no clear signal.
 */
export function detectLanguage(text: string): "fa" | "en" | null {
  const fa = (text.match(FA_RE) ?? []).length;
  const en = (text.match(EN_RE) ?? []).length;
  if (fa >= 2 && fa > en) return "fa";
  if (en >= 2 && en > fa) return "en";
  return null;
}

/**
 * Resolve the notebook title: caller override wins, then the first non-empty
 * candidate (e.g. cleaned filename, then first text line). All candidates are
 * whitespace-collapsed and truncated to 200 chars at a word boundary.
 */
export function deriveNotebookTitle(
  override: string | null | undefined,
  ...candidates: (string | null | undefined)[]
): string {
  const o = (override ?? "").trim();
  if (o) return truncateAtWordBoundary(o, 200);
  for (const c of candidates) {
    const t = (c ?? "").trim();
    if (t) return truncateAtWordBoundary(t, 200);
  }
  return "Untitled notebook";
}
