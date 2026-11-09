import { extractRawText } from "mammoth";

/**
 * Safe DOCX text extraction (Phase 3.1).
 *
 * A .docx is a ZIP archive; we parse `word/document.xml` via mammoth
 * (MIT-licensed, well-maintained) and return ONLY the plain text — no
 * styles, no embedded objects, no binary content. The caller submits the
 * extracted text as a NotebookLM text source; the raw DOCX is preserved in
 * the job archive for provenance.
 *
 * Throws on any corruption/invalid archive — the caller maps that to a
 * distinct `invalid_docx` API error (never a generic 500, never success).
 */
export async function extractDocxText(filePath: string): Promise<string> {
  const result = await extractRawText({ path: filePath });
  return result.value;
}
