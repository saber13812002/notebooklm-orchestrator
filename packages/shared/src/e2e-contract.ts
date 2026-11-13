/**
 * NLO-P1 — External E2E acceptance contract (transport-neutral, no I/O).
 *
 * This module is the *domain* of the external E2E runner: it defines what a
 * test run is, how stages are recorded, how a failure is classified, how an
 * artifact is validated and how acceptance is decided. It performs no HTTP and
 * touches no database, so it is unit-testable in isolation.
 *
 * Aligned with the existing domain: JobStatus / FailureClass / Artifact from
 * `types.ts`. Nothing here replaces the job engine, queue, worker or state
 * machine — it only observes them from the outside.
 */

import type { Artifact, FailureClass, JobStatus, ResultProvenance } from "./types.js";

/** Verdict levels used across the project (never claim more than observed). */
export type E2EVerdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_IMPLEMENTED" | "NOT_TESTED";

export type E2ERunStatus = "RUNNING" | "COMPLETED" | "ABORTED";

export type E2EScenarioId =
  "text-to-notebook" | "audio-upload" | "job-monitor" | "failure-recovery" | "artifact-acceptance";

export type E2EInputType = "text" | "audio";

/** Stable, categorised failure codes produced by the runner (not by the server). */
export type E2EErrorCode =
  | "E2E_AUTH"
  | "E2E_TIMEOUT"
  | "E2E_JOB_STUCK"
  | "E2E_PROXY"
  | "E2E_WORKER"
  | "E2E_PROVIDER"
  | "E2E_INPUT_INVALID"
  | "E2E_ARTIFACT_MISSING"
  | "E2E_ARTIFACT_INVALID"
  | "E2E_HTTP_UNEXPECTED"
  | "E2E_CONTRACT_MISMATCH"
  | "E2E_UNKNOWN";

export interface E2EStage {
  stage: string;
  state: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "SKIPPED";
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  attempt_number: number;
  heartbeat: string | null;
  error_code: E2EErrorCode | null;
  error_class: FailureClass | null;
  /** Resume point, e.g. "source_created" — used by recovery guidance. */
  checkpoint: string | null;
  /** Provider-side identifier when the stage maps to one (notebookId, sourceId, ...). */
  external_operation_id: string | null;
}

export interface E2EError {
  code: E2EErrorCode;
  message: string;
  at: string;
  /** Which stage produced it. */
  stage: string | null;
  /** Raw server-side error class when available (never a secret). */
  failure_class: FailureClass | null;
  http_status: number | null;
  retryable: boolean;
}

export interface E2EArtifactRef {
  artifact_id: string | null;
  filename: string | null;
  media_type: string | null;
  size: number | null;
  sha256_expected: string | null;
  sha256_actual: string | null;
  download_status: number | null;
  source: "provider" | "application" | null;
  valid: boolean;
  note: string | null;
}

export interface E2ETestRun {
  test_run_id: string;
  scenario_id: E2EScenarioId;
  job_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: E2ERunStatus;
  input: {
    type: E2EInputType;
    sha256: string;
    bytes: number;
    filename?: string | null;
  };
  stages: E2EStage[];
  artifacts: E2EArtifactRef[];
  errors: E2EError[];
  /** Mirrors the job's own provenance flag; "unknown" until the job reports one. */
  provenance: ResultProvenance;
  acceptance: E2EVerdict;
  /** Observed job status history (append-only, deduplicated on write). */
  job_status_history: Array<{ status: JobStatus; at: string }>;
  /** Server-reported attempt counter, used to prove retries are visible. */
  attempts_observed: number;
}

/* ------------------------------------------------------------------ */
/* Construction                                                       */
/* ------------------------------------------------------------------ */

export interface CreateRunInput {
  testRunId: string;
  scenarioId: E2EScenarioId;
  inputType: E2EInputType;
  inputSha256: string;
  inputBytes: number;
  filename?: string | null;
  startedAt: string;
  /** Stage names in execution order. */
  stages: string[];
}

/**
 * Creates a run with every stage in PENDING. Deterministic given inputs, so a
 * test can assert the exact shape (no timestamps generated internally).
 */
export function createTestRun(input: CreateRunInput): E2ETestRun {
  if (!input.testRunId.trim()) throw new Error("testRunId must not be empty");
  if (!/^[0-9a-f]{64}$/i.test(input.inputSha256)) {
    throw new Error("inputSha256 must be a 64-char hex digest");
  }
  if (input.inputBytes < 0) throw new Error("inputBytes must be >= 0");
  if (input.stages.length === 0) throw new Error("at least one stage is required");
  if (new Set(input.stages).size !== input.stages.length) {
    throw new Error("stage names must be unique");
  }

  return {
    test_run_id: input.testRunId,
    scenario_id: input.scenarioId,
    job_id: null,
    started_at: input.startedAt,
    completed_at: null,
    status: "RUNNING",
    input: {
      type: input.inputType,
      sha256: input.inputSha256.toLowerCase(),
      bytes: input.inputBytes,
      filename: input.filename ?? null,
    },
    stages: input.stages.map((stage) => ({
      stage,
      state: "PENDING",
      started_at: null,
      completed_at: null,
      duration_ms: null,
      attempt_number: 1,
      heartbeat: null,
      error_code: null,
      error_class: null,
      checkpoint: null,
      external_operation_id: null,
    })),
    artifacts: [],
    errors: [],
    provenance: "unknown",
    acceptance: "NOT_TESTED",
    job_status_history: [],
    attempts_observed: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Stage transitions                                                  */
/* ------------------------------------------------------------------ */

/** Starts a stage; timestamp must be supplied by the caller (injectable clock). */
export function startStage(run: E2ETestRun, stage: string, at: string): E2ETestRun {
  const found = run.stages.find((s) => s.stage === stage);
  if (!found) throw new Error(`unknown stage: ${stage}`);
  if (found.state === "PASSED" || found.state === "SKIPPED") {
    throw new Error(`stage already finished: ${stage}`);
  }
  found.state = "RUNNING";
  found.started_at = found.started_at ?? at;
  found.heartbeat = at;
  return run;
}

export interface CompleteStageInput {
  run: E2ETestRun;
  stage: string;
  at: string;
  checkpoint?: string | null;
  externalOperationId?: string | null;
  attemptNumber?: number;
}

export function completeStage(input: CompleteStageInput): E2ETestRun {
  const { run, stage, at } = input;
  const found = run.stages.find((s) => s.stage === stage);
  if (!found) throw new Error(`unknown stage: ${stage}`);
  found.state = "PASSED";
  found.completed_at = at;
  found.heartbeat = at;
  found.duration_ms =
    found.started_at === null ? null : Math.max(0, Date.parse(at) - Date.parse(found.started_at));
  if (input.checkpoint !== undefined) found.checkpoint = input.checkpoint;
  if (input.externalOperationId !== undefined) {
    found.external_operation_id = input.externalOperationId;
  }
  if (input.attemptNumber !== undefined) found.attempt_number = input.attemptNumber;
  return run;
}

/* ------------------------------------------------------------------ */
/* Failure classification                                             */
/* ------------------------------------------------------------------ */

export interface ClassifyInput {
  jobStatus?: JobStatus | null;
  failureClass?: FailureClass | null;
  httpStatus?: number | null;
  /** Milliseconds since the last observable change (job.updatedAt). */
  stalledForMs?: number | null;
  stallThresholdMs?: number | null;
}

export interface Classification {
  code: E2EErrorCode;
  retryable: boolean;
}

/**
 * Maps observed facts to one stable code. Order matters: transport/auth are
 * checked before job-level classes so an expired session is never reported as
 * a generic provider error.
 */
export function classifyFailure(input: ClassifyInput): Classification {
  const { jobStatus, failureClass, httpStatus } = input;

  if (httpStatus === 401 || httpStatus === 403) {
    return { code: "E2E_AUTH", retryable: false };
  }
  if (httpStatus === 504 || httpStatus === 408) {
    return { code: "E2E_TIMEOUT", retryable: true };
  }
  if (httpStatus !== null && httpStatus !== undefined && httpStatus >= 500) {
    return { code: "E2E_HTTP_UNEXPECTED", retryable: true };
  }
  if (httpStatus !== null && httpStatus !== undefined && httpStatus >= 400) {
    return { code: "E2E_INPUT_INVALID", retryable: false };
  }

  switch (failureClass) {
    case "auth":
      return { code: "E2E_AUTH", retryable: false };
    case "proxy":
      return { code: "E2E_PROXY", retryable: true };
    case "connectivity":
      return { code: "E2E_WORKER", retryable: true };
    case "provider":
      return { code: "E2E_PROVIDER", retryable: true };
    case "rate_limit":
      return { code: "E2E_PROVIDER", retryable: true };
    case "invalid_input":
      return { code: "E2E_INPUT_INVALID", retryable: false };
    case "ambiguous":
      return { code: "E2E_JOB_STUCK", retryable: false };
    default:
      break;
  }

  const stalled = input.stalledForMs ?? 0;
  const threshold = input.stallThresholdMs ?? 0;
  if (threshold > 0 && stalled > threshold) {
    return { code: "E2E_JOB_STUCK", retryable: false };
  }
  if (jobStatus === "NEEDS_ATTENTION") {
    return { code: "E2E_JOB_STUCK", retryable: false };
  }
  return { code: "E2E_UNKNOWN", retryable: false };
}

export function recordError(
  run: E2ETestRun,
  error: Omit<E2EError, "at"> & { at: string },
): E2ETestRun {
  run.errors.push({ ...error });
  const stage = error.stage ? run.stages.find((s) => s.stage === error.stage) : undefined;
  if (stage && stage.state !== "PASSED") {
    stage.state = "FAILED";
    stage.error_code = error.code;
    stage.error_class = error.failure_class;
    stage.completed_at = error.at;
    stage.heartbeat = error.at;
    stage.duration_ms =
      stage.started_at === null
        ? null
        : Math.max(0, Date.parse(error.at) - Date.parse(stage.started_at));
  }
  return run;
}

/* ------------------------------------------------------------------ */
/* Artifact acceptance                                                */
/* ------------------------------------------------------------------ */

export interface ValidateArtifactInput {
  artifact: Pick<Artifact, "id" | "filename" | "mediaType" | "size" | "source">;
  sha256Actual: string | null;
  downloadStatus: number | null;
  /** Optional expectation; when absent only intrinsic checks run. */
  expected?: {
    minBytes?: number;
    mediaTypePrefix?: string;
    sha256?: string;
  } | null;
}

/**
 * Intrinsic checks always run: the file must exist, have been downloaded, have
 * a non-empty body and a real media type. A fabricated file cannot pass because
 * a size/mime/checksum expectation mismatch sets `valid=false`.
 */
export function validateArtifact(input: ValidateArtifactInput): E2EArtifactRef {
  const { artifact, sha256Actual, downloadStatus, expected } = input;
  const problems: string[] = [];

  if (downloadStatus === null) problems.push("artifact was not downloaded");
  else if (downloadStatus < 200 || downloadStatus >= 300) {
    problems.push(`download HTTP ${downloadStatus}`);
  }
  if (artifact.size <= 0) problems.push("size is zero");
  if (!artifact.mediaType || !artifact.mediaType.includes("/")) {
    problems.push("mediaType is not a MIME type");
  }
  if (expected?.minBytes !== undefined && artifact.size < expected.minBytes) {
    problems.push(`size ${artifact.size} < expected min ${expected.minBytes}`);
  }
  if (expected?.mediaTypePrefix && !artifact.mediaType.startsWith(expected.mediaTypePrefix)) {
    problems.push(`mediaType ${artifact.mediaType} != ${expected.mediaTypePrefix}*`);
  }
  if (
    expected?.sha256 &&
    (!sha256Actual || sha256Actual.toLowerCase() !== expected.sha256.toLowerCase())
  ) {
    problems.push("sha256 mismatch");
  }
  if (sha256Actual !== null && !/^[0-9a-f]{64}$/i.test(sha256Actual)) {
    problems.push("sha256 is not a digest");
  }

  return {
    artifact_id: artifact.id,
    filename: artifact.filename,
    media_type: artifact.mediaType,
    size: artifact.size,
    sha256_expected: expected?.sha256 ?? null,
    sha256_actual: sha256Actual,
    download_status: downloadStatus,
    source: artifact.source,
    valid: problems.length === 0,
    note: problems.length === 0 ? null : problems.join("; "),
  };
}

/* ------------------------------------------------------------------ */
/* Acceptance decision                                                */
/* ------------------------------------------------------------------ */

export interface AcceptanceInput {
  run: E2ETestRun;
  jobStatus: JobStatus | null;
}

/**
 * PASS only when the job is SUCCEEDED, provenance is "real", no error was
 * recorded, and (for scenarios that expect an artifact) every artifact valid.
 * A mock-provenance run is never PASS.
 */
export function evaluateAcceptance(input: AcceptanceInput): E2EVerdict {
  const { run, jobStatus } = input;

  const failedStage = run.stages.find((s) => s.state === "FAILED");
  if (failedStage) return "FAIL";
  if (run.errors.length > 0) return "FAIL";
  if (jobStatus === null) return "NOT_TESTED";
  if (jobStatus === "FAILED" || jobStatus === "CANCELLED") return "FAIL";
  if (jobStatus === "NEEDS_ATTENTION") return "BLOCKED";
  if (jobStatus !== "SUCCEEDED") return "NOT_TESTED";

  const pendingStage = run.stages.find((s) => s.state !== "PASSED" && s.state !== "SKIPPED");
  if (pendingStage) return "NOT_TESTED";
  if (run.provenance !== "real") return "FAIL";
  if (run.artifacts.some((a) => !a.valid)) return "FAIL";
  return "PASS";
}

/** Terminal statuses the runner stops polling on (named to avoid clashing with job-state). */
export function isTerminalStatus(jobStatus: JobStatus): boolean {
  return jobStatus === "SUCCEEDED" || jobStatus === "FAILED" || jobStatus === "CANCELLED";
}

/** Records a job status observation without duplicating identical consecutive entries. */
export function observeJobStatus(run: E2ETestRun, status: JobStatus, at: string): E2ETestRun {
  const last = run.job_status_history[run.job_status_history.length - 1];
  if (!last || last.status !== status) run.job_status_history.push({ status, at });
  return run;
}

/** Canonical stage lists per scenario (ordered). */
export const SCENARIO_STAGES: Record<E2EScenarioId, readonly string[]> = {
  "text-to-notebook": [
    "create_job",
    "validate_input",
    "queue_wait",
    "notebook_created",
    "source_created",
    "generation",
    "result_received",
    "acceptance",
  ],
  "audio-upload": [
    "upload_file",
    "validate_input",
    "queue_wait",
    "account_assigned",
    "session_ok",
    "proxy_ok",
    "worker_started",
    "notebook_created",
    "source_created",
    "prompt_sent",
    "generation",
    "artifact_download",
    "artifact_validate",
    "acceptance",
  ],
  "job-monitor": ["poll_status", "events_timeline", "attempts_read", "acceptance"],
  "failure-recovery": ["inject_or_observe_failure", "classify", "recovery_decision"],
  "artifact-acceptance": ["download", "checksum", "mime", "acceptance"],
};
