import { describe, expect, it } from "vitest";

import { createViolation, type Violation } from "@stele/core";

import { annotateCrossRuleViolations } from "../src/cross-rule-dedup.js";

function mkViolation(opts: {
  ruleId: string;
  groupId?: string;
  severity?: "error" | "warning";
}): Violation {
  return createViolation({
    rule_id: opts.ruleId,
    rule_kind: "trace_violation",
    severity: opts.severity ?? "error",
    source: { tool: "stele", command: "check", kind: "trace" },
    location: { path: "src/x.ts" },
    cause: { summary: opts.ruleId },
    scope_paths: ["src/x.ts"],
    group_id: opts.groupId,
  });
}

describe("annotateCrossRuleViolations", () => {
  it("two violations with same group_id reference each other", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.missing_transit", groupId: "src/x.ts::F(0)" }),
      mkViolation({
        ruleId: "trace.B.missing_predecessor",
        groupId: "src/x.ts::F(0)",
      }),
    ];
    const result = annotateCrossRuleViolations(vs);
    expect(result).toHaveLength(2);
    expect(result[0]!.also_violates).toEqual(["trace.B.missing_predecessor"]);
    expect(result[1]!.also_violates).toEqual(["trace.A.missing_transit"]);
    expect(result[0]!.cross_rule_note).toBeDefined();
    expect(result[1]!.cross_rule_note).toBeDefined();
  });

  it("three violations same group_id get correct also_violates lists", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1", groupId: "src/x.ts::F(0)" }),
      mkViolation({ ruleId: "trace.B.kind2", groupId: "src/x.ts::F(0)" }),
      mkViolation({ ruleId: "trace.C.kind3", groupId: "src/x.ts::F(0)" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    expect(result[0]!.also_violates).toEqual([
      "trace.B.kind2",
      "trace.C.kind3",
    ]);
    expect(result[1]!.also_violates).toEqual([
      "trace.A.kind1",
      "trace.C.kind3",
    ]);
    expect(result[2]!.also_violates).toEqual([
      "trace.A.kind1",
      "trace.B.kind2",
    ]);
  });

  it("different group_ids do not cross-reference", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1", groupId: "src/x.ts::F(0)" }),
      mkViolation({ ruleId: "trace.B.kind2", groupId: "src/y.ts::G(0)" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    expect(result[0]!.also_violates).toBeUndefined();
    expect(result[1]!.also_violates).toBeUndefined();
    expect(result[0]!.cross_rule_note).toBeUndefined();
    expect(result[1]!.cross_rule_note).toBeUndefined();
  });

  it("empty / undefined group_id is not annotated", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1" }),
      mkViolation({ ruleId: "trace.B.kind2" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    expect(result[0]!.also_violates).toBeUndefined();
    expect(result[1]!.also_violates).toBeUndefined();
  });

  it("cross_rule_note set only when bucket size >= 2 with distinct rule_ids", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1", groupId: "g1" }),
      mkViolation({ ruleId: "trace.B.kind2", groupId: "g1" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    for (const v of result) {
      expect(v.cross_rule_note).toMatch(/Multiple rules flag/);
    }
  });

  it("single violation in group is left untouched", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1", groupId: "lonely" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    expect(result[0]!.also_violates).toBeUndefined();
    expect(result[0]!.cross_rule_note).toBeUndefined();
  });

  it("duplicate rule_id within bucket is filtered out of also_violates", () => {
    const vs = [
      mkViolation({ ruleId: "trace.A.kind1", groupId: "g1" }),
      mkViolation({ ruleId: "trace.A.kind1", groupId: "g1" }),
      mkViolation({ ruleId: "trace.B.kind2", groupId: "g1" }),
    ];
    const result = annotateCrossRuleViolations(vs);
    // First violation: other rule_ids exclude self, so {B.kind2} only.
    expect(result[0]!.also_violates).toEqual(["trace.B.kind2"]);
    expect(result[2]!.also_violates).toEqual(["trace.A.kind1"]);
  });

  it("empty input returns empty output", () => {
    expect(annotateCrossRuleViolations([])).toEqual([]);
  });
});
