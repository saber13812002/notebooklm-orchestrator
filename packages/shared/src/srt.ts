/**
 * Minimal SRT (SubRip) transcript parser/validator (Phase 3.1).
 *
 * NLO treats an SRT upload as a *text source*: the original SRT content
 * (timestamps preserved) is submitted verbatim to NotebookLM. This module
 * only validates the structure and extracts the first cue's text (used for
 * title derivation). It is intentionally small:
 *   - each block starts with a positive integer cue index (sequentiality is
 *     NOT enforced — real SRT files often restart or skip)
 *   - timing must be `HH:MM:SS,mmm --> HH:MM:SS,mmm` (a dot is also accepted
 *     in the milliseconds separator)
 *   - end must be after start
 *   - each cue needs at least one non-empty dialogue line
 *
 * Any violation is reported with a distinct, machine-readable reason so the
 * API can reject malformed SRT with its own error code (invalid_srt).
 */

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  /** Dialogue text, original line breaks preserved (each line trimmed). */
  text: string;
}

export type SrtParseResult =
  { ok: true; cueCount: number; cues: SrtCue[]; firstText: string } | { ok: false; reason: string };

const TIMING_RE =
  /^(\d{1,2}):(\d{1,2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{2})[,.](\d{3})$/;

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    ((parseInt(h, 10) * 60 + parseInt(m, 10)) * 60 + parseInt(s, 10)) * 1000 + parseInt(ms, 10)
  );
}

export function parseSrt(raw: string): SrtParseResult {
  const text = (raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return { ok: false, reason: "empty SRT document" };

  const blocks = text.split(/\r?\n\s*\r?\n/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);

    // 1) cue index: positive integer (sequentiality not enforced)
    const idxLine = (lines[0] ?? "").trim();
    if (!/^\d+$/.test(idxLine) || parseInt(idxLine, 10) < 1) {
      return { ok: false, reason: `invalid cue index line: "${idxLine || "(missing)"}"` };
    }

    // 2) timing: HH:MM:SS,mmm --> HH:MM:SS,mmm
    const timingLine = (lines[1] ?? "").trim();
    const tm = TIMING_RE.exec(timingLine);
    if (!tm) {
      return { ok: false, reason: `invalid cue timing: "${timingLine || "(missing)"}"` };
    }
    const startMs = toMs(tm[1]!, tm[2]!, tm[3]!, tm[4]!);
    const endMs = toMs(tm[5]!, tm[6]!, tm[7]!, tm[8]!);
    if (endMs <= startMs) {
      return { ok: false, reason: `cue end time is before its start time: ${timingLine}` };
    }

    // 3) dialogue text: at least one non-empty line
    const dialogue = lines
      .slice(2)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (dialogue.length === 0) {
      return { ok: false, reason: "cue has no dialogue text" };
    }

    cues.push({ index: parseInt(idxLine, 10), startMs, endMs, text: dialogue.join("\n") });
  }

  if (cues.length === 0) return { ok: false, reason: "no cues found" };
  const first = cues[0]!;
  return { ok: true, cueCount: cues.length, cues, firstText: first.text };
}
