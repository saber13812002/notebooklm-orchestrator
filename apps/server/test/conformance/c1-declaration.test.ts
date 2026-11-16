/**
 * NLO-P4-1D / C1 — Declaration lint (audit map §4.4).
 *
 * Every registered provider descriptor must lint clean against the canonical
 * contract: it parses against `providerDescriptorSchema`, declares each of
 * the 31 contract operations EXACTLY once, uses only the five honest
 * capability levels, and declares a sane `maxConcurrent`.
 *
 * Severity rules (spec): a stale `verifiedAt` (> 90 days) is a WARNING
 * (logged, not a failure); an unknown operation string is a FAILURE.
 *
 * F-C1 (honesty): the current NotebookLM worker fuses
 * `notebook.create + source.add.* + chat.ask` into one `job`/`job_text`
 * run, so the four fused operations MUST carry the explicit F-C1 fusion
 * note. This suite tests the DECLARATION (the adapter's lifecycle is
 * covered by C2–C6, not per-op wire calls).
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_LEVELS,
  FUSION_OPERATIONS,
  PROVIDER_OPERATIONS,
  type ProviderCapabilityDeclaration,
  type ProviderDescriptor,
} from "@nlo/shared";

import { deriveMockDescriptor, lintDescriptor } from "./runner.js";

function cap(d: ProviderDescriptor, op: string): ProviderCapabilityDeclaration {
  const c = d.capabilities.find((x) => x.operation === op);
  if (!c) throw new Error(`operation not declared: ${op}`);
  return c;
}

describe("C1 declaration lint (notebooklm.web, mock facts)", () => {
  const descriptor = deriveMockDescriptor();

  it("the derived descriptor lints clean (no errors)", () => {
    const { errors, warnings } = lintDescriptor(descriptor);
    expect(warnings, JSON.stringify(warnings, null, 2)).toEqual([]);
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
  });

  it("declares every one of the 31 contract operations exactly once", () => {
    const ops = descriptor.capabilities.map((c) => c.operation);
    expect(ops).toHaveLength(PROVIDER_OPERATIONS.length);
    for (const op of PROVIDER_OPERATIONS) {
      expect(
        ops.filter((o) => o === op),
        `operation ${op}`,
      ).toHaveLength(1);
    }
    expect(new Set(ops).size).toBe(PROVIDER_OPERATIONS.length);
  });

  it("uses only the five honest capability levels", () => {
    for (const c of descriptor.capabilities) {
      expect((CAPABILITY_LEVELS as readonly string[]).includes(c.level)).toBe(true);
    }
  });

  it("declares the honest identity: notebooklm.web, tunnel egress, serialized", () => {
    expect(descriptor.id).toBe("notebooklm.web");
    expect(descriptor.kind).toBe("native");
    expect(descriptor.egressPolicy).toBe("tunnel");
    expect(descriptor.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(descriptor.maxConcurrent).toBe(1); // mock adapter: serialized
    expect(descriptor.status).toBe("active");
  });

  it("F-C1: the four fused operations carry the explicit fusion note", () => {
    for (const op of FUSION_OPERATIONS) {
      const c = cap(descriptor, op);
      // Declared (backed by a live op) AND honestly annotated.
      expect(c.level, `level for ${op}`).not.toBe("unsupported");
      expect(c.note ?? "", `note for ${op}`).toContain("F-C1 fusion");
    }
  });

  it("undeclared contract operations are honestly `unsupported` (never guessed)", () => {
    // The mock/live worker does not offer e.g. video, slide decks, quizzes.
    const undeclared = descriptor.capabilities.filter((c) => c.level === "unsupported");
    expect(undeclared.length).toBeGreaterThan(0);
    expect(undeclared.map((c) => c.operation)).toContain("generate.video.explainer");
  });

  it("unknown operation string → lint ERROR (not a warning)", () => {
    const broken: ProviderDescriptor = {
      ...descriptor,
      capabilities: [
        ...descriptor.capabilities,
        { operation: "generate.hologram" as never, level: "implemented_tested" },
      ],
    };
    const { errors, warnings } = lintDescriptor(broken);
    // The schema's operation enum is the first line of defense, so the error
    // is reported there (naming the unknown op); the lint's dedicated
    // "unknown operation string" check is defense-in-depth for data that
    // bypasses the schema (e.g. legacy/partial descriptors).
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("generate.hologram"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("stale verifiedAt (> 90 days) → WARNING only, not a failure", () => {
    const stale: ProviderDescriptor = { ...descriptor, verifiedAt: "2020-01-01" };
    const { errors, warnings } = lintDescriptor(stale);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("older than 90 days"))).toBe(true);
  });

  it("schema violations (bad level, non-strict extra field) → lint ERRORS", () => {
    const badLevel = {
      ...descriptor,
      capabilities: descriptor.capabilities.map((c) =>
        c.operation === "notebook.create" ? { ...c, level: "meh" as never } : c,
      ),
    };
    expect(lintDescriptor(badLevel).errors.length).toBeGreaterThan(0);

    const extraField = { ...descriptor, surprise: true } as ProviderDescriptor;
    expect(lintDescriptor(extraField).errors.length).toBeGreaterThan(0);
  });
});
