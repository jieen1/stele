import type { RuleId, Violation, ViolationReport } from "@stele/core";

type ViolationOverrides = Partial<Omit<Violation, "rule_id">> & {
  rule_id?: string | RuleId;
};

function testRuleId(value: string | RuleId): RuleId {
  return value as RuleId;
}

export function makeViolation(overrides: ViolationOverrides = {}): Violation {
  return {
    rule_kind: "invariant",
    severity: "error",
    source: { tool: "@stele/cli", command: "check", kind: "invariant" },
    location: { path: "src/example.ts", line: 12 },
    cause: { summary: "Test summary" },
    fingerprint: "0".repeat(64),
    scope_paths: ["src/example.ts"],
    status: "active",
    ...overrides,
    rule_id: testRuleId(overrides.rule_id ?? "TEST_RULE"),
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
    rule_id: extras.rule_id ?? testRuleId("stele.report"),
  };
}
