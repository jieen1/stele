import type { Violation, ViolationReport } from "@stele/core";

export function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    rule_id: "TEST_RULE",
    rule_kind: "invariant",
    severity: "error",
    source: { tool: "@stele/cli", command: "check", kind: "invariant" },
    location: { path: "src/example.ts", line: 12 },
    cause: { summary: "Test summary" },
    fingerprint: "0".repeat(64),
    scope_paths: ["src/example.ts"],
    status: "active",
    ...overrides,
  };
}

export function makeReport(violations: Violation[], extras: Partial<ViolationReport> = {}): ViolationReport {
  return {
    schema_version: "1",
    tool: "@stele/cli",
    command: "check",
    ok: violations.length === 0,
    summary: {
      violation_count: violations.length,
      active_violation_count: violations.filter((v) => v.status !== "suppressed").length,
    },
    violations,
    notices: [],
    ...extras,
  };
}
