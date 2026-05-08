import { describe, expect, it } from "vitest";
import {
  createViolation,
  createViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
} from "../src/index";

function makeViolation(violationInput: any) {
  const violation = createViolation(violationInput);
  const report = createViolationReport({
    tool: "stele",
    command: "check",
    ok: false,
    summary: { violation_count: 1 },
    violations: [violation],
  });
  return { violation, report };
}

function makeBaseViolation(): any {
  return {
    rule_id: "stele.check.rule_id",
    rule_kind: "invariant",
    severity: "error" as const,
    source: { tool: "stele", command: "check", kind: "invariant" },
    scope_paths: ["src/main.stele"],
  };
}

// ---------------------------------------------------------------------------
// formatViolationReportHuman
// ---------------------------------------------------------------------------
describe("formatViolationReportHuman", () => {
  describe("with empty report", () => {
    it("returns OK message for ok reports", () => {
      const report = createViolationReport({
        tool: "stele",
        command: "check",
        ok: true,
        summary: {
          violation_count: 0,
          message: "All checks passed.",
        },
        violations: [],
      });

      const output = formatViolationReportHuman(report);
      expect(output).toBe("All checks passed.\n");
    });

    it("returns default OK message when summary message is undefined", () => {
      const report = createViolationReport({
        tool: "stele",
        command: "check",
        ok: true,
        summary: { violation_count: 0 },
        violations: [],
      });

      const output = formatViolationReportHuman(report);
      expect(output).toBe("OK\n");
    });
  });

  describe("with only suppressed violations", () => {
    it("outputs suppression summary when no active violations exist", () => {
      const suppressed = createViolation({
        rule_id: "stele.check.suppressed",
        rule_kind: "invariant",
        severity: "warning",
        source: { tool: "stele", command: "check", kind: "invariant" },
        location: { path: "old/file.stele" },
        cause: { summary: "Previously seen violation." },
        scope_paths: ["old/file.stele"],
        status: "suppressed",
        suppressed_by: "baseline",
      });
      const report = createViolationReport({
        tool: "stele",
        command: "check",
        ok: false,
        summary: {
          violation_count: 1,
          suppressed_violation_count: 1,
        },
        violations: [suppressed],
      });

      const output = formatViolationReportHuman(report);
      expect(output).not.toContain("stele.check.suppressed");
      expect(output).toContain("1 baseline violation suppressed.");
    });

    it("pluralizes suppression count correctly", () => {
      const suppressed = [
        createViolation({
          rule_id: "stele.check.suppressed1",
          rule_kind: "invariant",
          severity: "warning",
          source: { tool: "stele", command: "check", kind: "invariant" },
          location: { path: "old/file1.stele" },
          cause: { summary: "Previously seen violation 1." },
          scope_paths: ["old/file1.stele"],
          status: "suppressed",
          suppressed_by: "baseline",
        }),
        createViolation({
          rule_id: "stele.check.suppressed2",
          rule_kind: "invariant",
          severity: "info",
          source: { tool: "stele", command: "check", kind: "invariant" },
          location: { path: "old/file2.stele" },
          cause: { summary: "Previously seen violation 2." },
          scope_paths: ["old/file2.stele"],
          status: "suppressed",
          suppressed_by: "baseline",
        }),
      ];

      const report = createViolationReport({
        tool: "stele",
        command: "check",
        ok: false,
        summary: {
          violation_count: 2,
          suppressed_violation_count: 2,
        },
        violations: suppressed,
      });

      const output = formatViolationReportHuman(report);
      expect(output).toContain("2 baseline violations suppressed.");
    });
  });

  describe("with active violations", () => {
    it("includes severity, rule_id, source, location, summary, and fingerprint", () => {
      const { report } = makeViolation({
        ...makeBaseViolation(),
        location: { path: "src/main.stele", line: 10, column: 5 },
        cause: {
          summary: "Violation summary.",
          detail: "Additional detail.",
        },
      });

      const output = formatViolationReportHuman(report);

      expect(output).toContain("[error] stele.check.rule_id");
      expect(output).toContain("source: invariant/check");
      expect(output).toContain("location: src/main.stele:10:5");
      expect(output).toContain("summary: Violation summary.");
      expect(output).toContain("detail: Additional detail.");
      expect(output).toMatch(/fingerprint: [a-f0-9]{12}/);
    });

    it("includes fix summary and command when present", () => {
      const { report } = makeViolation({
        ...makeBaseViolation(),
        location: { path: "src/main.stele", line: 1, column: 1 },
        cause: { summary: "Needs fixing." },
        fix: { summary: "Run the fix.", command: "stele fix" },
      });
      const output = formatViolationReportHuman(report);

      expect(output).toContain("fix: Run the fix.");
      expect(output).toContain("command: stele fix");
    });

    it("includes cause detail fields", () => {
      const { report } = makeViolation({
        ...makeBaseViolation(),
        location: { path: "src/main.stele", line: 1, column: 1 },
        cause: {
          summary: "Multiple issues.",
          missing: ["a.py", "b.py"],
          changed: ["c.py"],
          extra: ["d.py"],
          new_files: ["e.py"],
          expected_hash: "abc123",
          actual_hash: "def456",
        },
      });
      const output = formatViolationReportHuman(report);

      expect(output).toContain("missing: a.py, b.py");
      expect(output).toContain("changed: c.py");
      expect(output).toContain("extra: d.py");
      expect(output).toContain("new_files: e.py");
      expect(output).toContain("expected_hash: abc123");
      expect(output).toContain("actual_hash: def456");
    });

    it("handles cause with no optional fields", () => {
      const { report } = makeViolation({
        ...makeBaseViolation(),
        location: { path: "src/main.stele", line: 1, column: 1 },
        cause: { summary: "Simple cause." },
      });
      const output = formatViolationReportHuman(report);

      expect(output).toContain("summary: Simple cause.");
      expect(output).not.toContain("detail:");
      expect(output).not.toContain("missing:");
      expect(output).not.toContain("changed:");
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple location types
// ---------------------------------------------------------------------------
describe("formatViolationReportHuman location types", () => {
  it("renders path location with line and column", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "src/lib/model.stele", line: 42, column: 8 },
      cause: { summary: "Check." },
      scope_paths: ["src/lib/model.stele"],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: src/lib/model.stele:42:8");
  });

  it("renders path location with line only (no column)", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "src/model.stele", line: 7 },
      cause: { summary: "Check." },
      scope_paths: ["src/model.stele"],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: src/model.stele:7");
  });

  it("renders path location with no line or column", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "src/model.stele" },
      cause: { summary: "Check." },
      scope_paths: ["src/model.stele"],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: src/model.stele");
  });

  it("renders manifest_path location", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { manifest_path: "contract/.manifest.json", line: 1, column: 1 },
      cause: { summary: "Check." },
      scope_paths: ["contract/.manifest.json"],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: contract/.manifest.json:1:1");
  });

  it("renders generated_dir location", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { generated_dir: "tests/contract", line: 5 },
      cause: { summary: "Check." },
      scope_paths: ["tests/contract"],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: tests/contract:5");
  });

  it("renders location with only line (no path key)", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { line: 99, column: 10 },
      cause: { summary: "Check." },
      scope_paths: [],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: <unknown>:99:10");
  });

  it("renders location with no fields at all", () => {
    const { report } = makeViolation({
      rule_id: "stele.check.rule_id",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: {},
      cause: { summary: "Check." },
      scope_paths: [],
    });
    const output = formatViolationReportHuman(report);
    expect(output).toContain("location: <unknown>");
  });
});

// ---------------------------------------------------------------------------
// formatViolationReportJson
// ---------------------------------------------------------------------------
describe("formatViolationReportJson", () => {
  it("produces valid JSON with schema_version and all fields", () => {
    const { report } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele", line: 10, column: 5 },
      cause: {
        summary: "Full cause.",
        missing: ["a.py"],
        expected_hash: "aaa",
        actual_hash: "bbb",
      },
      fix: { summary: "Apply fix.", command: "stele apply" },
    });

    const jsonStr = formatViolationReportJson(report);
    const parsed = JSON.parse(jsonStr);

    expect(jsonStr.endsWith("\n")).toBe(true);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.tool).toBe("stele");
    expect(parsed.command).toBe("check");
    expect(parsed.ok).toBe(false);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0].rule_id).toBe("stele.check.rule_id");
    expect(parsed.violations[0].fix).toEqual({ summary: "Apply fix.", command: "stele apply" });
    expect(parsed.violations[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes fingerprint in JSON output", () => {
    const { report, violation } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
    });
    const jsonStr = formatViolationReportJson(report);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.violations[0].fingerprint).toBe(violation.fingerprint);
  });

  it("preserves violation status fields in JSON", () => {
    const { report } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
      status: "suppressed",
      suppressed_by: "baseline",
    });
    const jsonStr = formatViolationReportJson(report);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.violations[0].status).toBe("suppressed");
    expect(parsed.violations[0].suppressed_by).toBe("baseline");
  });

  it("formats JSON with 2-space indentation", () => {
    const { report } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
    });
    const jsonStr = formatViolationReportJson(report);

    // Check that the second line has 2-space indentation
    const lines = jsonStr.split("\n");
    expect(lines[1]).toMatch(/^  "/);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint formatting
// ---------------------------------------------------------------------------
describe("fingerprint formatting", () => {
  it("includes fingerprint prefix in human output", () => {
    const { report, violation } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
    });
    const output = formatViolationReportHuman(report);

    expect(output).toContain(`fingerprint: ${violation.fingerprint.slice(0, 12)}`);
  });

  it("includes full fingerprint in JSON output", () => {
    const { report, violation } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
    });
    const jsonStr = formatViolationReportJson(report);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.violations[0].fingerprint).toBe(violation.fingerprint);
    expect(violation.fingerprint.length).toBe(64);
  });

  it("includes fingerprint even when fix.command is absent", () => {
    const { report } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
      fix: { summary: "Just a summary." },
    });
    const output = formatViolationReportHuman(report);

    expect(output).toMatch(/fingerprint: [a-f0-9]{12}/);
    expect(output).toContain("fix: Just a summary.");
    expect(output).not.toContain("command:");
  });
});

// ---------------------------------------------------------------------------
// Combined suppression summary
// ---------------------------------------------------------------------------
describe("combined suppression summary", () => {
  it("includes both suppressed and out-of-scope counts", () => {
    const active = createViolation({
      rule_id: "stele.check.active",
      rule_kind: "invariant",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "active.stele" },
      cause: { summary: "Active violation." },
      scope_paths: ["active.stele"],
    });
    const suppressed = createViolation({
      rule_id: "stele.check.suppressed",
      rule_kind: "invariant",
      severity: "warning",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "old/file.stele" },
      cause: { summary: "Previously seen violation." },
      scope_paths: ["old/file.stele"],
      status: "suppressed",
      suppressed_by: "baseline",
    });
    const outOfScope = createViolation({
      rule_id: "stele.check.oos",
      rule_kind: "invariant",
      severity: "info",
      source: { tool: "stele", command: "check", kind: "invariant" },
      location: { path: "ignored.stele" },
      cause: { summary: "Out of scope." },
      scope_paths: ["ignored.stele"],
      status: "out_of_scope",
    });

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
      violations: [active, suppressed, outOfScope],
    });

    const output = formatViolationReportHuman(report);
    expect(output).toContain("1 baseline violation suppressed.");
    expect(output).toContain("1 out-of-scope violation ignored.");
  });

  it("omits suppression summary when counts are zero", () => {
    const { report } = makeViolation({
      ...makeBaseViolation(),
      location: { path: "src/main.stele" },
      cause: { summary: "Check." },
    });
    const output = formatViolationReportHuman(report);

    expect(output).not.toContain("baseline violation");
    expect(output).not.toContain("out-of-scope");
  });
});
