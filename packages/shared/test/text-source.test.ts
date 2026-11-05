import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASTER_PROMPT_VERSION,
  MASTER_PROMPT_VERSIONS,
  deriveTitleFromText,
  resolveMasterPrompt,
} from "../src/index.js";

describe("resolveMasterPrompt", () => {
  it("returns the default versioned master prompt (v1) when no prompt is given", () => {
    for (const requested of [undefined, null, "", "   "]) {
      const r = resolveMasterPrompt(requested);
      expect(r.version).toBe("v1");
      expect(r.version).toBe(DEFAULT_MASTER_PROMPT_VERSION);
      expect(r.text).toBe(MASTER_PROMPT_VERSIONS["v1"]!.text);
    }
  });

  it("uses the caller's prompt verbatim as version `custom`", () => {
    const r = resolveMasterPrompt("My own prompt");
    expect(r).toEqual({ version: "custom", text: "My own prompt" });
  });

  it("keeps the v1 prompt bilingual and structured", () => {
    const v1 = MASTER_PROMPT_VERSIONS["v1"]!;
    expect(v1.text).toContain("Persian source -> Persian summary");
    expect(v1.text).toContain("English source -> English summary");
    expect(v1.text).toContain("Do not invent facts");
  });
});

describe("deriveTitleFromText", () => {
  it("takes the first non-empty line and collapses whitespace", () => {
    expect(deriveTitleFromText("   \n\n  Hello    World\nbody")).toBe("Hello World");
  });

  it("keeps the title when it fits the limit", () => {
    expect(deriveTitleFromText("A short title")).toBe("A short title");
  });

  it("truncates at a word boundary when possible (max 80 chars)", () => {
    // Space at index 79 (the boundary) -> cut there.
    expect(deriveTitleFromText("a".repeat(79) + " rest")).toBe("a".repeat(79));
  });

  it("hard-truncates to the limit when no word boundary fits", () => {
    expect(deriveTitleFromText("a".repeat(90))).toBe("a".repeat(80));
  });

  it("honors a custom max length", () => {
    expect(deriveTitleFromText("abcdefghij rest", 10)).toBe("abcdefghij");
  });

  it("falls back to a stable name when the text is empty or blank", () => {
    expect(deriveTitleFromText("")).toBe("Untitled text source");
    expect(deriveTitleFromText("\n  \n\t\n")).toBe("Untitled text source");
  });
});
