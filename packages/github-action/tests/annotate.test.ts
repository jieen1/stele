import { describe, expect, it } from "vitest";
import { emitAnnotations, MAX_ERROR_ANNOTATIONS, MAX_WARNING_ANNOTATIONS } from "../src/annotate.js";
import type { Violation } from "@stele/core";

function makeViolation(severity: "error" | "warning", ruleId: string): Violation {
  return {
    rule_id: ruleId,
    severity,
    cause: { summary: "Test violation", kind: "check" },
    source: { kind: "check", source: "tests/contract/test_main.py" },
    location: { path: "tests/contract/test_main.py", line: 1, column: 1 },
    fingerprint: "abc123",
    rule_kind: "invariant",
    scope_paths: [],
    status: "active",
    fix: { summary: "Fix it" },
  };
}

describe("emitAnnotations", () => {
  function createMockSink() {
    const errors: Array<{ message: string; properties?: object }> = [];
    const warnings: Array<{ message: string; properties?: object }> = [];
    const notices: string[] = [];
    const sink = {
      error: (message: string, properties?: object) => errors.push({ message, properties }),
      warning: (message: string, properties?: object) => warnings.push({ message, properties }),
      notice: (message: string) => notices.push(message),
    };
    return { sink, errors, warnings, notices };
  }

  it("emits error annotations", () => {
    const { sink, errors } = createMockSink();
    const violations = [makeViolation("error", "TEST_RULE")];
    emitAnnotations(violations, 1, false, sink);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("Test violation");
  });

  it("emits warning annotations", () => {
    const { sink, warnings } = createMockSink();
    const violations = [makeViolation("warning", "WARN_RULE")];
    emitAnnotations(violations, 1, false, sink);
    expect(warnings).toHaveLength(1);
  });

  it("caps error annotations at MAX_ERROR_ANNOTATIONS", () => {
    const { sink, errors } = createMockSink();
    const violations = Array.from({ length: MAX_ERROR_ANNOTATIONS + 10 }, (_, i) => makeViolation("error", `RULE-${i}`));
    emitAnnotations(violations, violations.length, false, sink);
    expect(errors).toHaveLength(MAX_ERROR_ANNOTATIONS);
  });

  it("caps warning annotations at MAX_WARNING_ANNOTATIONS", () => {
    const { sink, warnings } = createMockSink();
    const violations = Array.from({ length: MAX_WARNING_ANNOTATIONS + 10 }, (_, i) => makeViolation("warning", `RULE-${i}`));
    emitAnnotations(violations, violations.length, false, sink);
    expect(warnings).toHaveLength(MAX_WARNING_ANNOTATIONS);
  });

  it("emits notice when truncated", () => {
    const { sink, notices } = createMockSink();
    const violations = Array.from({ length: 100 }, (_, i) => makeViolation("error", `RULE-${i}`));
    emitAnnotations(violations, 100, true, sink);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]).toContain("See PR comment for full list");
  });

  it("handles violations without path", () => {
    const { sink, errors } = createMockSink();
    const v = makeViolation("error", "NO_PATH");
    v.location = undefined as any;
    emitAnnotations([v], 1, false, sink);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^Stele:/);
  });

  it("MAX constants are 50", () => {
    expect(MAX_ERROR_ANNOTATIONS).toBe(50);
    expect(MAX_WARNING_ANNOTATIONS).toBe(50);
  });
});
