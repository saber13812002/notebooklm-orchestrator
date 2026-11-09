import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FailureClass } from "@nlo/shared";
import {
  CapLevel,
  capabilityMatrix,
  ProviderFailure,
  type ProviderAccountStatus,
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

  setScenario(accountId: string, scenario: MockScenario): void {
    this.scenarios.set(accountId, scenario);
  }

  scenario(accountId: string): MockScenario {
    return this.scenarios.get(accountId) ?? "ok";
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
    // Deterministic operation IDs for TEXT jobs only — mirrors the real
    // provider's notebook/source/conversation reporting. Audio mock jobs keep
    // reporting none (keeps the audio lifecycle tests honest).
    if (isText) {
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
