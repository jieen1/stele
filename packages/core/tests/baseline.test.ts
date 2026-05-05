import { describe, expect, it } from "vitest";
import {
  createViolation,
  createViolationBaseline,
  createViolationReport,
  filterViolationReport,
} from "../src/index";

describe("baseline filtering", () => {
  it("preserves first_seen for recurring fingerprints when the baseline is updated", () => {
    const violation = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        generated_dir: "tests/contract",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/test_contract.py"],
      },
      scope_paths: ["contract/main.stele", "tests/contract/test_contract.py"],
    });
    const initial = createViolationBaseline({
      reason: "initial legacy adoption",
      violations: [violation],
      generatedAt: "2026-05-05T00:00:00.000Z",
    });
    const updated = createViolationBaseline({
      reason: "approved legacy fix",
      violations: [violation],
      existing: initial,
      generatedAt: "2026-05-06T00:00:00.000Z",
    });

    expect(initial.violations[violation.fingerprint]).toMatchObject({
      first_seen: "2026-05-05T00:00:00.000Z",
    });
    expect(updated.violations[violation.fingerprint]).toMatchObject({
      first_seen: "2026-05-05T00:00:00.000Z",
    });
    expect(updated.reason).toBe("approved legacy fix");
  });

  it("marks baseline and diff-scope suppressions in the report summary", () => {
    const generatedDrift = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        generated_dir: "tests/contract",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/test_contract.py"],
      },
      scope_paths: ["contract/main.stele", "tests/contract/test_contract.py"],
    });
    const manifestDrift = createViolation({
      rule_id: "stele.check.manifest_drift",
      rule_kind: "manifest_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "manifest",
      },
      location: {
        manifest_path: "contract/.manifest.json",
      },
      cause: {
        summary: "Manifest verification failed.",
        changed: ["contract/checker_impls/custom_checker.py"],
      },
      scope_paths: ["contract/.manifest.json", "contract/checker_impls/custom_checker.py"],
    });
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        violation_count: 2,
      },
      violations: [generatedDrift, manifestDrift],
    });
    const baseline = createViolationBaseline({
      reason: "initial legacy adoption",
      violations: [generatedDrift],
      generatedAt: "2026-05-05T00:00:00.000Z",
    });
    const filtered = filterViolationReport(report, {
      baseline,
      diffScopePaths: ["contract/main.stele", "notes.md"],
      isSuppressible: () => true,
    });

    expect(filtered.ok).toBe(true);
    expect(filtered.summary).toMatchObject({
      violation_count: 2,
      active_violation_count: 0,
      suppressed_violation_count: 1,
      out_of_scope_violation_count: 1,
    });
    expect(filtered.violations).toMatchObject([
      {
        rule_id: "stele.check.generated_drift",
        status: "suppressed",
        suppressed_by: "baseline",
      },
      {
        rule_id: "stele.check.manifest_drift",
        status: "out_of_scope",
      },
    ]);
  });
});
