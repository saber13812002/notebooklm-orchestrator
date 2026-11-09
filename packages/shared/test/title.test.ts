import { describe, expect, it } from "vitest";
import {
  cleanFilename,
  detectLanguage,
  deriveNotebookTitle,
  truncateAtWordBoundary,
} from "../src/title.js";

describe("cleanFilename", () => {
  it("strips the path and the extension, keeping the Persian stem", () => {
    expect(cleanFilename("تفسیر موضوعی عدالت — جلسه اول.docx")).toBe(
      "تفسیر موضوعی عدالت — جلسه اول",
    );
  });

  it("maps separators to spaces and strips the extension case-insensitively", () => {
    expect(cleanFilename("my_lesson-notes.TXT")).toBe("my lesson notes");
  });

  it("uses the basename only (no path traversal)", () => {
    expect(cleanFilename("../../evil.docx")).toBe("evil");
    expect(cleanFilename("C:\\Users\\me\\report.docx")).toBe("report");
  });

  it("strips only the LAST extension", () => {
    expect(cleanFilename("archive.tar.gz")).toBe("archive.tar");
  });

  it("returns null when nothing usable remains", () => {
    expect(cleanFilename("")).toBeNull();
    expect(cleanFilename(".txt")).toBeNull();
    expect(cleanFilename("___---.docx")).toBeNull();
  });

  it("truncates at a word boundary (custom max)", () => {
    const stem = "alpha beta gamma delta epsilon zeta";
    const t = cleanFilename(`${stem}.txt`, 20);
    expect(t).toBe("alpha beta gamma");
    expect(t?.length).toBeLessThanOrEqual(20);
  });

  it("hard-truncates when there is no word boundary", () => {
    expect(cleanFilename("alphabeticword.txt", 6)).toBe("alphab");
  });
});

describe("truncateAtWordBoundary", () => {
  it("collapses whitespace and returns short strings unchanged", () => {
    expect(truncateAtWordBoundary("  a   b  ", 10)).toBe("a b");
    expect(truncateAtWordBoundary("short", 10)).toBe("short");
  });

  it("cuts at the last space before the limit", () => {
    expect(truncateAtWordBoundary("alpha beta gamma delta", 16)).toBe("alpha beta gamma");
  });

  it("hard-cuts when no space exists", () => {
    expect(truncateAtWordBoundary("abcdefghijklmnopqrstuvwxyz", 6)).toBe("abcdef");
  });
});

describe("detectLanguage", () => {
  it("detects Persian/Arabic-script text as fa", () => {
    expect(detectLanguage("این یک متن فارسی است")).toBe("fa");
    expect(detectLanguage("اب")).toBe("fa");
  });

  it("detects Latin text as en", () => {
    expect(detectLanguage("This is an English text")).toBe("en");
    expect(detectLanguage("xy")).toBe("en");
  });

  it("picks the dominant script in mixed text", () => {
    expect(detectLanguage("سلام دنیا hello")).toBe("fa");
    expect(detectLanguage("سلام hello world")).toBe("en");
  });

  it("returns null when there is no clear signal", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("x")).toBeNull();
    expect(detectLanguage("12345")).toBeNull();
    expect(detectLanguage("a b c d e f g")).toBe("en");
  });
});

describe("deriveNotebookTitle", () => {
  it("honors a user-provided override (trimmed)", () => {
    expect(deriveNotebookTitle("  My override  ", "candidate")).toBe("My override");
  });

  it("falls back to the first non-empty candidate", () => {
    expect(deriveNotebookTitle(null, null, "  candidate 1 ")).toBe("candidate 1");
    expect(deriveNotebookTitle("", "   ", "candidate 3")).toBe("candidate 3");
  });

  it("falls back to a stable default when nothing is available", () => {
    expect(deriveNotebookTitle(null, null, null)).toBe("Untitled notebook");
    expect(deriveNotebookTitle(null)).toBe("Untitled notebook");
  });

  it("truncates long titles at a word boundary (max 200)", () => {
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
    const t = deriveNotebookTitle(long, null);
    expect(t.length).toBeLessThanOrEqual(200);
    expect(long.startsWith(t.slice(0, 50))).toBe(true);
  });
});
