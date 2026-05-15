import { describe, expect, it } from "vitest";
import { parseFile } from "../src/parser/parser.js";
import type { InvariantDeclaration, ListNode } from "../src/index.js";
import { parseInvariantDeclaration } from "../src/validator/structure-invariant.js";
import { buildInvariantTrace, formatExplainTrace, invariantExplanation } from "../src/evaluator/explain.js";

const TEST_FILE = "test.stele";

function parseInvariantNode(source: string): ListNode {
  const parsed = parseFile(source, TEST_FILE);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error("Expected a list node from CDL source.");
  }

  return node;
}

function parseInvariant(source: string): InvariantDeclaration {
  const node = parseInvariantNode(source);
  return parseInvariantDeclaration(TEST_FILE, node);
}

describe("buildInvariantTrace", () => {
  it("builds a root trace with invariant id and null evaluation state", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test invariant.\")\n  (assert (eq 1 1)))",
    );

    const trace = buildInvariantTrace(invariant, null);

    expect(trace.expression).toBe("(invariant INV_001)");
    expect(trace.evaluated).toBeNull();
    expect(trace.explanation).toBeUndefined();
    expect(trace.children).toBeDefined();
    expect(trace.children!.length).toBe(1); // assert expression
  });

  it("includes explain text in root trace", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain \"Why this rule exists.\")\n  (assert (eq 1 1)))",
    );

    const trace = buildInvariantTrace(invariant, null);

    expect(trace.explanation).toBe("Why this rule exists.");
  });

  it("builds assert expression as child trace", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    );

    const trace = buildInvariantTrace(invariant, null);

    expect(trace.children).toBeDefined();
    expect(trace.children![0].expression).toContain("eq");
    expect(trace.children![0].evaluated).toBeNull();
  });

  it("handles invariant with when expression", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1))\n  (when (eq 2 2)))",
    );

    const trace = buildInvariantTrace(invariant, null);

    expect(trace.children).toBeDefined();
    expect(trace.children!.length).toBe(2); // assert + when
  });

  it("builds trace with evaluated state from backend", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    );

    const trace = buildInvariantTrace(invariant, false);

    expect(trace.evaluated).toBe(false);
  });

  it("has no children for uses-checker invariants", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (uses-checker checker_001))",
    );

    const trace = buildInvariantTrace(invariant, null);

    // uses-checker invariants have no assertExpression, so children is undefined
    expect(trace.children).toBeUndefined();
  });
});

describe("formatExplainTrace", () => {
  it("formats root trace with expression and status", () => {
    const trace = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    ), null);

    const lines = formatExplainTrace(trace);

    expect(lines[0]).toContain("INV_001");
    expect(lines[0]).toContain("?");
  });

  it("formats evaluated traces with true/false status", () => {
    const passed = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    ), true);

    const failed = buildInvariantTrace(parseInvariant(
      "(invariant INV_002\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    ), false);

    expect(formatExplainTrace(passed)[0]).toContain("true");
    expect(formatExplainTrace(failed)[0]).toContain("false");
  });

  it("includes explanation as why line", () => {
    const trace = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain \"This is the reason.\")\n  (assert (eq 1 1)))",
    ), null);

    const lines = formatExplainTrace(trace);

    const whyLine = lines.find((l) => l.includes("why:"));
    expect(whyLine).toBeDefined();
    expect(whyLine).toContain("This is the reason.");
  });

  it("formats nested children with indentation", () => {
    const trace = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 2)))",
    ), null);

    const lines = formatExplainTrace(trace);

    // Root at depth 0, children at depth 1
    expect(lines[0]).not.toMatch(/^\s/);
    if (lines.length > 1) {
      expect(lines[1]).toMatch(/^\s/);
    }
  });

  it("formats trace with failure detail", () => {
    const trace = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    ), null);

    trace.failureDetail = "expected 1 but got 2";

    const lines = formatExplainTrace(trace);

    const detailLine = lines.find((l) => l.includes("detail:"));
    expect(detailLine).toBeDefined();
    expect(detailLine).toContain("expected 1 but got 2");
  });

  it("uses ASCII dash separator not em-dash", () => {
    const trace = buildInvariantTrace(parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    ), null);

    const lines = formatExplainTrace(trace);

    // Verify ASCII dash is used (not U+2014 em-dash)
    for (const line of lines) {
      expect(line).not.toContain("—");
    }
  });
});

describe("invariantExplanation", () => {
  it("returns explanation string from explain field", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain \"Explanation text.\")\n  (assert (eq 1 1)))",
    );

    expect(invariantExplanation(invariant)).toBe("Explanation text.");
  });

  it("returns undefined when no explain field", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))",
    );

    expect(invariantExplanation(invariant)).toBeUndefined();
  });

  it("returns explanation for identifier explain value", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain short_form)\n  (assert (eq 1 1)))",
    );

    expect(invariantExplanation(invariant)).toBe("short_form");
  });
});

describe("explain field parsing", () => {
  it("parses explain field in invariant declaration", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain \"Why this matters.\")\n  (assert (eq 1 1)))",
    );

    expect(invariant.explain).toBeDefined();
    expect(invariant.explain?.name).toBe("explain");
    expect(invariant.explain?.valueNode.kind).toBe("string");
  });

  it("accepts identifier as explain value", () => {
    const invariant = parseInvariant(
      "(invariant INV_001\n  (severity high)\n  (description \"Test.\")\n  (explain quick_note)\n  (assert (eq 1 1)))",
    );

    expect(invariant.explain?.valueNode.kind).toBe("identifier");
  });
});
