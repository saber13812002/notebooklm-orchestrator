import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/app-context.js";
import { createAppContext } from "../src/app-context.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/api/server.js";
import { addAccount, addNode, markHealthy } from "./helpers.js";
import { SCENARIO_STAGES } from "@nlo/shared";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(TEST_DIR, "..");
const requireFromTest = createRequire(path.join(TEST_DIR, "file.ts"));
const E2E_SCRIPT = path.join(SERVER_DIR, "scripts", "nlo-e2e.ts");

/** Canonical text-to-podcast stages from the shared contract, all PASSED. */
const EXPECTED_PODCAST_STAGES = SCENARIO_STAGES["text-to-podcast"].map((s) => `${s}:PASSED`);

/**
 * NLO-P2 (§12/§13): independent LOCAL test environment for the E2E runner.
 *
 * Boots a real in-process NLO server (real config, real database, real queue,
 * mock provider) on an ephemeral loopback port and executes the production
 * script `scripts/nlo-e2e.ts` as an EXTERNAL child process — exactly how a
 * third party would run it. No in-process shortcuts, no shared memory.
 *
 * Verdicts are honest: against the mock provider the run is accepted as
 * MOCK_PROVIDER_INTEGRATION_VERIFIED (exit 0) — never PASS. Live NotebookLM
 * execution remains out of scope here (see the live acceptance runbook).
 */

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function locateTsxCli(): string {
  const candidates: string[] = [];
  try {
    candidates.push(requireFromTest.resolve("tsx/dist/cli.mjs"));
  } catch {
    /* package exports may hide the subpath; fall back to paths */
  }
  candidates.push(
    path.join(SERVER_DIR, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs"),
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("tsx CLI entry point not found (looked for tsx/dist/cli.mjs)");
}

function runE2eScript(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<ScriptResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // tsx CLI form: `node <tsx-cli> <script.ts> <script args...>`
    const child = spawn(process.execPath, [locateTsxCli(), E2E_SCRIPT, ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`e2e script timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

interface LiveServer {
  app: FastifyInstance;
  ctx: AppContext;
  base: string;
  dir: string;
  stop(): Promise<void>;
}

const SAMPLE_TEXT = [
  "NLO local E2E sample document.",
  "",
  "The NotebookLM Orchestrator turns a text input into a notebook with a",
  "deep-dive podcast. This sample is only used to drive the mock provider.",
  "",
  "Second paragraph so the text is more than one line. The podcast should",
  "discuss the architecture, the job lifecycle, and artifact delivery.",
].join("\n");

async function startLiveServer(seedProxy: boolean): Promise<LiveServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "nlo-e2e-local-"));
  const ctx = createAppContext(loadConfig({ NLO_DATA_DIR: dir, NLO_PORT: "0" }));
  const app = await buildApp(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  // The mock provider needs at least one enabled account to run a job
  // (selectAccount), and the egress ask-step needs a healthy proxy node
  // (fail-closed). Seed both exactly like the other in-process E2E tests.
  addAccount(ctx.accounts, "e2e-podcast");
  if (seedProxy) {
    const node = addNode(ctx.proxies, ctx.vault, "n1");
    markHealthy(ctx.proxies, node.id);
  }
  return {
    app,
    ctx,
    base: `http://127.0.0.1:${addr.port}`,
    dir,
    stop: async () => {
      await app.close();
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("nlo-e2e text-to-podcast — local test environment (mock provider)", () => {
  it("accepts the full pipeline as MOCK_PROVIDER_INTEGRATION_VERIFIED (exit 0, never PASS)", async () => {
    const server = await startLiveServer(true);
    const textFile = path.join(server.dir, "sample.txt");
    writeFileSync(textFile, SAMPLE_TEXT, "utf8");
    const reportPath = path.join(server.dir, "report.json");
    const token = server.ctx.apiTokens.create({
      name: "e2e-podcast-admin",
      scopes: ["admin"],
    }).plaintext;

    let res: ScriptResult;
    try {
      res = await runE2eScript(
        [
          "--scenario",
          "podcast",
          "--text-file",
          textFile,
          "--base",
          server.base,
          "--poll-ms",
          "200",
          "--timeout-ms",
          "60000",
          "--out",
          reportPath,
        ],
        { NLO_API_TOKEN: token },
      );
      expect(res.code, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
      const summary = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(summary.scenario).toBe("text-to-podcast");
      expect(summary.acceptance).toBe("MOCK_PROVIDER_INTEGRATION_VERIFIED");
      expect(summary.provenance).toBe("mock");
      expect(summary.acceptance).not.toBe("PASS"); // mocks never get a live PASS

      // The persisted report: every canonical stage PASSED, a valid audio artifact.
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        job_id: string | null;
        stages: Array<{ stage: string; state: string }>;
        artifacts: Array<{
          valid: boolean;
          media_type: string | null;
          size: number | null;
          note: string | null;
        }>;
        acceptance: string;
      };
      expect(report.job_id).toBeTruthy();
      expect(report.stages.map((s) => `${s.stage}:${s.state}`)).toEqual(EXPECTED_PODCAST_STAGES);
      const audio = report.artifacts.filter((a) => a.media_type?.startsWith("audio/"));
      expect(audio.length).toBeGreaterThanOrEqual(1);
      for (const a of audio) {
        expect(a.valid).toBe(true);
        expect(a.note).toBeNull();
        expect(a.size).toBeGreaterThan(0);
      }

      // Server-side ground truth: the job really SUCCEEDED with mock provenance.
      // (read while the DB is still open — stop() below closes it)
      const job = server.ctx.jobs.get(report.job_id!);
      expect(job?.status).toBe("SUCCEEDED");
      expect(job?.resultProvenance).toBe("mock");
      expect(job?.notebookId).toMatch(/^mock_nb_/);
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("negative control: no healthy proxy -> fail-closed FAILED (exit 1, no mock-verified verdict)", async () => {
    const server = await startLiveServer(false); // account only, NO proxy node
    const textFile = path.join(server.dir, "sample.txt");
    writeFileSync(textFile, SAMPLE_TEXT, "utf8");
    const reportPath = path.join(server.dir, "report.json");
    const token = server.ctx.apiTokens.create({
      name: "e2e-podcast-admin",
      scopes: ["admin"],
    }).plaintext;

    let res: ScriptResult;
    try {
      res = await runE2eScript(
        [
          "--scenario",
          "podcast",
          "--text-file",
          textFile,
          "--base",
          server.base,
          "--poll-ms",
          "200",
          "--timeout-ms",
          "60000",
          "--out",
          reportPath,
        ],
        { NLO_API_TOKEN: token },
      );
    } finally {
      await server.stop();
    }

    expect(res.code, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(1);
    const summary = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(summary.acceptance).toBe("FAIL");
    expect(summary.provenance).toBe("unknown");
  }, 120_000);
});
