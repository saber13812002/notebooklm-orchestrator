import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * NLO-P2: audio artifact validation — content-based, never extension-based.
 *
 * `sniffAudioMime` reads only the first 16 bytes of a file and decides the
 * audio type from its binary signature:
 *   - `RIFF....WAVE` header  -> audio/wav (PCM)
 *   - MPEG frame sync bits or an `ID3` tag -> audio/mpeg (MP3)
 *   - MP4 `ftyp` box at offset 4 -> audio/mp4 (M4A/AAC family)
 *
 * Anything else (including a truncated header) is `null` — the file is not a
 * recognizable audio artifact and must not be treated as one.
 */
export function sniffAudioMime(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n < 12) return null;
    if (
      buf[0] === 0x52 && // R
      buf[1] === 0x49 && // I
      buf[2] === 0x46 && // F
      buf[3] === 0x46 && // F
      buf[8] === 0x57 && // W
      buf[9] === 0x41 && // A
      buf[10] === 0x56 && // V
      buf[11] === 0x45 // E
    ) {
      return "audio/wav";
    }
    // MPEG frame sync: 11 set bits (0xFF followed by 0xE0..0xFF)
    if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
    // ID3v2 tag prefix ("ID3")
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio/mpeg";
    // MP4 family: 4-byte size, then "ftyp"
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
      return "audio/mp4";
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Map a sniffed audio MIME type to its canonical file extension. */
export function audioMimeToExt(mime: string): string {
  switch (mime) {
    case "audio/wav":
      return ".wav";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    default:
      return ".bin";
  }
}

/**
 * NLO-P2: minimal WAV (RIFF) header parser for stored audio artifacts.
 *
 * Walks the RIFF chunk list to locate the `fmt ` and `data` chunks (extra
 * chunks such as LIST or fact are skipped — never assumed at a fixed
 * offset) and derives the decode metadata from the header itself, not from
 * the file name. Returns `null` for anything that is not a structurally
 * valid PCM/IEEE-float WAV: truncated header, missing or zero-length
 * chunks, or a zero sample rate / channel count / bit count.
 */
export interface WavInfo {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** "PCM" for formatTag 1, "FLOAT" for 3, "FORMAT_<n>" otherwise. */
  codec: string;
}

export function readWavInfo(file: string): WavInfo | null {
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    if (st.size < 44) return null;
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }

    let formatTag: number | null = null;
    let channels: number | null = null;
    let sampleRate: number | null = null;
    let bitsPerSample: number | null = null;
    let dataSize = 0;

    let pos = 12;
    while (pos + 8 <= st.size && (formatTag === null || dataSize === 0)) {
      const ch = Buffer.alloc(8);
      if (readSync(fd, ch, 0, 8, pos) < 8) return null;
      const tag = ch.toString("ascii", 0, 4);
      const len = ch.readUInt32LE(4);
      const payloadStart = pos + 8;
      const payload = Math.min(len, st.size - payloadStart);
      if (tag === "fmt ") {
        const fmt = Buffer.alloc(16);
        if (readSync(fd, fmt, 0, 16, payloadStart) < 16) return null;
        formatTag = fmt.readUInt16LE(0);
        channels = fmt.readUInt16LE(2);
        sampleRate = fmt.readUInt32LE(4);
        bitsPerSample = fmt.readUInt16LE(14);
      } else if (tag === "data") {
        dataSize = len;
      }
      pos = payloadStart + payload + (payload % 2);
    }

    if (
      formatTag === null ||
      sampleRate === null ||
      channels === null ||
      bitsPerSample === null ||
      sampleRate <= 0 ||
      channels <= 0 ||
      bitsPerSample <= 0 ||
      dataSize <= 0
    ) {
      return null;
    }
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    return {
      durationSeconds: dataSize / bytesPerSecond,
      sampleRate,
      channels,
      codec: formatTag === 1 ? "PCM" : formatTag === 3 ? "FLOAT" : `FORMAT_${formatTag}`,
    };
  } finally {
    closeSync(fd);
  }
}
