import { describe, expect, it } from "vitest";
import { parseSrt } from "../src/srt.js";

const VALID = `1
00:00:01,000 --> 00:00:02,500
Hello world
This is the first cue

2
00:00:03,000 --> 00:00:04,000
Second line
`;

describe("parseSrt", () => {
  it("parses a valid SRT with multiple cues (timing in ms, text preserved)", () => {
    const r = parseSrt(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cueCount).toBe(2);
    expect(r.cues[0]).toMatchObject({
      index: 1,
      startMs: 1000,
      endMs: 2500,
      text: "Hello world\nThis is the first cue",
    });
    expect(r.cues[1]).toMatchObject({ index: 2, startMs: 3000, endMs: 4000, text: "Second line" });
    expect(r.firstText).toBe("Hello world\nThis is the first cue");
  });

  it("accepts CRLF line endings and a UTF-8 BOM", () => {
    const r = parseSrt("1\r\n00:00:00,000 --> 00:00:01,000\r\nسلام\r\n");
    expect(r).toMatchObject({ ok: true, cueCount: 1, firstText: "سلام" });
  });

  it("accepts a dot as the milliseconds separator", () => {
    const r = parseSrt("1\n00:00:00.500 --> 00:00:01.000\ntext\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cues[0]!.startMs).toBe(500);
  });

  it("rejects a missing or invalid index line with a reason naming the index", () => {
    expect(parseSrt("00:00:00,000 --> 00:00:01,000\ntext\n").ok).toBe(false);
    expect(parseSrt("x\n00:00:00,000 --> 00:00:01,000\ntext\n").ok).toBe(false);
    const r = parseSrt("abc\n00:00:00,000 --> 00:00:01,000\ntext\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("index");
  });

  it("rejects malformed timing (missing milliseconds or wrong arrow)", () => {
    expect(parseSrt("1\n00:00:00 --> 00:00:01\ntext\n").ok).toBe(false);
    expect(parseSrt("1\n00:00:01,000 <-- 00:00:00,000\ntext\n").ok).toBe(false);
    const r = parseSrt("1\nbad timing\ntext\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("timing");
  });

  it("rejects a cue whose end is before its start", () => {
    const r = parseSrt("1\n00:00:02,000 --> 00:00:01,000\ntext\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("before");
  });

  it("rejects a cue with no dialogue text", () => {
    const r = parseSrt("1\n00:00:00,000 --> 00:00:01,000\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("text");
  });

  it("rejects empty / whitespace-only input", () => {
    expect(parseSrt("").ok).toBe(false);
    expect(parseSrt("   \n  \n ").ok).toBe(false);
  });
});
