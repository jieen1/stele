import { describe, expect, it } from "vitest";
import { isBaselineEligibleViolation } from "../src/report/filters.js";
import type { RuleId, Violation, ViolationSource } from "@stele/core";

type ViolationOverrides = Partial<Omit<Violation, "rule_id">> & {
  rule_id?: RuleId | string;
};

function makeSource(kind: string): ViolationSource {
  return { tool: "stele", command: "check", kind };
}

function testRuleId(value: RuleId | string): RuleId {
  return value as RuleId;
}

function makeViolation(overrides: ViolationOverrides = {}): Violation {
  const { rule_id: overrideRuleId, ...rest } = overrides;
  return {
    rule_kind: "rule_violation",
    severity: "error",
    source: makeSource("rule"),
    location: { path: "src/test.ts", line: 1, column: 1 },
    cause: { summary: "Test violation" },
    status: "active",
    fingerprint: "test-fingerprint",
    scope_paths: ["src/test.ts"],
    ...rest,
    rule_id: testRuleId(overrideRuleId ?? "test-rule"),
  };
}

// ---------------------------------------------------------------------------
// Rule violations (original behavior)
// ---------------------------------------------------------------------------

describe("isBaselineEligibleViolation — rule violations", () => {
  it("accepts standard rule violations", () => {
    const violation = makeViolation();
    expect(isBaselineEligibleViolation(violation)).toBe(true);
  });

  it("rejects stele.check.* rule IDs", () => {
    const violation = makeViolation({
      rule_id: "stele.check.import-order",
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  // @tcb-negative baseline-init
  it("rejects non-rule source kinds", () => {
    const violation = makeViolation({
      source: makeSource("code_shape"),
      rule_kind: "code_shape_violation",
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Architecture violations
// ---------------------------------------------------------------------------

describe("isBaselineEligibleViolation — architecture violations", () => {
  it("accepts architecture_dependency violations", () => {
    const violation = makeViolation({
      rule_id: "architecture.core-arch.api.infra",
      rule_kind: "architecture_dependency",
      source: makeSource("architecture"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(true);
  });

  it("accepts architecture_cycle violations", () => {
    const violation = makeViolation({
      rule_id: "architecture.cycle-arch.a.b",
      rule_kind: "architecture_cycle",
      source: makeSource("architecture"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(true);
  });

  it("rejects architecture violations with stele.check.* prefix", () => {
    const violation = makeViolation({
      rule_id: "stele.check.arch",
      rule_kind: "architecture_dependency",
      source: makeSource("architecture"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Design integrity violations
// ---------------------------------------------------------------------------

describe("isBaselineEligibleViolation — design integrity violations", () => {
  it("accepts design_integrity violations with design source kind", () => {
    const violation = makeViolation({
      rule_id: "design_integrity.violation",
      rule_kind: "design_integrity",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(true);
  });

  it("rejects design_integrity with wrong source kind", () => {
    const violation = makeViolation({
      rule_id: "design_integrity.violation",
      rule_kind: "design_integrity",
      source: makeSource("rule"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects design source kind with wrong rule_kind", () => {
    const violation = makeViolation({
      rule_id: "design.something",
      rule_kind: "other_kind",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects design_integrity violations with stele.check.* prefix", () => {
    const violation = makeViolation({
      rule_id: "stele.check.design",
      rule_kind: "design_integrity",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("isBaselineEligibleViolation — edge cases", () => {
  it("rejects unknown rule_kind", () => {
    const violation = makeViolation({
      rule_kind: "unknown_kind",
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects architecture rule_kind with wrong source kind", () => {
    const violation = makeViolation({
      rule_kind: "architecture_dependency",
      source: makeSource("rule"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects rule_violation with architecture source kind", () => {
    const violation = makeViolation({
      rule_kind: "rule_violation",
      source: makeSource("architecture"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects empty source kind", () => {
    const violation = makeViolation({
      source: makeSource(""),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design integrity violations
// ---------------------------------------------------------------------------

describe("isBaselineEligibleViolation — design integrity violations", () => {
  it("accepts design_integrity violations", () => {
    const violation = makeViolation({
      rule_id: "design_integrity.violation",
      rule_kind: "design_integrity",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(true);
  });

  it("rejects design_integrity with wrong source kind", () => {
    const violation = makeViolation({
      rule_id: "design_integrity.violation",
      rule_kind: "design_integrity",
      source: makeSource("rule"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects design source with wrong rule_kind", () => {
    const violation = makeViolation({
      rule_id: "design.some_rule",
      rule_kind: "design_other",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });

  it("rejects design_integrity with stele.check.* prefix", () => {
    const violation = makeViolation({
      rule_id: "stele.check.design_integrity",
      rule_kind: "design_integrity",
      source: makeSource("design"),
    });
    expect(isBaselineEligibleViolation(violation)).toBe(false);
  });
});
