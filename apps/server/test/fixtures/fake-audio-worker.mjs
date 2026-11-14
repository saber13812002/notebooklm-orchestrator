/**
 * Fake Python worker for the NLO-P2 audio ops (generateAudio /
 * getAudioStatus / downloadAudio) — speaks the same JSON-line stdio
 * protocol as nbl_worker.py, but answers the audio ops with the real
 * result SHAPES so the TS provider can be tested without a Python venv.
 *
 * `ping` ALWAYS answers immediately (handshake). Audio ops honor
 * FAKE_WORKER_MODE:
 *  - ok (default): audio_generate -> task_abc123 (in_progress, not resumed);
 *                  audio_status   -> completed (with metadata);
 *                  audio_download -> ready file (test writes nothing; the
 *                  provider only checks the payload — the app verifies the
 *                  file separately in artifact tests).
 *  - resumed:      audio_generate -> resumed task kept (status in_progress).
 *  - resubmit:     audio_generate -> resumed=false, priorStatus="failed".
 *  - not-ready:    audio_download -> ready:false (artifactStatus in_progress).
 *  - not-found:    audio_download -> error {code:"not_found"}.
 *  - hang:         never answers (supervisor deadline must fire).
 *  - auth:         error {code:"auth"} on any audio op.
 *  - timeout:      error {code:"timeout"} on any audio op.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MODE = process.env.FAKE_WORKER_MODE ?? "ok";
const CHECKED = new Date().toISOString();

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id, ok, extra = {}) {
  process.stdout.write(JSON.stringify({ id, ok, ...extra }) + "\n");
}

const STATUS_BASE = {
  url: null,
  error: null,
  errorCode: null,
  metadata: null,
  isComplete: false,
  isFailed: false,
  isTerminal: false,
  isNotFound: false,
  isRateLimited: false,
};

function generatePayload(msg) {
  switch (MODE) {
    case "resumed":
      return {
        email: "fake@example.com",
        notebookId: msg.params.notebookId,
        resumed: true,
        priorStatus: "in_progress",
        taskId: "task_prior999",
        status: "in_progress",
        ...STATUS_BASE,
        instructionsProvided: true,
        checkedAt: CHECKED,
      };
    case "resubmit":
      return {
        email: "fake@example.com",
        notebookId: msg.params.notebookId,
        resumed: false,
        priorStatus: "failed",
        taskId: "task_new777",
        status: "pending",
        ...STATUS_BASE,
        instructionsProvided: false,
        checkedAt: CHECKED,
      };
    default:
      return {
        email: "fake@example.com",
        notebookId: msg.params.notebookId,
        resumed: false,
        priorStatus: null,
        taskId: "task_abc123",
        status: "pending",
        ...STATUS_BASE,
        instructionsProvided: Boolean(msg.params.prompt && String(msg.params.prompt).trim()),
        checkedAt: CHECKED,
      };
  }
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.id !== "number" || typeof msg.op !== "string") return;

  if (msg.op === "ping") {
    respond(msg.id, true, { result: { version: "fake", playwright: true } });
    return;
  }

  switch (MODE) {
    case "hang":
      return; // never respond
    case "auth":
      return respond(msg.id, false, { error: { code: "auth", message: "fake: session rejected" } });
    case "timeout":
      return respond(msg.id, false, {
        error: { code: "timeout", message: "fake: operation timed out" },
      });
  }

  if (msg.op === "audio_generate") {
    respond(msg.id, true, { result: generatePayload(msg) });
  } else if (msg.op === "audio_status") {
    respond(msg.id, true, {
      result: {
        notebookId: msg.params.notebookId,
        taskId: msg.params.taskId,
        status: "completed",
        ...STATUS_BASE,
        isComplete: true,
        isTerminal: true,
        metadata: { simulated: true, durationSeconds: 60 },
        checkedAt: CHECKED,
      },
    });
  } else if (msg.op === "audio_download") {
    if (MODE === "not-ready") {
      respond(msg.id, true, {
        result: {
          ready: false,
          notebookId: msg.params.notebookId,
          artifactId: msg.params.artifactId,
          artifactStatus: "in_progress",
          checkedAt: CHECKED,
        },
      });
    } else if (MODE === "not-found") {
      respond(msg.id, false, {
        error: { code: "not_found", message: "audio artifact not found: fake" },
      });
    } else {
      // Write a real file so the app-side verification is exercisable too.
      const dest = msg.params.destPath;
      if (dest) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "fake-audio-payload");
      }
      respond(msg.id, true, {
        result: {
          ready: true,
          notebookId: msg.params.notebookId,
          artifactId: msg.params.artifactId,
          path: dest,
          size: 18,
          sha256: "abc123def456",
          durationSeconds: 60,
          artifactTitle: "Fake Podcast",
          artifactStatus: "completed",
          checkedAt: CHECKED,
        },
      });
    }
  }
});

rl.on("close", () => process.exit(0));
