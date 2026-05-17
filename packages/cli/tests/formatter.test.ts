import { describe, expect, it } from "vitest";
import { formatCheckReport, FORMATTERS, SUPPORTED_FORMATS } from "../src/report/formatter.js";
import type { ViolationReport, Violation, ViolationSeverity } from "@stele/core";

describe("formatCheckReport", () => {
  function makeReport(severity: ViolationSeverity = "error"): ViolationReport {
    const violation: Violation = {
      rule_id: "TEST_RULE",
      severity,
      cause: { summary: "Test violation", kind: "check", detail: "Test detail" },
      source: { kind: "check", source: "tests/contract/test_main.py" },
      location: { path: "tests/contract/test_main.py", line: 1, column: 1 },
      fingerprint: "abc123",
      rule_kind: "invariant",
      scope_paths: [],
      status: "active",
      fix: { summary: "Fix it" },
    };
    return {
      schema_version: "1",
      tool: "stele",
      command: "check",
      ok: false,
      violations: [violation],
      summary: {
        violation_count: 1,
      },
    };
  }

  it("formats with human format", () => {
    const report = makeReport();
    const output = formatCheckReport(report, "human");
    expect(output).toContain("TEST_RULE");
  });

  it("formats with json format", () => {
    const report = makeReport();
    const output = formatCheckReport(report, "json");
    const parsed = JSON.parse(output);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0].rule_id).toBe("TEST_RULE");
  });

  it("formats with sarif format", () => {
    const report = makeReport();
    const output = formatCheckReport(report, "sarif");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs[0].tool.driver.name).toBe("stele");
  });

  it("rejects unknown format", () => {
    const report = makeReport();
    expect(() => formatCheckReport(report, "unknown")).toThrow("Unknown format");
  });

  it("SUPPORTED_FORMATS lists available formats", () => {
    expect(SUPPORTED_FORMATS).toContain("human");
    expect(SUPPORTED_FORMATS).toContain("json");
    expect(SUPPORTED_FORMATS).toContain("sarif");
  });

  it("FORMATTERS has expected formatters", () => {
    expect(Object.keys(FORMATTERS)).toEqual(["human", "json", "sarif"]);
  });

  it("human format is readable", () => {
    const report = makeReport("warning");
    const output = formatCheckReport(report, "human");
    expect(output).toContain("TEST_RULE");
    expect(output).toContain("warning");
  });

  it("sarif format includes version", () => {
    const report = makeReport();
    const output = formatCheckReport(report, "sarif");
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].tool.driver.version).toBeTruthy();
  });
});
