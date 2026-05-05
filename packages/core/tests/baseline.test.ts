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
      rule_id: "ledger.balance_mismatch",
      rule_kind: "rule_violation",
      severity: "error",
      source: {
        tool: "ledger-checker",
        command: "check",
        kind: "rule",
      },
      location: {
        path: "src/payments.ts",
      },
      cause: {
        summary: "Payments remain unbalanced after settlement.",
      },
      scope_paths: ["contract/main.stele", "src/payments.ts"],
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

  it("suppresses only synthetic rule violations and keeps tool-integrity failures active even outside diff scope", () => {
    const legacyRuleViolation = createViolation({
      rule_id: "ledger.balance_mismatch",
      rule_kind: "rule_violation",
      severity: "error",
      source: {
        tool: "ledger-checker",
        command: "check",
        kind: "rule",
      },
      location: {
        path: "src/payments.ts",
      },
      cause: {
        summary: "Payments remain unbalanced after settlement.",
      },
      scope_paths: ["contract/main.stele", "src/payments.ts"],
    });
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
    const protectedFileDrift = createViolation({
      rule_id: "stele.check.protected_file_drift",
      rule_kind: "protected_file_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "protected",
      },
      location: {
        manifest_path: "contract/.manifest.json",
      },
      cause: {
        summary: "Found new/unlocked protected files.",
        new_files: ["contract/.baseline.json"],
      },
      scope_paths: ["contract/.manifest.json", "contract/.baseline.json"],
    });
    const contractHashMismatch = createViolation({
      rule_id: "stele.check.contract_hash_mismatch",
      rule_kind: "contract_hash_mismatch",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "contract",
      },
      location: {
        path: "contract/main.stele",
        manifest_path: "contract/.manifest.json",
      },
      cause: {
        summary: "Manifest contract hash does not match the current contract.",
        expected_hash: "expected",
        actual_hash: "actual",
      },
      scope_paths: ["contract/main.stele", "contract/.manifest.json"],
    });
    const executionError = createViolation({
      rule_id: "stele.check.execution_error",
      rule_kind: "execution_error",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "execution",
      },
      location: {
        path: "stele.config.json",
      },
      cause: {
        summary: "Config execution failed.",
      },
      scope_paths: ["stele.config.json"],
    });
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        violation_count: 6,
      },
      violations: [legacyRuleViolation, generatedDrift, manifestDrift, protectedFileDrift, contractHashMismatch, executionError],
    });
    const baseline = createViolationBaseline({
      reason: "initial legacy adoption",
      violations: [legacyRuleViolation],
      generatedAt: "2026-05-05T00:00:00.000Z",
    });
    const filtered = filterViolationReport(report, {
      baseline,
      diffScopePaths: ["contract/main.stele", "notes.md"],
      isSuppressible: (violation) => violation.rule_kind === "rule_violation" && violation.source.kind === "rule",
    });

    expect(filtered.ok).toBe(false);
    expect(filtered.summary).toMatchObject({
      violation_count: 6,
      active_violation_count: 5,
      suppressed_violation_count: 1,
      out_of_scope_violation_count: 0,
    });
    expect(filtered.violations).toMatchObject([
      {
        rule_id: "ledger.balance_mismatch",
        status: "suppressed",
        suppressed_by: "baseline",
      },
      {
        rule_id: "stele.check.generated_drift",
        status: "active",
      },
      {
        rule_id: "stele.check.manifest_drift",
        status: "active",
      },
      {
        rule_id: "stele.check.protected_file_drift",
        status: "active",
      },
      {
        rule_id: "stele.check.contract_hash_mismatch",
        status: "active",
      },
      {
        rule_id: "stele.check.execution_error",
        status: "active",
      },
    ]);
  });
});
