/**
 * Fake Python worker for regression tests.
 *
 * Implements the same JSON-line stdio protocol as nbl_worker.py (ping /
 * job / job_text / arbitrary op, response {id, ok, result|error}, optional
 * late response via FAKE_WORKER_DELAY_MS) so WorkerSupervisor can be tested
 * on any machine (Windows included) without the real Python venv.
 *
 * `ping` ALWAYS answers immediately ({version:null, playwright:null}) — the
 * supervisor's start() handshake must succeed so that a mode only kicks in
 * for the actual job operation.
 *
 * Modes are chosen via the FAKE_WORKER_MODE environment variable (applied to
 * non-ping ops):
 *  - ok          (default): respond with {answer:"ok"}
 *  - hang        : never answer (the supervisor's deadline must fire)
 *  - late        : answer after FAKE_WORKER_DELAY_MS (deliberately late)
 *  - crash       : exit(3) immediately, no response
 *  - early-exit  : exit(0) immediately, no response
 *  - die-on-term : ignore SIGTERM and never answer the job op — models a
 *                  worker that hangs and does not die on the first signal;
 *                  the supervisor's escalation/timeout window must bound it
 *                  (Node has no process-group SIGKILL on Windows).
 *
 * Only protocol metadata is ever written to stdout — never params.
 */
import readline from "node:readline";

const MODE = process.env.FAKE_WORKER_MODE ?? "ok";
const DELAY_MS = Number(process.env.FAKE_WORKER_DELAY_MS ?? "0");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id, ok, extra = {}) {
  process.stdout.write(JSON.stringify({ id, ok, ...extra }) + "\n");
}

if (MODE === "die-on-term") {
  // Mimic a worker that does not die on the first signal.
  process.on("SIGTERM", () => {
    /* ignore */
  });
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.id !== "number" || typeof msg.op !== "string") return;

  // Handshake: always succeed, regardless of mode (see header).
  if (msg.op === "ping") {
    respond(msg.id, true, { result: { version: null, playwright: null } });
    return;
  }

  switch (MODE) {
    case "ok":
      respond(msg.id, true, { result: { answer: "ok", op: msg.op } });
      break;
    case "hang":
      break; // deliberately never respond
    case "late":
      setTimeout(() => {
        respond(msg.id, true, { result: { answer: "late", op: msg.op } });
      }, DELAY_MS);
      break;
    case "crash":
      process.exit(3);
      break;
    case "early-exit":
      process.exit(0);
      break;
    case "die-on-term":
      // Never answer the job op AND ignore SIGTERM: the supervisor must
      // bound this with its request deadline + close() escalation window.
      break;
    default:
      respond(msg.id, true, { result: { answer: "ok", op: msg.op } });
  }
});

rl.on("close", () => {
  // stdin EOF: clean shutdown (same contract as nbl_worker.py).
  process.exit(0);
});
