import { describe, expect, it } from "vitest";
import { renderComment, renderViolation, COMMENT_MARKER, ACTION_VERSION } from "../src/pr-comment.js";
import type { Violation, ViolationReport } from "@stele/core";

function makeViolation(ruleId: string, severity: "error" | "warning" = "error"): Violation {
  return {
    rule_id: ruleId,
    severity,
    cause: { summary: `Violation of ${ruleId}`, kind: "check" },
    source: { kind: "check", source: "test_main.py" },
    location: { path: "test_main.py", line: 42, column: 1 },
    fingerprint: "fp-123",
    rule_kind: "invariant",
    scope_paths: [],
    status: "active",
    fix: { summary: "Fix it" },
  };
}

function makeReport(): ViolationReport {
  return {
    schema_version: "1",
    tool: "stele",
    command: "check",
    ok: false,
    violations: [],
    notices: [],
    summary: {
      violation_count: 0,
    },
  };
}

describe("renderComment", () => {
  it("includes comment marker", () => {
    const comment = renderComment([], makeReport(), 123, "https://github.com/runs/123", () => new Date("2026-01-01"));
    expect(comment).toContain(COMMENT_MARKER);
  });

  it("shows passing status when no violations", () => {
    const comment = renderComment([], makeReport(), 123, "https://github.com/runs/123", () => new Date("2026-01-01"));
    expect(comment).toContain("Passing");
  });

  it("shows violation count", () => {
    const violations = [makeViolation("RULE_A")];
    const report = makeReport();
    const comment = renderComment(violations, report, 123, "https://github.com/runs/123", () => new Date("2026-01-01"));
    expect(comment).toContain("1 violation");
  });

  it("includes timestamp and action version", () => {
    const comment = renderComment([], makeReport(), 123, "https://github.com/runs/123", () => new Date("2026-01-01"));
    expect(comment).toContain(ACTION_VERSION);
    expect(comment).toContain("2026-01-01");
  });

  it("renders run link", () => {
    const comment = renderComment([], makeReport(), 123, "https://github.com/runs/123", () => new Date("2026-01-01"));
    expect(comment).toContain("#123");
  });
});

describe("renderViolation", () => {
  it("renders error violation", () => {
    const v = makeViolation("TEST_RULE");
    const line = renderViolation(v);
    expect(line).toContain("TEST_RULE");
    expect(line).toContain("error");
    expect(line).toContain("test_main.py");
    expect(line).toContain("line 42");
  });

  it("renders warning violation", () => {
    const v = makeViolation("WARN_RULE", "warning");
    const line = renderViolation(v);
    expect(line).toContain("warning");
  });

  it("handles missing location", () => {
    const v = makeViolation("NO_LOC");
    v.location = undefined as any;
    const line = renderViolation(v);
    expect(line).toContain("no specific location");
  });
});
