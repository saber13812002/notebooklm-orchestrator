import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/app-context.js";
import { addAccount, addNode, dataPathsFor, makeAppContext, markHealthy } from "./helpers.js";
import { buildApp } from "../src/api/server.js";

/**
 * Phase 3.1: document sources (txt/docx/srt) on the file path.
 *
 * A document upload is validated (extension, size, structure), extracted to
 * plain text (DOCX via mammoth, SRT validated then submitted verbatim, TXT
 * verbatim), and submitted as a NotebookLM text source. Rejections carry
 * distinct codes: invalid_srt, invalid_docx; everything else validation.
 * All tests run in-process against the mock provider (no live NotebookLM).
 */

interface RunningApp {
  ctx: AppContext;
  app: FastifyInstance;
  stop(): Promise<void>;
}

async function startApp(env: Record<string, string> = {}): Promise<RunningApp> {
  const ctx = await makeAppContext(env);
  const app = await buildApp(ctx);
  await app.ready();
  return {
    ctx,
    app,
    stop: async () => {
      await app.close();
      await ctx.close();
    },
  };
}

let running: RunningApp | null = null;
afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

/** Build a raw multipart body (fields + binary files with explicit field names). */
function multipartBody(
  fields: Record<string, string>,
  files: { field: string; filename: string; contentType: string; data: Buffer }[],
): { body: Buffer; contentType: string } {
  const boundary = `----nlo-test-${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\ncontent-type: ${f.contentType}\r\n\r\n`,
        ),
        f.data,
        Buffer.from("\r\n"),
      ]),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload a document via POST /api/jobs and return the response. */
async function uploadDoc(app: FastifyInstance, filename: string, data: Buffer, extra = {}) {
  const fields: Record<string, string> = {};
  const m = multipartBody(fields, [
    {
      field: "source",
      filename,
      contentType: "application/octet-stream",
      data,
      ...extra,
    },
  ]);
  return app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "content-type": m.contentType },
    payload: m.body,
  });
}

async function uploadWithFields(
  app: FastifyInstance,
  fields: Record<string, string>,
  files: { field: string; filename: string; data: Buffer }[],
) {
  const m = multipartBody(
    fields,
    files.map((f) => ({ ...f, contentType: "application/octet-stream" })),
  );
  return app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "content-type": m.contentType },
    payload: m.body,
  });
}

// ---------------------------------------------------------------------------
// Minimal DOCX fixture builder (no external dependency): a ZIP with stored
// entries for [Content_Types].xml, _rels/.rels and word/document.xml.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // method: stored
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0x21, 12); // mod date (non-zero)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18); // compressed size
    lh.writeUInt32LE(e.data.length, 22); // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    local.push(Buffer.concat([lh, name, e.data]));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0x21, 14); // date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, name]));
    offset += 30 + name.length + e.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

function makeDocx(xmlText: string): Buffer {
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xmlText}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
}

const SRT_OK = `1
00:00:01,000 --> 00:00:02,500
Hello world
This is the first cue

2
00:00:03,000 --> 00:00:04,000
Second line
`;

describe("POST /api/jobs with a document source (Phase 3.1)", () => {
  it("accepts a DOCX, extracts the text, and creates a text job", async () => {
    running = await startApp();
    const res = await uploadDoc(
      running.app,
      "تفسیر موضوعی عدالت — جلسه اول.docx",
      makeDocx("Hello from docx"),
    );
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    const job = detail.json();
    expect(job.input.inputType).toBe("text");
    expect(job.input.text.charCount).toBeGreaterThanOrEqual("Hello from docx".length);
    // Title comes from the cleaned Persian filename.
    expect(job.input.title).toBe("تفسیر موضوعی عدالت — جلسه اول");
    // No caller prompt -> the versioned default master prompt (v1).
    expect(job.input.promptVersion).toBe("v1");

    // The extracted text is stored in the archive (input/text-source.md).
    const textFile = path.join(
      dataPathsFor(running.ctx.config.dataDir).jobsDir,
      job.id,
      "input",
      "text-source.md",
    );
    expect(existsSync(textFile)).toBe(true);
    expect(readFileSync(textFile, "utf8")).toContain("Hello from docx");

    // The GET detail (fetched above) exposes inputType + detected language.
    expect(job.input.inputType).toBe("text");
    expect(job.input.language).toBe("en");
  });

  it("accepts a TXT file (verbatim, BOM-stripped) and rejects nothing else", async () => {
    running = await startApp();
    const res = await uploadDoc(running.app, "notes.txt", Buffer.from("\uFEFFPlain text here"));
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    const job = detail.json();
    expect(job.input.inputType).toBe("text");
    const textFile = path.join(
      dataPathsFor(running.ctx.config.dataDir).jobsDir,
      job.id,
      "input",
      "text-source.md",
    );
    const stored = readFileSync(textFile, "utf8");
    expect(stored).toBe("Plain text here");
    expect(job.input.title).toBe("notes");
  });

  it("accepts an SRT, preserves the original (timestamps) and titles from the first cue", async () => {
    running = await startApp();
    const res = await uploadDoc(running.app, "subtitles.srt", Buffer.from(SRT_OK));
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    const job = detail.json();
    expect(job.input.inputType).toBe("text");
    expect(job.input.language).toBe("en");
    // The whole SRT (with timestamps) is submitted verbatim as the source.
    const textFile = path.join(
      dataPathsFor(running.ctx.config.dataDir).jobsDir,
      job.id,
      "input",
      "text-source.md",
    );
    expect(readFileSync(textFile, "utf8")).toBe(SRT_OK.trim());
    // Title: no user title, filename "subtitles" wins over the cue text.
    expect(job.input.title).toBe("subtitles");
  });

  it("uses the first cue text as a title candidate when the filename is unusable", async () => {
    running = await startApp();
    const res = await uploadDoc(running.app, ".srt", Buffer.from(SRT_OK));
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().input.title).toBe("Hello world This is the first cue");
  });

  it("honors the user-provided title override", async () => {
    running = await startApp();
    const res = await uploadWithFields(running.app, { title: "My custom title" }, [
      { field: "source", filename: "whatever.docx", data: makeDocx("x") },
    ]);
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().input.title).toBe("My custom title");
  });

  it("rejects an unknown document extension (.pdf, .exe) with a validation error", async () => {
    running = await startApp();
    for (const name of ["report.pdf", "evil.exe"]) {
      const res = await uploadDoc(running.app, name, Buffer.from("data"));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  });

  it("rejects a corrupted DOCX with the distinct invalid_docx code", async () => {
    running = await startApp();
    const res = await uploadDoc(running.app, "broken.docx", Buffer.from("this is not a zip file"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_docx");
  });

  it("rejects malformed SRT with the distinct invalid_srt code", async () => {
    running = await startApp();
    const bad = [
      "no index line timing\ntext\n", // missing index
      "1\nbad timing\ntext\n", // bad timing
      "1\n00:00:02,000 --> 00:00:01,000\ntext\n", // end before start
      "1\n00:00:00,000 --> 00:00:01,000\n", // no dialogue text
    ];
    for (const s of bad) {
      const res = await uploadDoc(running.app, "bad.srt", Buffer.from(s));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_srt");
    }
  });

  it("rejects a DOCX that contains no text (document contains no text)", async () => {
    running = await startApp();
    const res = await uploadDoc(running.app, "empty.docx", makeDocx(""));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(res.json().error.message).toContain("no text");
  });

  it("rejects a zero-byte document and enforces the size limit (413)", async () => {
    running = await startApp({ NLO_MAX_UPLOAD_BYTES: "10" });
    const zero = await uploadDoc(running.app, "zero.txt", Buffer.alloc(0));
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.message).toContain("empty");
    const big = await uploadDoc(running.app, "big.txt", Buffer.from("0123456789abcdef"));
    expect(big.statusCode).toBe(413);
  });

  it("neutralizes a traversal filename: no path components ever reach the job", async () => {
    running = await startApp();
    // The multipart parser (secureFileName) basenames the part filename before
    // it reaches the handler, and the handler's safeName check is a second
    // layer: the PERSISTED original name must never carry path components.
    const res = await uploadDoc(running.app, "../../evil.docx", makeDocx("x"));
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const detail = await running.app.inject({ method: "GET", url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    const originalName = detail.json().input.text.originalName;
    expect(originalName).not.toContain("/");
    expect(originalName).not.toContain("\\");
    expect(originalName).not.toContain("..");
    // The safe base name (no path components) is what gets persisted.
    expect(originalName.endsWith("evil.docx")).toBe(true);
  });

  it("rejects providing BOTH an audio file and a source document", async () => {
    running = await startApp();
    const m = multipartBody({ prompt: "summarize" }, [
      {
        field: "audio",
        filename: "a.wav",
        contentType: "audio/wav",
        data: Buffer.from("RIFF...."),
      },
      {
        field: "source",
        filename: "n.txt",
        contentType: "text/plain",
        data: Buffer.from("hello"),
      },
    ]);
    const res = await running.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "content-type": m.contentType },
      payload: m.body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("keeps the audio path's prompt requirement (no prompt + no source -> 400)", async () => {
    running = await startApp();
    const m = multipartBody({}, [
      {
        field: "audio",
        filename: "a.wav",
        contentType: "audio/wav",
        data: Buffer.from("RIFF...."),
      },
    ]);
    const res = await running.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "content-type": m.contentType },
      payload: m.body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("prompt is required");
  });
});

describe("GET /api/provider input capability matrix (Phase 3.1)", () => {
  it("lists every input format with honest levels and acceptance", async () => {
    running = await startApp();
    const res = await running.app.inject({ method: "GET", url: "/api/provider" });
    expect(res.statusCode).toBe(200);
    const inputs = res.json().inputs;
    expect(inputs.map((i: { format: string }) => i.format)).toEqual([
      "text",
      "txt",
      "docx",
      "srt",
      "wav",
      "mp3",
      "m4a",
      "ogg",
      "flac",
    ]);
    for (const f of inputs) expect(f.accepted).toBe(true);
    const docx = inputs.find((i: { format: string }) => i.format === "docx");
    expect(docx.level).toBe("implemented_tested");
    expect(docx.note).toBeTruthy();
  });

  it("reflects config restrictions in the matrix (accepted=false, level kept)", async () => {
    running = await startApp({ NLO_ALLOWED_DOCUMENT_EXTENSIONS: "txt" });
    const res = await running.app.inject({ method: "GET", url: "/api/provider" });
    const inputs = res.json().inputs;
    expect(inputs.find((i: { format: string }) => i.format === "docx").accepted).toBe(false);
    expect(inputs.find((i: { format: string }) => i.format === "srt").accepted).toBe(false);
    expect(inputs.find((i: { format: string }) => i.format === "txt").accepted).toBe(true);
    expect(inputs.find((i: { format: string }) => i.format === "docx").level).toBe(
      "implemented_tested",
    );
  });
});

describe("E2E (in-process, mock provider): document job runs to SUCCEEDED", () => {
  it("DOCX -> SUCCEEDED with notebook/source ids and mock provenance", async () => {
    running = await startApp();
    const { ctx, app } = running;
    addAccount(ctx.accounts, "acct1");
    const { id: n } = addNode(ctx.proxies, ctx.vault, "node1");
    markHealthy(ctx.proxies, n);

    const created = await uploadDoc(app, "lecture-notes.docx", makeDocx("Persian lesson text"));
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id;
    const job = await ctx.runner.run(jobId);
    expect(job.status).toBe("SUCCEEDED");
    expect(job.notebookId).toMatch(/^mock_nb_/);
    expect(job.sourceId).toMatch(/^mock_src_/);
    expect(job.resultProvenance).toBe("mock");

    const result = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/result` });
    expect(result.statusCode).toBe(200);
    const r = result.json();
    expect(r.notebook.id).toBe(job.notebookId);
    expect(r.notebook.shareUrl).toBeNull(); // honest: no share capability
    expect(r.summary.promptVersion).toBe("v1");
  });
});
