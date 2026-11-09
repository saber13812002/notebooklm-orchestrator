import { describe, expect, it } from "vitest";
import {
  ALL_INPUT_FORMATS,
  buildInputMatrix,
  inputFormatFromFilename,
} from "../src/input-capabilities.js";

describe("inputFormatFromFilename", () => {
  it("maps known extensions (case-insensitive, basename only)", () => {
    expect(inputFormatFromFilename("a/b/c/notes.TXT")).toBe("txt");
    expect(inputFormatFromFilename("lecture.docx")).toBe("docx");
    expect(inputFormatFromFilename("subs.srt")).toBe("srt");
    expect(inputFormatFromFilename("audio.WAV")).toBe("wav");
    expect(inputFormatFromFilename("mp4a.mp3")).toBe("mp3");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(inputFormatFromFilename("report.PDF")).toBeNull();
    expect(inputFormatFromFilename("noext")).toBeNull();
    expect(inputFormatFromFilename("a.exe")).toBeNull();
  });
});

describe("buildInputMatrix", () => {
  const provider = [
    { format: "text", level: "implemented_tested" },
    { format: "txt", level: "implemented_tested" },
    { format: "srt", level: "implemented_tested" },
    { format: "docx", level: "implemented_tested", note: "extracted to plain text" },
    { format: "wav", level: "implemented_untested_live" },
    { format: "mp3", level: "experimental" },
    { format: "m4a", level: "experimental" },
    { format: "ogg", level: "experimental" },
    { format: "flac", level: "experimental" },
  ];

  it("lists every format exactly once with the provider's level", () => {
    const m = buildInputMatrix(
      { audio: ["wav", "mp3", "m4a", "ogg", "flac"], documents: ["txt", "docx", "srt"] },
      provider,
    );
    expect(m.map((e) => e.format)).toEqual([...ALL_INPUT_FORMATS]);
    expect(m.find((e) => e.format === "wav")).toMatchObject({
      accepted: true,
      level: "implemented_untested_live",
    });
    expect(m.find((e) => e.format === "docx")).toMatchObject({
      accepted: true,
      level: "implemented_tested",
      note: "extracted to plain text",
    });
  });

  it("text is always accepted regardless of file config", () => {
    const m = buildInputMatrix({ audio: [], documents: [] }, provider);
    expect(m.find((e) => e.format === "text")!.accepted).toBe(true);
  });

  it("marks config-restricted formats as not accepted (keeps the provider level)", () => {
    const m = buildInputMatrix({ audio: ["wav"], documents: [] }, provider);
    expect(m.find((e) => e.format === "mp3")!.accepted).toBe(false);
    expect(m.find((e) => e.format === "mp3")!.level).toBe("experimental");
    expect(m.find((e) => e.format === "docx")!.accepted).toBe(false);
    expect(m.find((e) => e.format === "wav")!.accepted).toBe(true);
  });

  it("reports 'unavailable' when the provider does not declare a format", () => {
    const m = buildInputMatrix({ audio: ["wav"], documents: ["txt"] }, [
      { format: "text", level: "implemented_tested" },
    ]);
    expect(m.find((e) => e.format === "wav")!.level).toBe("unavailable");
    expect(m.find((e) => e.format === "txt")!.level).toBe("unavailable");
    expect(m.find((e) => e.format === "text")!.level).toBe("implemented_tested");
  });
});
