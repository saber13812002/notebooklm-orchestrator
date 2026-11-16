/**
 * NLO-P4-1D: Provider conformance suite runner (audit map §4.4).
 *
 * Shared infrastructure for the six conformance suites C1–C6 that run in CI
 * against the mock provider standing in for `notebooklm.web`:
 *
 *   C1 declaration lint     c1-declaration.test.ts
 *   C2 capability honesty   c2-honesty.test.ts   (tests named `c2:<provider>:<op>`)
 *   C3 lifecycle            c3-lifecycle.test.ts
 *   C4 failure classes      c4-failure.test.ts
 *   C5 concurrency          c5-concurrency.test.ts
 *   C6 egress boundary      c6-egress.test.ts
 *
 * C7 (live, real NotebookLM) is a MANUAL gate and is NEVER run here or in CI.
 *
 * A provider is `active` in the registry only when C1–C6 are all green.
 *
 * Self-executing mode (for the phase report): run this file directly and it
 * spawns `vitest run test/conformance`, then prints the provider × C1–C6
 * PASS/FAIL table:
 *
 *   npx tsx apps/server/test/conformance/runner.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPABILITY_LEVELS,
  PROVIDER_OPERATIONS,
  deriveNotebookLmDescriptor,
  providerDescriptorSchema,
  type ProviderDescriptor,
} from "@nlo/shared";
import { MockProvider } from "../../src/providers/mock-provider.js";
import { addAccount, addNode, makeParts, markHealthy, type TestParts } from "../helpers.js";

/** The provider under conformance in this suite (mock adapter, honest levels). */
export const CONFORMANCE_PROVIDER_ID = "notebooklm.web";

const VERIFIED_AT_STALE_DAYS = 90;

/**
 * Build the descriptor the same way the server does for
 * GET /api/v1/capabilities: derived from the running provider's live facts,
 * never hand-written.
 */
export function deriveMockDescriptor(): ProviderDescriptor {
  const provider = new MockProvider();
  try {
    return deriveNotebookLmDescriptor({
      name: provider.name,
      isMock: true,
      capabilities: provider.capabilities(),
      inputCapabilities: provider.inputCapabilities(),
    });
  } finally {
    provider.dispose();
  }
}

/**
 * C1 lint (the unit-level declaration check).
 *
 * `errors`   → non-conformant (the suite fails).
 * `warnings` → informational only (e.g. stale verifiedAt); logged, not fatal.
 */
export function lintDescriptor(d: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = providerDescriptorSchema.safeParse(d);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`schema: ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return { errors, warnings };
  }
  const descriptor = parsed.data;

  const ops = descriptor.capabilities.map((c) => c.operation);
  for (const op of PROVIDER_OPERATIONS) {
    const count = ops.filter((o) => o === op).length;
    if (count !== 1) {
      errors.push(`operation ${op}: declared ${count} times (expected exactly 1)`);
    }
  }
  for (const op of ops) {
    if (!(PROVIDER_OPERATIONS as readonly string[]).includes(op)) {
      errors.push(`unknown operation string: ${op}`);
    }
  }
  for (const cap of descriptor.capabilities) {
    if (!(CAPABILITY_LEVELS as readonly string[]).includes(cap.level)) {
      errors.push(`operation ${cap.operation}: unknown level "${cap.level}"`);
    }
  }
  if (!Number.isInteger(descriptor.maxConcurrent) || descriptor.maxConcurrent < 1) {
    errors.push(`maxConcurrent must be an integer >= 1 (got ${descriptor.maxConcurrent})`);
  }

  // Stale verification evidence: a warning, not a failure (audit map §4.4 C1).
  const verifiedAt = new Date(`${descriptor.verifiedAt}T00:00:00Z`);
  if (Number.isNaN(verifiedAt.getTime())) {
    errors.push(`verifiedAt is not a valid date: ${descriptor.verifiedAt}`);
  } else if (Date.now() - verifiedAt.getTime() > VERIFIED_AT_STALE_DAYS * 24 * 3600 * 1000) {
    warnings.push(
      `verifiedAt ${descriptor.verifiedAt} is older than ${VERIFIED_AT_STALE_DAYS} days — re-verify the descriptor evidence`,
    );
  }

  return { errors, warnings };
}

/** The conformance suite registry. C7 is manual/live and never run in CI. */
export const CONFORMANCE_SUITES = [
  { id: "C1", file: "c1-declaration.test.ts", title: "declaration lint" },
  { id: "C2", file: "c2-honesty.test.ts", title: "capability honesty" },
  { id: "C3", file: "c3-lifecycle.test.ts", title: "lifecycle" },
  { id: "C4", file: "c4-failure.test.ts", title: "failure classes" },
  { id: "C5", file: "c5-concurrency.test.ts", title: "concurrency" },
  { id: "C6", file: "c6-egress.test.ts", title: "egress boundary" },
  { id: "C7", file: null, title: "live (manual gate)" },
] as const;

/** Discover the c1..c6 suite files that actually exist in this directory. */
export function discoverSuites(): string[] {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return readdirSync(dir)
    .filter((f) => /^c[1-6][\w-]*\.test\.ts$/.test(f))
    .sort();
}

/** Poll `cond` every 10ms until true or the timeout elapses. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Isolated happy-path conformance fixture: parts + one ACTIVE account + one
 * healthy proxy node. Test files must track parts in a local list and
 * `dispose()` in `afterEach`.
 */
export function makeConformanceParts(): TestParts & { accountId: string; nodeId: string } {
  const parts = makeParts();
  const accountId = addAccount(parts.accounts, "conformance@example.com").id;
  const nodeId = addNode(parts.proxies, parts.vault, "conformance-node").id;
  markHealthy(parts.proxies, nodeId);
  return { ...parts, accountId, nodeId };
}

export type SuiteResult = "PASS" | "FAIL" | "NOT RUN";

/** Print the provider × C1–C6 conformance table (for the phase report). */
export function printConformanceTable(results: Record<string, SuiteResult>): void {
  console.log(`Provider conformance table (NLO-P4-1D)`);
  console.log(`provider: ${CONFORMANCE_PROVIDER_ID}`);
  for (const s of CONFORMANCE_SUITES) {
    const r: SuiteResult = s.id === "C7" ? "NOT RUN" : (results[s.id] ?? "NOT RUN");
    const label = `${s.id} ${s.title}`.padEnd(30);
    console.log(`  ${label} ${r}`);
  }
  const failed = CONFORMANCE_SUITES.filter((s) => s.id !== "C7" && results[s.id] !== "PASS");
  console.log(
    failed.length === 0
      ? "result: C1–C6 all PASS (mock level — Live NOT verified; C7 is a manual gate)"
      : `result: ${failed.map((s) => s.id).join(", ")} not green`,
  );
}

interface VitestJsonFileResult {
  name: string;
  status: string;
}
interface VitestJsonReport {
  success: boolean;
  testResults: VitestJsonFileResult[];
}

/**
 * Self-executing entry: run all discovered C1–C6 suites via vitest and print
 * the conformance table. C7 is never run here (manual live gate).
 *
 * vitest 3 writes the JSON report to a file (`--outputFile`); read it back
 * and clean it up afterwards.
 */
function main(): void {
  // here = <repo>/apps/server/test/conformance → the repo root is four up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..", "..");
  const serverRoot = path.join(repoRoot, "apps", "server");
  const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const reportFile = path.join(here, ".conformance-report.json");

  const res = spawnSync(
    process.execPath,
    [vitestEntry, "run", "test/conformance", "--reporter=json", "--outputFile", reportFile],
    { cwd: serverRoot, encoding: "utf8", timeout: 120_000 },
  );

  let report: VitestJsonReport | null = null;
  if (existsSync(reportFile)) {
    try {
      report = JSON.parse(readFileSync(reportFile, "utf8")) as VitestJsonReport;
    } catch {
      report = null;
    }
    rmSync(reportFile, { force: true });
  }

  const files = discoverSuites();
  const results: Record<string, SuiteResult> = {};
  for (const s of CONFORMANCE_SUITES) {
    if (s.id === "C7" || !s.file) continue;
    if (!files.includes(s.file)) {
      results[s.id] = "NOT RUN";
      continue;
    }
    const fileResult = report?.testResults.find((r) => r.name.split(/[\\/]/).pop() === s.file);
    results[s.id] = fileResult?.status === "passed" ? "PASS" : "FAIL";
  }

  printConformanceTable(results);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exitCode = Object.values(results).every((r) => r === "PASS") ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) main();
