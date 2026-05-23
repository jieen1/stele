import { describe, expect, it } from "vitest";
import { annotateCrossRuleViolations, createViolation } from "../src/index.js";
import type { Violation, ViolationInput } from "../src/index.js";

function mk(input: Partial<ViolationInput> & { rule_id: string; group_id?: string }): Violation {
  const { rule_id, group_id, ...rest } = input;
  return createViolation({
    rule_kind: rule_id.split(".")[0] + "_violation",
    severity: "error",
    source: { tool: "stele", command: "check", kind: "test" },
    location: { path: "src/x.ts" },
    cause: { summary: "x" },
    scope_paths: ["src/x.ts"],
    group_id,
    ...rest,
    rule_id,
  });
}

describe("annotateCrossRuleViolations — Round 3 P1-4 cross-evaluator coverage", () => {
  it("ignores violations without a group_id", () => {
    const inputs = [mk({ rule_id: "trace.A.foo" }), mk({ rule_id: "effect.B.bar" })];
    const result = annotateCrossRuleViolations(inputs);
    for (const v of result) {
      expect(v.also_violates).toBeUndefined();
      expect(v.cross_rule_note).toBeUndefined();
    }
  });

  it("cross-references trace + effect + typestate violations sharing a group_id", () => {
    const group = "src/x.ts::Foo::run(0)";
    const inputs = [
      mk({ rule_id: "trace.RULE_T.missing_transit", group_id: group }),
      mk({ rule_id: "effect.RULE_E.forbidden_effect", group_id: group }),
      mk({ rule_id: "typestate.RULE_TS.disallowed_op", group_id: group }),
    ];
    const result = annotateCrossRuleViolations(inputs);
    for (const v of result) {
      expect(v.cross_rule_note).toContain("Multiple rules");
    }
    const traceVio = result.find((v) => v.rule_id === "trace.RULE_T.missing_transit")!;
    expect(traceVio.also_violates).toEqual([
      "effect.RULE_E.forbidden_effect",
      "typestate.RULE_TS.disallowed_op",
    ]);
    const effectVio = result.find((v) => v.rule_id === "effect.RULE_E.forbidden_effect")!;
    expect(effectVio.also_violates).toEqual([
      "trace.RULE_T.missing_transit",
      "typestate.RULE_TS.disallowed_op",
    ]);
  });

  it("is idempotent — re-running on its own output does not change fields", () => {
    const group = "src/x.ts::Foo::run(0)";
    const inputs = [
      mk({ rule_id: "trace.A.foo", group_id: group }),
      mk({ rule_id: "effect.B.bar", group_id: group }),
    ];
    const once = annotateCrossRuleViolations(inputs);
    const twice = annotateCrossRuleViolations(once);
    expect(twice[0].also_violates).toEqual(once[0].also_violates);
    expect(twice[0].cross_rule_note).toBe(once[0].cross_rule_note);
    expect(twice[1].also_violates).toEqual(once[1].also_violates);
  });

  it("does not annotate when a group contains only one rule_id (duplicates)", () => {
    const group = "src/x.ts::Foo::run(0)";
    const inputs = [
      mk({ rule_id: "trace.A.foo", group_id: group }),
      mk({ rule_id: "trace.A.foo", group_id: group }),
    ];
    const result = annotateCrossRuleViolations(inputs);
    for (const v of result) {
      expect(v.also_violates).toBeUndefined();
      expect(v.cross_rule_note).toBeUndefined();
    }
  });
});
