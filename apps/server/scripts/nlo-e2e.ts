/**
 * nlo-e2e — external E2E acceptance runner for NotebookLM Orchestrator (NLO-P1).
 *
 * Acts as a third-party client: it talks to the HTTP API only (no database, no
 * direct domain-service calls), polls the job, reads events/attempts, downloads
 * the artifact, verifies its digest and emits a machine-readable report.
 *
 * Usage:
 *   NLO_API_BASE=https://host NLO_API_TOKEN=... npx tsx scripts/nlo-e2e.ts --scenario text --text-file ./sample.txt
 *   NLO_API_BASE=... --scenario audio --audio-file ./small.m4a
 *   NLO_API_BASE=... --scenario podcast --text-file ./sample.txt [--podcast-format deep_dive]
 *   NLO_API_BASE=... --scenario monitor --job-id j_...
 *
 * The podcast scenario exercises the text -> notebook -> deep-dive podcast ->
 * audio artifact pipeline. Against a mock provider the run is accepted as
 * MOCK_PROVIDER_INTEGRATION_VERIFIED (never PASS): the full integration is
 * exercised, only the provider boundary is simulated.
 *
 * Exit codes: 0 PASS or MOCK_PROVIDER_INTEGRATION_VERIFIED · 1 FAIL ·
 * 2 BLOCKED/NOT_TESTED · 3 bad usage.
 * The token is never printed or written to the report.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

import {
  SCENARIO_STAGES,
  classifyFailure,
  completeStage,
  createTestRun,
  evaluateAcceptance,
  isTerminalStatus,
  observeJobStatus,
  recordError,
  startStage,
  validateArtifact,
  type E2EArtifactRef,
  type E2EScenarioId,
  type E2ETestRun,
} from "@nlo/shared";

const V1 = "/api/v1";

interface Args {
  base: string;
  scenario: E2EScenarioId;
  textFile?: string;
  audioFile?: string;
  jobId?: string;
  pollMs: number;
  timeoutMs: number;
  stallMs: number;
  out?: string;
  field: string;
  minBytes?: number;
  expectMime?: string;
  prompt?: string;
  podcastFormat?: string;
  podcastLanguage?: string;
  podcastLength?: string;
  podcastInstructions?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const rawScenario = get("scenario") ?? "text";
  const aliases: Record<string, E2EScenarioId> = {
    text: "text-to-notebook",
    audio: "audio-upload",
    monitor: "job-monitor",
    podcast: "text-to-podcast",
  };
  const scenario = aliases[rawScenario] ?? (rawScenario as E2EScenarioId);
  if (!(scenario in SCENARIO_STAGES)) {
    throw new Error(`unknown --scenario: ${rawScenario}`);
  }
  return {
    base: (get("base") ?? process.env.NLO_API_BASE ?? "").replace(/\/+$/, ""),
    scenario,
    textFile: get("text-file"),
    audioFile: get("audio-file"),
    jobId: get("job-id"),
    pollMs: num(get("poll-ms") ?? process.env.NLO_E2E_POLL_MS, 3000),
    timeoutMs: num(get("timeout-ms") ?? process.env.NLO_E2E_TIMEOUT_MS, 20 * 60_000),
    stallMs: num(get("stall-ms"), 6 * 60_000),
    out: get("out"),
    field: get("field") ?? "file",
    minBytes: get("min-bytes") ? num(get("min-bytes"), 0) : undefined,
    expectMime: get("expect-mime"),
    prompt: get("prompt"),
    podcastFormat: get("podcast-format"),
    podcastLanguage: get("podcast-language"),
    podcastLength: get("podcast-length"),
    podcastInstructions: get("podcast-instructions"),
  };
}

const token = (): string => {
  const t = process.env.NLO_API_TOKEN;
  if (!t) throw new Error("NLO_API_TOKEN is not set (never pass tokens on the command line)");
  return t;
};

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token()}`, ...extra };
}

const now = (): string => new Date().toISOString();
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Fetches the OpenAPI document and refuses to run against an unexpected contract. */
async function assertContract(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${V1}/openapi.json`, { headers: authHeaders() });
  if (!res.ok) {
    throw Object.assign(new Error(`openapi.json -> HTTP ${res.status}`), { status: res.status });
  }
  const doc = (await res.json()) as { paths?: Record<string, unknown> };
  const required = [
    "/notebooks/from-text",
    "/jobs/{id}",
    "/jobs/{id}/events",
    "/jobs/{id}/attempts",
    "/jobs/{id}/artifacts",
  ];
  const missing = required.filter((p) => !doc.paths?.[p]);
  if (missing.length > 0) {
    throw new Error(`contract mismatch, missing paths: ${missing.join(", ")}`);
  }
  return doc as Record<string, unknown>;
}

interface JobView {
  id: string;
  status: string;
  progress?: number;
  errorClass?: string | null;
  errorMessage?: string | null;
  updatedAt?: string;
  finishedAt?: string | null;
  notebookId?: string | null;
  sourceId?: string | null;
  resultProvenance?: string;
  attempt?: number;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { headers: authHeaders() });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function listArtifacts(raw: unknown): Array<{
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  source: "provider" | "application";
}> {
  const obj = raw as Record<string, unknown> | null;
  const arr = Array.isArray(raw) ? raw : (obj?.artifacts ?? obj?.items ?? []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      id: String(a.id ?? ""),
      filename: String(a.filename ?? ""),
      mediaType: String(a.mediaType ?? ""),
      size: Number(a.size ?? 0),
      source: a.source === "provider" ? ("provider" as const) : ("application" as const),
    }));
}

async function runText(run: E2ETestRun, args: Args): Promise<void> {
  const text = await readFile(resolve(args.textFile!), "utf8");
  startStage(run, "create_job", now());
  const res = await fetch(`${args.base}${V1}/notebooks/from-text`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      text,
      ...(args.prompt ? { prompt: args.prompt } : {}),
      ...(args.scenario === "text-to-podcast"
        ? {
            podcast: {
              enabled: true,
              ...(args.podcastInstructions ? { instructions: args.podcastInstructions } : {}),
              ...(args.podcastLanguage ? { language: args.podcastLanguage } : {}),
              ...(args.podcastFormat ? { format: args.podcastFormat } : {}),
              ...(args.podcastLength ? { length: args.podcastLength } : {}),
            },
          }
        : {}),
    }),
  });
  const bodyText = await res.text();
  if (res.status !== 202 && res.status !== 200) {
    const cls = classifyFailure({ httpStatus: res.status });
    recordError(run, {
      code: cls.code,
      message: `from-text -> HTTP ${res.status}`,
      at: now(),
      stage: "create_job",
      failure_class: null,
      http_status: res.status,
      retryable: cls.retryable,
    });
    return;
  }
  const body = JSON.parse(bodyText) as { id?: string; jobId?: string };
  run.job_id = body.id ?? body.jobId ?? null;
  if (!run.job_id) {
    recordError(run, {
      code: "E2E_CONTRACT_MISMATCH",
      message: "202 response without job id",
      at: now(),
      stage: "create_job",
      failure_class: null,
      http_status: res.status,
      retryable: false,
    });
    return;
  }
  completeStage({
    run,
    stage: "create_job",
    at: now(),
    checkpoint: "job_created",
    externalOperationId: run.job_id,
  });
}

async function runAudio(run: E2ETestRun, args: Args): Promise<void> {
  const bytes = await readFile(resolve(args.audioFile!));
  startStage(run, "upload_file", now());
  const form = new FormData();
  form.append(args.field, new Blob([bytes]), basename(args.audioFile!));
  const res = await fetch(`${args.base}${V1}/jobs`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  const text = await res.text();
  if (res.status !== 202 && res.status !== 200) {
    const cls = classifyFailure({ httpStatus: res.status });
    recordError(run, {
      code: cls.code,
      message: `jobs upload -> HTTP ${res.status}`,
      at: now(),
      stage: "upload_file",
      failure_class: null,
      http_status: res.status,
      retryable: cls.retryable,
    });
    return;
  }
  const body = JSON.parse(text) as { id?: string; jobId?: string };
  run.job_id = body.id ?? body.jobId ?? null;
  if (!run.job_id) {
    recordError(run, {
      code: "E2E_CONTRACT_MISMATCH",
      message: "upload response without job id",
      at: now(),
      stage: "upload_file",
      failure_class: null,
      http_status: res.status,
      retryable: false,
    });
    return;
  }
  completeStage({
    run,
    stage: "upload_file",
    at: now(),
    checkpoint: "job_created",
    externalOperationId: run.job_id,
  });
}

/** Polls the job; returns the final JobView (or the last one seen). */
async function pollJob(run: E2ETestRun, args: Args): Promise<JobView | null> {
  if (!run.job_id) return null;
  const started = Date.now();
  let last: JobView | null = null;
  let lastChange = Date.now();
  let lastStatus = "";
  for (;;) {
    const { status, body } = await getJson<JobView>(`${args.base}${V1}/jobs/${run.job_id}`);
    if (status === 401 || status === 403) {
      const cls = classifyFailure({ httpStatus: status });
      recordError(run, {
        code: cls.code,
        message: `job poll -> HTTP ${status}`,
        at: now(),
        stage: "queue_wait",
        failure_class: null,
        http_status: status,
        retryable: false,
      });
      return last;
    }
    if (body && typeof body.status === "string") {
      last = body;
      observeJobStatus(run, body.status as never, now());
      if (body.status !== lastStatus) {
        lastStatus = body.status;
        lastChange = Date.now();
      }
      if (typeof body.attempt === "number") run.attempts_observed = body.attempt;
      if (isTerminalStatus(body.status as never)) return last;
    }
    if (Date.now() - started > args.timeoutMs) {
      recordError(run, {
        code: "E2E_TIMEOUT",
        message: `job did not finish within ${args.timeoutMs}ms`,
        at: now(),
        stage: null,
        failure_class: null,
        http_status: null,
        retryable: true,
      });
      return last;
    }
    if (Date.now() - lastChange > args.stallMs && last) {
      const cls = classifyFailure({
        stalledForMs: Date.now() - lastChange,
        stallThresholdMs: args.stallMs,
      });
      recordError(run, {
        code: cls.code,
        message: `no status change for ${Math.round((Date.now() - lastChange) / 1000)}s (status=${last.status})`,
        at: now(),
        stage: null,
        failure_class: (last.errorClass as never) ?? null,
        http_status: null,
        retryable: false,
      });
      return last;
    }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

async function collectEvidence(run: E2ETestRun, args: Args, job: JobView | null): Promise<void> {
  if (!run.job_id) return;

  // Stage bookkeeping must be scenario-aware: only touch stages that the
  // scenario actually declares (and that are not already finished).
  const stageState = (name: string): string | null =>
    run.stages.find((s) => s.stage === name)?.state ?? null;
  const stageAbsent = (name: string): boolean => !run.stages.some((s) => s.stage === name);

  const cj = stageState("create_job");
  if (cj !== null && cj !== "PASSED" && cj !== "FAILED") {
    startStage(run, "create_job", run.started_at);
    completeStage({
      run,
      stage: "create_job",
      at: now(),
      checkpoint: "job_created",
      externalOperationId: run.job_id,
    });
  }

  const events = await getJson<unknown>(`${args.base}${V1}/jobs/${run.job_id}/events`);
  if (events.status !== 200) {
    const cls = classifyFailure({ httpStatus: events.status });
    recordError(run, {
      code: cls.code,
      message: `events -> HTTP ${events.status}`,
      at: now(),
      stage: stageAbsent("events_timeline") ? null : "events_timeline",
      failure_class: null,
      http_status: events.status,
      retryable: cls.retryable,
    });
  } else if (!stageAbsent("events_timeline")) {
    completeStage({ run, stage: "events_timeline", at: now(), checkpoint: "events_read" });
  }

  const attempts = await getJson<unknown>(`${args.base}${V1}/jobs/${run.job_id}/attempts`);
  if (attempts.status === 200) {
    const arr = Array.isArray(attempts.body) ? attempts.body : [];
    run.attempts_observed = Math.max(run.attempts_observed, arr.length);
    if (!stageAbsent("attempts_read")) {
      completeStage({ run, stage: "attempts_read", at: now(), checkpoint: "attempts_read" });
    }
  }

  if (job) {
    run.provenance =
      job.resultProvenance === "real" || job.resultProvenance === "mock"
        ? job.resultProvenance
        : "unknown";
    const nb = run.stages.find((s) => s.stage === "notebook_created");
    if (nb && job.notebookId) {
      completeStage({
        run,
        stage: "notebook_created",
        at: now(),
        externalOperationId: job.notebookId,
      });
    }
    const src = run.stages.find((s) => s.stage === "source_created");
    if (src && job.sourceId) {
      completeStage({ run, stage: "source_created", at: now(), externalOperationId: job.sourceId });
    }
  }

  const artifactsRes = await getJson<unknown>(`${args.base}${V1}/jobs/${run.job_id}/artifacts`);
  const artifacts = listArtifacts(artifactsRes.body);
  if (artifacts.length === 0) {
    run.artifacts.push({
      artifact_id: null,
      filename: null,
      media_type: null,
      size: null,
      sha256_expected: null,
      sha256_actual: null,
      download_status: null,
      source: null,
      valid: false,
      note: "no artifacts returned by the API",
    });
    return;
  }

  for (const a of artifacts) {
    let downloaded: Uint8Array | null = null;
    let status: number | null = null;
    try {
      const res = await fetch(`${args.base}${V1}/jobs/${run.job_id}/artifacts/${a.id}`, {
        headers: authHeaders(),
      });
      status = res.status;
      if (res.ok) downloaded = new Uint8Array(await res.arrayBuffer());
    } catch {
      status = null;
    }
    const isPodcast = a.mediaType === "audio/wav" || a.filename.startsWith("podcast-");
    const ref: E2EArtifactRef = validateArtifact({
      artifact: {
        id: a.id,
        filename: a.filename,
        mediaType: a.mediaType,
        size: a.size,
        source: a.source,
      },
      sha256Actual: downloaded ? sha256(downloaded) : null,
      downloadStatus: status,
      expected: {
        ...(args.minBytes !== undefined ? { minBytes: args.minBytes } : {}),
        // The podcast scenario pins the audio artifact to a real audio stream
        // (magic-byte check below); generic expectations are explicit flags.
        ...(args.scenario === "text-to-podcast" && isPodcast ? { mediaTypePrefix: "audio/" } : {}),
        ...(args.expectMime ? { mediaTypePrefix: args.expectMime } : {}),
      },
    });
    if (
      ref.valid &&
      a.mediaType === "audio/wav" &&
      downloaded !== null &&
      !wavHasRiffHeader(downloaded)
    ) {
      ref.valid = false;
      ref.note = "audio/wav artifact is missing the RIFF/WAVE magic bytes";
    }
    run.artifacts.push(ref);
  }

  if (
    args.scenario === "text-to-podcast" &&
    !run.artifacts.some((a) => a.valid && a.media_type?.startsWith("audio/"))
  ) {
    recordError(run, {
      code: "E2E_ARTIFACT_MISSING",
      message: "podcast job SUCCEEDED but no valid audio artifact was returned",
      at: now(),
      stage: "artifact_validate",
      failure_class: null,
      http_status: null,
      retryable: false,
    });
  }
}

/** Content check for the mock/real WAV contract: "RIFF" at 0, "WAVE" at 8. */
function wavHasRiffHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base) {
    console.error("ERROR: --base or NLO_API_BASE is required");
    return 3;
  }
  if (
    (args.scenario === "text-to-notebook" || args.scenario === "text-to-podcast") &&
    !args.textFile
  ) {
    console.error("ERROR: --text-file is required for the text scenario");
    return 3;
  }
  if (args.scenario === "audio-upload" && !args.audioFile) {
    console.error("ERROR: --audio-file is required for the audio scenario");
    return 3;
  }
  if (args.scenario === "job-monitor" && !args.jobId) {
    console.error("ERROR: --job-id is required for the monitor scenario");
    return 3;
  }

  const inputPath = args.textFile ?? args.audioFile;
  const inputBytes = inputPath ? await readFile(resolve(inputPath)) : new Uint8Array();
  const runId = `e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const run = createTestRun({
    testRunId: runId,
    scenarioId: args.scenario,
    inputType: args.textFile ? "text" : "audio",
    inputSha256: sha256(inputBytes),
    inputBytes: inputBytes.byteLength,
    filename: inputPath ? basename(inputPath) : null,
    startedAt: now(),
    stages: [...SCENARIO_STAGES[args.scenario]],
  });

  try {
    await assertContract(args.base);
  } catch (err) {
    recordError(run, {
      code: "E2E_CONTRACT_MISMATCH",
      message: err instanceof Error ? err.message : String(err),
      at: now(),
      stage: null,
      failure_class: null,
      http_status: (err as { status?: number }).status ?? null,
      retryable: false,
    });
    return finish(run, args, "BLOCKED");
  }

  if (args.jobId) run.job_id = args.jobId;

  if (run.job_id === null) {
    if (args.scenario === "text-to-notebook" || args.scenario === "text-to-podcast") {
      await runText(run, args);
    } else if (args.scenario === "audio-upload") {
      await runAudio(run, args);
    }
  }

  const job = run.job_id ? await pollJob(run, args) : null;
  if (run.job_id) await collectEvidence(run, args, job);

  if (job && job.status === "SUCCEEDED") {
    for (const s of run.stages) {
      if (s.state === "PENDING") {
        s.state = "PASSED";
        s.completed_at = now();
      }
    }
  }

  run.status = "COMPLETED";
  run.completed_at = now();
  const verdict = evaluateAcceptance({ run, jobStatus: (job?.status as never) ?? null });
  return finish(run, args, verdict);
}

async function finish(
  run: E2ETestRun,
  args: Args,
  verdict: E2ETestRun["acceptance"],
): Promise<number> {
  run.acceptance = verdict;
  const out =
    args.out ?? resolve(process.cwd(), "..", "..", "data", "e2e", `${run.test_run_id}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  const summary = {
    test_run_id: run.test_run_id,
    scenario: run.scenario_id,
    job_id: run.job_id,
    acceptance: run.acceptance,
    provenance: run.provenance,
    attempts_observed: run.attempts_observed,
    stages: run.stages.map((s) => `${s.stage}:${s.state}`),
    errors: run.errors.map((e) => `${e.code}${e.http_status ? `(${e.http_status})` : ""}`),
    artifacts: run.artifacts.map((a) => ({ size: a.size, valid: a.valid, note: a.note })),
    report: out,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (run.acceptance === "PASS" || run.acceptance === "MOCK_PROVIDER_INTEGRATION_VERIFIED") {
    return 0;
  }
  if (run.acceptance === "BLOCKED" || run.acceptance === "NOT_TESTED") return 2;
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
