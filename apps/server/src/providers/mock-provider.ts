import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FailureClass } from "@nlo/shared";
import {
  CapLevel,
  capabilityMatrix,
  ProviderFailure,
  type ProviderAccountStatus,
  type ProviderAudioDownloadRequest,
  type ProviderAudioDownloadResult,
  type ProviderAudioGenerateRequest,
  type ProviderAudioGenerateResult,
  type ProviderAudioStatus,
  type ProviderAudioStatusRequest,
  type ProviderAudioStatusResult,
  type ProviderError,
  type ProviderJobRequest,
  type ProviderJobResult,
  type NotebookLMProvider,
} from "./types.js";

/**
 * Mock provider: deterministic, offline, safe default.
 *
 * It simulates the real audio+prompt workflow (upload source -> ask -> read
 * answer -> collect artifacts) WITHOUT any network or Google calls.
 *
 * Scenario control (for tests) via `setScenario(accountId, scenario)`:
 *   ok (default) | auth | rate_limit | transient | ambiguous
 *
 * It is clearly labeled "mock" in the UI; it never claims live capability.
 */
export type MockScenario = "ok" | "auth" | "rate_limit" | "transient" | "ambiguous";

export class MockProvider implements NotebookLMProvider {
  readonly name = "mock";
  private scenarios = new Map<string, MockScenario>();
  private outDir = mkdtempSync(path.join(tmpdir(), "nlo-mock-provider-"));
  /** Test hook: sleep this long during "ask" (ms) to allow cancel/retry tests. */
  delayMs = 0;
  /**
   * NLO-P2 audio test hooks:
   *  - `audioAutoComplete` (default true): tasks flip in_progress -> completed
   *    after the first status poll (deterministic single-poll completion).
   *  - `setAudioTaskState(taskId, state)`: force a task's state (fault
   *    injection: "in_progress" | "completed" | "failed" | "not_found").
   * Task ids are deterministic per job: `mock_audio_<jobId suffix>`.
   */
  audioAutoComplete = true;
  private audioStates = new Map<string, "in_progress" | "completed" | "failed" | "not_found">();
  private audioPollCount = new Map<string, number>();

  setScenario(accountId: string, scenario: MockScenario): void {
    this.scenarios.set(accountId, scenario);
  }

  scenario(accountId: string): MockScenario {
    return this.scenarios.get(accountId) ?? "ok";
  }

  /** Test hook: force an audio task's state (fault injection). */
  setAudioTaskState(
    taskId: string,
    state: "in_progress" | "completed" | "failed" | "not_found",
  ): void {
    this.audioStates.set(taskId, state);
  }

  /** Deterministic mock task id for a job (== artifact id). */
  mockAudioTaskId(jobId: string): string {
    return `mock_audio_${jobId.slice(-16)}`;
  }

  capabilities() {
    return capabilityMatrix({
      validateConfiguration: { level: CapLevel.implementedTested },
      getAccountStatus: { level: CapLevel.implementedTested },
      uploadAudioSource: {
        level: CapLevel.implementedTested,
        note: "simulated; real provider supports .wav (mp3 unverified)",
      },
      ask: { level: CapLevel.implementedTested },
      retrieveResult: { level: CapLevel.implementedTested },
      retrieveArtifacts: {
        level: CapLevel.implementedTested,
        note: "only provider-returned files are surfaced; mock returns one sample",
      },
      cancelJob: { level: CapLevel.implementedTested, note: "mock honors cancel" },
      addTextSource: {
        level: CapLevel.implementedTested,
        note: "simulated (H1 text-to-notebook); real mechanism verified in notebooklm-py 0.8.5",
      },
      generateAudio: {
        level: CapLevel.implementedTested,
        note: "simulated (NLO-P2); deterministic task ids, no real generation",
      },
      getAudioStatus: {
        level: CapLevel.implementedTested,
        note: "simulated (NLO-P2); state controlled by test hooks",
      },
      downloadAudio: {
        level: CapLevel.implementedTested,
        note: "simulated (NLO-P2); writes a minimal real WAV file, verified size/hash",
      },
    });
  }

  inputCapabilities() {
    const t = CapLevel.implementedTested;
    return [
      { format: "text", level: t, note: "simulated (H1 text-to-notebook)" },
      {
        format: "txt",
        level: t,
        note: "simulated; validated and submitted verbatim in the app layer",
      },
      {
        format: "docx",
        level: t,
        note: "simulated; extracted to plain text in the app layer (mammoth)",
      },
      {
        format: "srt",
        level: t,
        note: "simulated; validated in the app layer, submitted verbatim",
      },
      { format: "wav", level: t, note: "simulated; real provider supports .wav" },
      { format: "mp3", level: t, note: "simulated; real support unverified" },
      { format: "m4a", level: t, note: "simulated; real support unverified" },
      { format: "ogg", level: t, note: "simulated; real support unverified" },
      { format: "flac", level: t, note: "simulated; real support unverified" },
    ];
  }

  async validateConfiguration(): Promise<{ ok: boolean; issues: string[] }> {
    return { ok: true, issues: [] };
  }

  async getAccountStatus(
    accountId: string,
    _credentialRef: string,
  ): Promise<ProviderAccountStatus> {
    if (this.scenario(accountId) === "auth") {
      return { ok: false, email: null, detail: "mock: account requires re-auth" };
    }
    return { ok: true, email: "mock-account@example.com", detail: null };
  }

  async runJob(req: ProviderJobRequest): Promise<ProviderJobResult> {
    const fail = (
      failureClass: FailureClass,
      message: string,
      extra: Partial<ProviderError> = {},
    ) => {
      throw new ProviderFailure({
        failureClass,
        message,
        ambiguous: false,
        needsReauth: false,
        ...extra,
      });
    };

    if (req.signal.aborted) {
      fail("provider", "cancelled before start");
    }

    const scenario = this.scenario(req.accountId);
    req.onProgress(5, "mock: validating request");

    if (scenario === "auth") {
      fail("auth", "mock: 401 authentication required", { httpStatus: 401, needsReauth: true });
    }
    if (scenario === "rate_limit") {
      fail("rate_limit", "mock: 429 too many requests", { httpStatus: 429 });
    }
    if (scenario === "transient") {
      fail("provider", "mock: 500 transient provider error", { httpStatus: 500 });
    }
    if (scenario === "ambiguous") {
      fail("ambiguous", "mock: worker interrupted, completion unknown", { ambiguous: true });
    }

    // Simulate the workflow steps.
    const isText = Boolean(req.textPath);
    const hasPrompt = req.prompt.trim() !== "";

    req.onProgress(20, isText ? "mock: adding text source" : "mock: uploading audio source");
    if (req.audioPath && !existsSync(req.audioPath)) {
      fail("invalid_input", "mock: audio file missing");
    }
    if (req.textPath && !existsSync(req.textPath)) {
      fail("invalid_input", "mock: text file missing");
    }

    req.onProgress(45, "mock: indexing source");
    this.checkpoint(req.signal);

    // summary.enabled=false (empty prompt) -> providers skip the ask step.
    let answer: string | null = null;
    if (hasPrompt) {
      req.onProgress(70, "mock: asking question");
      this.checkpoint(req.signal);
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
        this.checkpoint(req.signal);
      }

      // The "ask" call goes through the egress boundary, exactly like a real
      // worker. A null tunnel or a broken scenario throws here (fail-closed);
      // the runner classifies the raw error (proxy/connectivity/...) and
      // decides retry vs. terminal.
      await req.egress.request(req.tunnel, "notebooklm.google.com:443", {
        method: "POST",
        path: "/batchexecute",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: req.prompt, simulated: true }),
      });

      const textEcho =
        isText && req.textPath
          ? `\n**Text source (first 200 chars):**\n\n${readFileSync(req.textPath, "utf8").slice(0, 200)}\n`
          : "";
      answer = [
        "# Mock Answer",
        "",
        "> This is a **deterministic mock** response. No real NotebookLM request was made.",
        "",
        `**Prompt:** ${req.prompt}`,
        "",
        isText
          ? `**Text source:** added (simulated) — ${req.textTitle ?? "text"}`
          : req.audioPath
            ? "**Audio source:** uploaded (simulated)"
            : "**Audio source:** none",
        textEcho,
        "The real provider (python-worker) is disabled until explicitly approved.",
      ]
        .filter((l) => l !== "")
        .join("\n");
    }

    // Produce ONE sample artifact to exercise the artifact pipeline. Mock
    // artifacts are clearly application-generated in provenance.
    const artifactName = `mock-sample-${randomUUID().slice(0, 8)}.txt`;
    const artifactPath = path.join(this.outDir, req.jobId, artifactName);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      `Mock sample artifact for job ${req.jobId}\nGenerated by the mock provider (NOT a real NotebookLM output).\n`,
      "utf8",
    );

    req.onProgress(95, "mock: collecting artifacts");
    this.checkpoint(req.signal);
    req.onProgress(100, "mock: done");

    const providerMeta: Record<string, unknown> = {
      provider: "mock",
      simulated: true,
      steps: isText
        ? hasPrompt
          ? ["add-text", "index", "ask", "artifacts"]
          : ["add-text", "index"]
        : hasPrompt
          ? ["upload", "index", "ask", "artifacts"]
          : ["upload", "index"],
    };
    // Deterministic operation IDs for text jobs and podcast jobs — mirrors
    // the real provider's notebook/source/conversation reporting. A podcast
    // job always works in a notebook (that is the point of the job), so it
    // reports one too. Plain audio mock jobs keep reporting none (keeps the
    // audio lifecycle tests honest).
    if (isText || Boolean(req.podcast)) {
      const suffix = req.jobId.slice(-16);
      providerMeta.notebookId = `mock_nb_${suffix}`;
      providerMeta.notebookTitle = req.notebookTitle ?? null;
      providerMeta.sourceId = `mock_src_${suffix}`;
      providerMeta.conversationId = hasPrompt ? `mock_conv_${suffix}` : null;
    }

    return {
      answerMarkdown: answer,
      providerMeta,
      artifacts: [{ name: artifactName, mediaType: "text/plain", path: artifactPath }],
    };
  }

  async cancel(_jobId: string): Promise<{ accepted: boolean; note: string }> {
    return { accepted: true, note: "mock: cancellation recorded (no real operation to stop)" };
  }

  // ------------------------------------------------------------------
  // NLO-P2: simulated Audio Overview (podcast) pipeline.
  //
  // Deterministic and offline: task ids derive from the job id, the state
  // machine is controlled by `audioAutoComplete`/`setAudioTaskState`, and the
  // "artifact" is a real minimal WAV file written to a server-controlled
  // path. Scenario failures (auth/rate_limit/...) behave exactly like
  // runJob so runner error classification is exercised identically.
  // ------------------------------------------------------------------

  private mockStatus(taskId: string): ProviderAudioStatus {
    const state = this.audioStates.get(taskId) ?? "in_progress";
    return {
      taskId,
      status: state,
      url: null,
      error: state === "failed" ? "mock: simulated generation failure" : null,
      errorCode: state === "failed" ? "mock_failed" : null,
      metadata:
        state === "completed" ? { simulated: true, durationSeconds: 1, format: "wav" } : null,
      isComplete: state === "completed",
      isFailed: state === "failed",
      isTerminal: state === "completed" || state === "failed" || state === "not_found",
      isNotFound: state === "not_found",
      isRateLimited: false,
    };
  }

  /** Scenario-aware pre-flight shared by all three audio ops. */
  private audioPreflight(accountId: string, signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "cancelled before start",
        ambiguous: false,
        needsReauth: false,
      });
    }
    const scenario = this.scenario(accountId);
    if (scenario === "auth") {
      throw new ProviderFailure({
        failureClass: "auth",
        message: "mock: 401 authentication required",
        httpStatus: 401,
        ambiguous: false,
        needsReauth: true,
      });
    }
    if (scenario === "rate_limit") {
      throw new ProviderFailure({
        failureClass: "rate_limit",
        message: "mock: 429 too many requests",
        httpStatus: 429,
        ambiguous: false,
        needsReauth: false,
      });
    }
    if (scenario === "transient") {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "mock: 500 transient provider error",
        httpStatus: 500,
        ambiguous: false,
        needsReauth: false,
      });
    }
    if (scenario === "ambiguous") {
      throw new ProviderFailure({
        failureClass: "ambiguous",
        message: "mock: worker interrupted, completion unknown",
        ambiguous: true,
        needsReauth: false,
      });
    }
  }

  async generateAudio(req: ProviderAudioGenerateRequest): Promise<ProviderAudioGenerateResult> {
    this.audioPreflight(req.accountId, req.signal);
    req.onProgress(10, "mock: validating audio generation request");

    // Idempotency contract (mirrors the real worker): with a resumeTaskId we
    // poll first and only "re-submit" on proven failure.
    if (req.resumeTaskId) {
      const prior = this.mockStatus(req.resumeTaskId);
      if (!prior.isFailed) {
        req.onProgress(30, "mock: reusing existing generation task");
        return {
          email: "mock-account@example.com",
          notebookId: req.notebookId,
          resumed: true,
          priorStatus: prior.status,
          status: prior,
          instructionsProvided: Boolean(req.prompt?.trim()),
          checkedAt: new Date().toISOString(),
        };
      }
      req.onProgress(35, "mock: prior task failed — re-submitting");
    }

    // Egress boundary, exactly like runJob (fail-closed: no tunnel => throw).
    await req.egress.request(req.tunnel, "notebooklm.google.com:443", {
      method: "POST",
      path: "/artifacts/generate_audio",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notebookId: req.notebookId,
        sourceIds: req.sourceIds ?? null,
        simulated: true,
      }),
    });

    const taskId = this.mockAudioTaskId(req.jobId);
    // A re-submission for the SAME job reuses the deterministic task id but
    // starts from a clean state; record the prior (failed) status first so the
    // re-submission is auditable.
    const priorForResubmit = req.resumeTaskId
      ? (this.audioStates.get(req.resumeTaskId) ?? null)
      : null;
    this.audioStates.delete(taskId);
    req.onProgress(60, "mock: generation submitted — task recorded");
    req.onProgress(100, "mock: audio generation submitted");
    return {
      email: "mock-account@example.com",
      notebookId: req.notebookId,
      resumed: false,
      priorStatus: priorForResubmit,
      status: this.mockStatus(taskId), // in_progress by default
      instructionsProvided: Boolean(req.prompt?.trim()),
      checkedAt: new Date().toISOString(),
    };
  }

  async getAudioStatus(req: ProviderAudioStatusRequest): Promise<ProviderAudioStatusResult> {
    this.audioPreflight(req.accountId, req.signal);
    req.onProgress(30, "mock: polling generation task");

    // Deterministic single-poll completion (unless a test forced a state).
    if (!this.audioStates.has(req.taskId) && this.audioAutoComplete) {
      const n = (this.audioPollCount.get(req.taskId) ?? 0) + 1;
      this.audioPollCount.set(req.taskId, n);
      if (n >= 1) {
        this.audioStates.set(req.taskId, "completed");
      }
    }

    req.onProgress(100, "mock: task polled");
    return {
      notebookId: req.notebookId,
      status: this.mockStatus(req.taskId),
      checkedAt: new Date().toISOString(),
    };
  }

  async downloadAudio(req: ProviderAudioDownloadRequest): Promise<ProviderAudioDownloadResult> {
    this.audioPreflight(req.accountId, req.signal);
    req.onProgress(20, "mock: locating audio artifact");

    if (!req.destPath || !path.isAbsolute(req.destPath)) {
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: `destPath must be a non-empty absolute path: ${req.destPath}`,
        ambiguous: false,
        needsReauth: false,
      });
    }
    // The artifact exists only for a known (generated) task.
    const known =
      this.audioStates.has(req.artifactId) || req.artifactId === this.mockAudioTaskId(req.jobId);
    if (!known) {
      throw new ProviderFailure({
        failureClass: "unknown",
        message: `mock: audio artifact not found: ${req.artifactId}`,
        ambiguous: false,
        needsReauth: false,
      });
    }
    const state = this.mockStatus(req.artifactId);
    if (!state.isComplete) {
      req.onProgress(40, "mock: artifact not finished yet");
      return {
        ready: false,
        notebookId: req.notebookId,
        artifactId: req.artifactId,
        artifactStatus: state.status ?? "in_progress",
        checkedAt: new Date().toISOString(),
      };
    }

    // Write a real minimal WAV file (44-byte header + 1024 zero samples).
    const wav = this.mockWav();
    mkdirSync(path.dirname(req.destPath), { recursive: true });
    writeFileSync(req.destPath, wav);
    if (req.maxBytes !== null && req.maxBytes !== undefined && wav.length > req.maxBytes) {
      rmSync(req.destPath, { force: true });
      throw new ProviderFailure({
        failureClass: "invalid_input",
        message: `mock: downloaded artifact exceeds size limit: ${wav.length} > ${req.maxBytes}`,
        ambiguous: false,
        needsReauth: false,
      });
    }
    const sha256 = createHash("sha256").update(wav).digest("hex");
    req.onProgress(100, "mock: audio artifact downloaded and verified");
    return {
      ready: true,
      notebookId: req.notebookId,
      artifactId: req.artifactId,
      path: req.destPath,
      size: wav.length,
      sha256,
      durationSeconds: 1,
      artifactTitle: "Mock Audio Overview",
      artifactStatus: "completed",
      checkedAt: new Date().toISOString(),
    };
  }

  /** A minimal valid WAV: 44-byte RIFF header + 1024 bytes of 16-bit silence. */
  private mockWav(): Buffer {
    const numSamples = 512;
    const byteRate = 16000 * 2; // 16 kHz mono 16-bit
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(16000, 24); // sample rate
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataSize, 40);
    // samples: zeros already
    return buf;
  }

  private checkpoint(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "cancelled mid-operation",
        ambiguous: false,
        needsReauth: false,
      });
    }
  }

  dispose(): void {
    try {
      rmSync(this.outDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
