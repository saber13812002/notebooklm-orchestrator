import { describe, expect, it } from "vitest";

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
  type E2ETestRun,
} from "../src/e2e-contract.js";

const SHA = "a".repeat(64);

function newRun(overrides: Partial<Parameters<typeof createTestRun>[0]> = {}): E2ETestRun {
  return createTestRun({
    testRunId: "run-1",
    scenarioId: "text-to-notebook",
    inputType: "text",
    inputSha256: SHA,
    inputBytes: 42,
    startedAt: "2026-01-01T00:00:00.000Z",
    stages: ["create_job", "generation", "acceptance"],
    ...overrides,
  });
}

describe("createTestRun", () => {
  it("creates a run with every stage PENDING and no job id", () => {
    const run = newRun();
    expect(run.status).toBe("RUNNING");
    expect(run.job_id).toBeNull();
    expect(run.provenance).toBe("unknown");
    expect(run.acceptance).toBe("NOT_TESTED");
    expect(run.stages.map((s) => s.state)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(run.stages[0]).toMatchObject({
      stage: "create_job",
      attempt_number: 1,
      started_at: null,
      duration_ms: null,
      error_code: null,
    });
  });

  it("rejects an empty run id, a bad digest and duplicate stages", () => {
    expect(() => newRun({ testRunId: "  " })).toThrow(/testRunId/);
    expect(() => newRun({ inputSha256: "not-hex" })).toThrow(/inputSha256/);
    expect(() => newRun({ stages: ["a", "a"] })).toThrow(/unique/);
    expect(() => newRun({ stages: [] })).toThrow(/at least one stage/);
  });

  it("normalises the input digest to lower case", () => {
    const run = newRun({ inputSha256: "A".repeat(64) });
    expect(run.input.sha256).toBe("a".repeat(64));
  });
});

describe("stage transitions", () => {
  it("computes duration from injected timestamps", () => {
    const run = newRun();
    startStage(run, "create_job", "2026-01-01T00:00:00.000Z");
    completeStage({
      run,
      stage: "create_job",
      at: "2026-01-01T00:00:02.500Z",
      checkpoint: "job_created",
      externalOperationId: "job-123",
    });
    const stage = run.stages[0]!;
    expect(stage.state).toBe("PASSED");
    expect(stage.duration_ms).toBe(2500);
    expect(stage.checkpoint).toBe("job_created");
    expect(stage.external_operation_id).toBe("job-123");
  });

  it("refuses to restart a finished stage and rejects unknown stages", () => {
    const run = newRun();
    startStage(run, "create_job", "t1");
    completeStage({ run, stage: "create_job", at: "t2" });
    expect(() => startStage(run, "create_job", "t3")).toThrow(/already finished/);
    expect(() => startStage(run, "nope", "t3")).toThrow(/unknown stage/);
  });
});

describe("classifyFailure", () => {
  it("treats 401/403 as non-retryable auth", () => {
    expect(classifyFailure({ httpStatus: 401 })).toEqual({ code: "E2E_AUTH", retryable: false });
    expect(classifyFailure({ httpStatus: 403 })).toEqual({ code: "E2E_AUTH", retryable: false });
  });

  it("maps 408/504 to retryable timeout and 4xx to invalid input", () => {
    expect(classifyFailure({ httpStatus: 504 }).code).toBe("E2E_TIMEOUT");
    expect(classifyFailure({ httpStatus: 400 })).toEqual({
      code: "E2E_INPUT_INVALID",
      retryable: false,
    });
  });

  it("maps job failure classes", () => {
    expect(classifyFailure({ failureClass: "auth" }).code).toBe("E2E_AUTH");
    expect(classifyFailure({ failureClass: "proxy" }).code).toBe("E2E_PROXY");
    expect(classifyFailure({ failureClass: "connectivity" }).code).toBe("E2E_WORKER");
    expect(classifyFailure({ failureClass: "provider" }).code).toBe("E2E_PROVIDER");
    expect(classifyFailure({ failureClass: "rate_limit" })).toEqual({
      code: "E2E_PROVIDER",
      retryable: true,
    });
    expect(classifyFailure({ failureClass: "ambiguous" }).code).toBe("E2E_JOB_STUCK");
  });

  it("detects a stuck job from the stall threshold and from NEEDS_ATTENTION", () => {
    expect(classifyFailure({ stalledForMs: 9000, stallThresholdMs: 5000 }).code).toBe(
      "E2E_JOB_STUCK",
    );
    expect(classifyFailure({ jobStatus: "NEEDS_ATTENTION" })).toEqual({
      code: "E2E_JOB_STUCK",
      retryable: false,
    });
  });

  it("falls back to E2E_UNKNOWN when nothing matches", () => {
    expect(classifyFailure({ jobStatus: "RUNNING" }).code).toBe("E2E_UNKNOWN");
  });
});

describe("recordError", () => {
  it("marks the stage failed and stores the code", () => {
    const run = newRun();
    startStage(run, "generation", "2026-01-01T00:00:00.000Z");
    recordError(run, {
      code: "E2E_PROXY",
      message: "proxy dropped",
      at: "2026-01-01T00:00:03.000Z",
      stage: "generation",
      failure_class: "proxy",
      http_status: null,
      retryable: true,
    });
    expect(run.errors).toHaveLength(1);
    expect(run.stages[1]).toMatchObject({
      state: "FAILED",
      error_code: "E2E_PROXY",
      error_class: "proxy",
      duration_ms: 3000,
    });
  });
});

describe("validateArtifact", () => {
  const artifact = {
    id: "art-1",
    filename: "deep-dive.m4a",
    mediaType: "audio/mp4",
    size: 1024,
    source: "provider" as const,
  };

  it("accepts a genuine artifact", () => {
    const ref = validateArtifact({
      artifact,
      sha256Actual: SHA,
      downloadStatus: 200,
      expected: { minBytes: 100, mediaTypePrefix: "audio/", sha256: SHA },
    });
    expect(ref.valid).toBe(true);
    expect(ref.note).toBeNull();
  });

  it("rejects zero size, bad mime, failed download and checksum mismatch", () => {
    expect(
      validateArtifact({
        artifact: { ...artifact, size: 0 },
        sha256Actual: SHA,
        downloadStatus: 200,
      }).valid,
    ).toBe(false);
    expect(
      validateArtifact({
        artifact: { ...artifact, mediaType: "unknown" },
        sha256Actual: SHA,
        downloadStatus: 200,
      }).note,
    ).toContain("MIME");
    expect(validateArtifact({ artifact, sha256Actual: SHA, downloadStatus: 404 }).note).toContain(
      "download HTTP 404",
    );
    expect(
      validateArtifact({
        artifact,
        sha256Actual: "b".repeat(64),
        downloadStatus: 200,
        expected: { sha256: SHA },
      }).note,
    ).toContain("sha256 mismatch");
  });

  it("rejects a non-digest checksum and a too-small payload", () => {
    expect(validateArtifact({ artifact, sha256Actual: "xyz", downloadStatus: 200 }).note).toContain(
      "not a digest",
    );
    expect(
      validateArtifact({
        artifact,
        sha256Actual: SHA,
        downloadStatus: 200,
        expected: { minBytes: 5000 },
      }).note,
    ).toContain("expected min");
  });
});

describe("evaluateAcceptance", () => {
  function succeededRealRun(): E2ETestRun {
    const run = newRun();
    for (const name of ["create_job", "generation", "acceptance"]) {
      startStage(run, name, "2026-01-01T00:00:00.000Z");
      completeStage({ run, stage: name, at: "2026-01-01T00:00:01.000Z" });
    }
    run.provenance = "real";
    return run;
  }

  it("passes only for SUCCEEDED + real provenance + valid artifacts", () => {
    const run = succeededRealRun();
    run.artifacts.push({
      artifact_id: "art-1",
      filename: "a.m4a",
      media_type: "audio/mp4",
      size: 10,
      sha256_expected: SHA,
      sha256_actual: SHA,
      download_status: 200,
      source: "provider",
      valid: true,
      note: null,
    });
    expect(evaluateAcceptance({ run, jobStatus: "SUCCEEDED" })).toBe("PASS");
  });

  it("never passes a mock-provenance run", () => {
    const run = succeededRealRun();
    run.provenance = "mock";
    expect(evaluateAcceptance({ run, jobStatus: "SUCCEEDED" })).toBe("FAIL");
  });

  it("returns NOT_TESTED while the job is still running or a stage is pending", () => {
    const run = newRun();
    expect(evaluateAcceptance({ run, jobStatus: "RUNNING" })).toBe("NOT_TESTED");
    expect(evaluateAcceptance({ run, jobStatus: null })).toBe("NOT_TESTED");
  });

  it("returns FAIL for a failed job/stage and BLOCKED for NEEDS_ATTENTION", () => {
    const run = newRun();
    recordError(run, {
      code: "E2E_AUTH",
      message: "expired",
      at: "2026-01-01T00:00:00.000Z",
      stage: "create_job",
      failure_class: "auth",
      http_status: 401,
      retryable: false,
    });
    expect(evaluateAcceptance({ run, jobStatus: "FAILED" })).toBe("FAIL");
    expect(evaluateAcceptance({ run: newRun(), jobStatus: "NEEDS_ATTENTION" })).toBe("BLOCKED");
  });
});

describe("helpers", () => {
  it("deduplicates consecutive identical status observations", () => {
    const run = newRun();
    observeJobStatus(run, "CREATED", "t1");
    observeJobStatus(run, "CREATED", "t2");
    observeJobStatus(run, "RUNNING", "t3");
    expect(run.job_status_history).toEqual([
      { status: "CREATED", at: "t1" },
      { status: "RUNNING", at: "t3" },
    ]);
  });

  it("treats only SUCCEEDED/FAILED/CANCELLED as terminal", () => {
    expect(isTerminalStatus("SUCCEEDED")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
    expect(isTerminalStatus("RETRY_WAIT")).toBe(false);
    expect(isTerminalStatus("NEEDS_ATTENTION")).toBe(false);
  });

  it("declares unique, ordered stages for every scenario", () => {
    for (const [scenario, stages] of Object.entries(SCENARIO_STAGES)) {
      expect(stages.length, scenario).toBeGreaterThan(0);
      expect(new Set(stages).size, scenario).toBe(stages.length);
    }
  });
});
