import { describe, expect, it } from "vitest";
import {
  createViolation,
  createViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
} from "../src/index";

describe("violation reporting", () => {
  it("creates a stable fingerprint from deterministic violation content", () => {
    const base = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        path: "tests/contract/test_contract.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/test_contract.py"],
        missing: [],
        extra: [],
      },
      scope_paths: ["tests/contract/test_contract.py", "contract/main.stele"],
      fix: {
        summary: "Re-run stele generate --force to replace generated files.",
        command: "stele generate --force",
      },
    });
    const reordered = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        command: "check",
        kind: "generated",
        tool: "stele",
      },
      location: {
        path: "tests/contract/test_contract.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        extra: [],
        changed: ["tests/contract/test_contract.py"],
        missing: [],
      },
      scope_paths: ["contract/main.stele", "tests/contract/test_contract.py"],
      fix: {
        command: "stele generate --force",
        summary: "Re-run stele generate --force to replace generated files.",
      },
    });
    const changed = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        path: "tests/contract/_stele_runtime.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/_stele_runtime.py"],
        missing: [],
        extra: [],
      },
      scope_paths: ["tests/contract/_stele_runtime.py", "contract/main.stele"],
      fix: {
        summary: "Re-run stele generate --force to replace generated files.",
        command: "stele generate --force",
      },
    });

    expect(base.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.fingerprint).toBe(base.fingerprint);
    expect(changed.fingerprint).not.toBe(base.fingerprint);
  });

  it("formats active violations with rule metadata, precise location, fix command, and fingerprint prefix", () => {
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        violation_count: 3,
        active_violation_count: 1,
        suppressed_violation_count: 1,
        out_of_scope_violation_count: 1,
      },
      violations: [
        createViolation({
          rule_id: "stele.check.manifest_drift",
          rule_kind: "manifest_drift",
          severity: "error",
          source: {
            tool: "stele",
            command: "check",
            kind: "manifest",
          },
          location: {
            path: "contract/main.stele",
            line: 14,
            column: 3,
          },
          cause: {
            summary: "Manifest verification failed.",
            missing: ["contract/checker_impls/old_checker.py"],
            changed: ["contract/checker_impls/custom_checker.py"],
            expected_hash: "aaaabbbbccccdddd",
            actual_hash: "1111222233334444",
          },
          scope_paths: ["contract/main.stele", "contract/checker_impls/custom_checker.py"],
          fix: {
            summary: "Refresh the manifest after the protected change is approved.",
            command: "stele lock --reason approved-checker-update",
          },
        }),
        createViolation({
          rule_id: "stele.check.generated_drift",
          rule_kind: "generated_drift",
          severity: "warning",
          source: {
            tool: "stele",
            command: "check",
            kind: "generated",
          },
          location: {
            generated_dir: "tests/contract",
          },
          cause: {
            summary: "Generated files differ.",
          },
          scope_paths: ["tests/contract/test_contract.py"],
          status: "suppressed",
          suppressed_by: "baseline",
        }),
        createViolation({
          rule_id: "stele.shape.out_of_scope",
          rule_kind: "code_shape",
          severity: "info",
          source: {
            tool: "stele",
            command: "diff",
            kind: "shape",
          },
          location: {
            manifest_path: "contract/.manifest.json",
          },
          cause: {
            summary: "Ignored for this run.",
          },
          scope_paths: ["contract/.manifest.json"],
          status: "out_of_scope",
        }),
      ],
    });

    const output = formatViolationReportHuman(report);

    expect(output).toContain("[error] stele.check.manifest_drift");
    expect(output).toContain("source: manifest/check");
    expect(output).toContain("location: contract/main.stele:14:3");
    expect(output).toContain("summary: Manifest verification failed.");
    expect(output).toContain("missing: contract/checker_impls/old_checker.py");
    expect(output).toContain("changed: contract/checker_impls/custom_checker.py");
    expect(output).toContain("expected_hash: aaaabbbbccccdddd");
    expect(output).toContain("actual_hash: 1111222233334444");
    expect(output).toContain("fix: Refresh the manifest after the protected change is approved.");
    expect(output).toContain("command: stele lock --reason approved-checker-update");
    expect(output).toContain(`fingerprint: ${report.violations[0]!.fingerprint.slice(0, 12)}`);
    expect(output).not.toContain("stele.check.generated_drift");
    expect(output).not.toContain("stele.shape.out_of_scope");
    expect(output).toContain("1 baseline violation suppressed.");
    expect(output).toContain("1 out-of-scope violation ignored.");
  });

  it("preserves full fields in json reports while adding optional line and column", () => {
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        violation_count: 1,
      },
      violations: [
        createViolation({
          rule_id: "stele.check.generated_drift",
          rule_kind: "generated_drift",
          severity: "error",
          source: {
            tool: "stele",
            command: "check",
            kind: "generated",
          },
          location: {
            path: "tests/contract/test_contract.py",
            line: 9,
            column: 5,
          },
          cause: {
            summary: "Generated files do not match the contract.",
            extra: ["tests/contract/extra.py"],
          },
          scope_paths: ["tests/contract/test_contract.py", "tests/contract/extra.py"],
        }),
      ],
    });

    const parsed = JSON.parse(formatViolationReportJson(report)) as {
      schema_version: string;
      violations: Array<{
        location: {
          path?: string;
          line?: number;
          column?: number;
        };
        fingerprint: string;
      }>;
    };

    expect(parsed.schema_version).toBe("1");
    expect(parsed.violations[0]).toMatchObject({
      location: {
        path: "tests/contract/test_contract.py",
        line: 9,
        column: 5,
      },
    });
    expect(parsed.violations[0]!.fingerprint).toBe(report.violations[0]!.fingerprint);
  });
});
