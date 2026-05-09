import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseInvariantDeclaration,
  readSingleExpression,
} from "../src/validator/structure-invariant";

const TEST_FILE = "test.stele";

function parseInvariantNode(source: string): ListNode {
  const parsed = parseFile(source, TEST_FILE);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error("Expected a list node from CDL source.");
  }

  return node;
}

function parseListByHead(source: string, head: string): ListNode {
  const node = parseInvariantNode(source);

  for (const item of node.items) {
    if (item.kind === "list" && item.head === head) {
      return item;
    }
  }

  throw new Error(`No nested list with head "${head}" found.`);
}

describe("parseInvariantDeclaration", () => {
  it("returns a complete InvariantDeclaration for the happy path", () => {
    const node = parseInvariantNode(
      [
        "(invariant ACCT_001",
        '  (description "Balances stay non-negative.")',
        "  (severity high)",
        "  (assert (gte balance 0)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);

    expect(result.kind).toBe("invariant");
    expect(result.id).toBe("ACCT_001");
    expect(result.severity).toBe("high");
    expect(result.description).toBe("Balances stay non-negative.");
    expect(result.assertExpression).toBeDefined();
    expect(result.usesChecker).toBeUndefined();
    expect(result.usesScenario).toBeUndefined();
    expect(result.whenExpression).toBeUndefined();
    expect(result.dependsOn).toEqual([]);
    expect(result.filePath).toBe(TEST_FILE);
    expect(result.span).toBe(node.span);
    expect(result.groupId).toBeUndefined();
  });

  it("respects the groupId argument when provided", () => {
    const node = parseInvariantNode(
      [
        "(invariant ACCT_002",
        '  (description "Tagged via group.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const grouped = parseInvariantDeclaration(TEST_FILE, node, "account-rules");
    expect(grouped.groupId).toBe("account-rules");

    const ungrouped = parseInvariantDeclaration(TEST_FILE, node);
    expect(ungrouped.groupId).toBeUndefined();
  });

  it("throws E0305 when the leading identifier (id) is missing", () => {
    const node = parseInvariantNode("(invariant)");

    expect(() => parseInvariantDeclaration(TEST_FILE, node)).toThrowError(SteleError);

    try {
      parseInvariantDeclaration(TEST_FILE, node);
    } catch (err) {
      expect(err).toBeInstanceOf(SteleError);
      expect(err).toMatchObject({ code: "E0305", category: "Validation Error" });
      expect((err as SteleError).message).toContain(
        "Invariant declarations must start with an identifier",
      );
    }
  });

  it("throws E0305 when severity is missing", () => {
    const node = parseInvariantNode(
      [
        "(invariant NO_SEV",
        '  (description "missing severity")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    expect(() => parseInvariantDeclaration(TEST_FILE, node)).toThrowError(SteleError);

    try {
      parseInvariantDeclaration(TEST_FILE, node);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("missing a severity field");
    }
  });

  it("throws E0305 when description is missing", () => {
    const node = parseInvariantNode(
      [
        "(invariant NO_DESC",
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    expect(() => parseInvariantDeclaration(TEST_FILE, node)).toThrowError(SteleError);

    try {
      parseInvariantDeclaration(TEST_FILE, node);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("missing a description field");
    }
  });

  it("throws E0305 when both assert and uses-checker are missing", () => {
    const node = parseInvariantNode(
      [
        "(invariant NO_BODY",
        '  (description "no rule body")',
        "  (severity high))",
      ].join("\n"),
    );

    expect(() => parseInvariantDeclaration(TEST_FILE, node)).toThrowError(SteleError);

    try {
      parseInvariantDeclaration(TEST_FILE, node);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain(
        "must declare exactly one of assert or uses-checker",
      );
    }
  });

  it("throws E0305 when both assert and uses-checker are present", () => {
    const node = parseInvariantNode(
      [
        "(invariant BOTH_BODY",
        '  (description "two rule bodies")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (uses-checker my_checker))",
      ].join("\n"),
    );

    expect(() => parseInvariantDeclaration(TEST_FILE, node)).toThrowError(SteleError);

    try {
      parseInvariantDeclaration(TEST_FILE, node);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain(
        "must declare exactly one of assert or uses-checker",
      );
    }
  });

  it("rejects unsupported field entries (atom instead of list)", () => {
    const node = parseInvariantNode(
      [
        "(invariant BAD_ENTRY",
        "  loose-atom",
        '  (description "has an atom field")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toBeInstanceOf(SteleError);
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("unsupported field entry");
    }
  });

  it("rejects unknown field names", () => {
    const node = parseInvariantNode(
      [
        "(invariant UNKNOWN_FIELD",
        '  (description "has unknown")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (mystery foo))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain('has an unknown field "mystery"');
    }
  });

  it("rejects duplicate fields", () => {
    const node = parseInvariantNode(
      [
        "(invariant DUP_FIELD",
        '  (description "has dup severity")',
        "  (severity high)",
        "  (severity low)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("may only be declared once");
    }
  });

  it("accepts severity as an identifier", () => {
    const node = parseInvariantNode(
      [
        "(invariant SEV_ID",
        '  (description "identifier severity")',
        "  (severity critical)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.severity).toBe("critical");
  });

  it("accepts severity as a string literal", () => {
    const node = parseInvariantNode(
      [
        "(invariant SEV_STR",
        '  (description "string severity")',
        '  (severity "warning")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.severity).toBe("warning");
  });

  it("rejects severity that is neither identifier nor string", () => {
    const node = parseInvariantNode(
      [
        "(invariant SEV_NUM",
        '  (description "numeric severity")',
        "  (severity 42)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain(
        "severity must be an identifier or string literal",
      );
    }
  });

  it("rejects description that is not a string literal", () => {
    const node = parseInvariantNode(
      [
        "(invariant DESC_BAD",
        "  (description not-a-string)",
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("must be a string literal");
    }
  });

  it("captures uses-checker with id, args, and node", () => {
    const node = parseInvariantNode(
      [
        "(invariant CK_INV",
        '  (description "checker invariant")',
        "  (severity high)",
        "  (uses-checker my_checker arg1 arg2))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.usesChecker?.checkerId).toBe("my_checker");
    expect(result.usesChecker?.args).toHaveLength(2);
    expect(result.assertExpression).toBeUndefined();
  });

  it("rejects uses-checker without an identifier", () => {
    const node = parseInvariantNode(
      [
        "(invariant CK_BAD",
        '  (description "bad checker")',
        "  (severity high)",
        '  (uses-checker "not-an-id"))',
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("must reference a checker id");
    }
  });

  it("captures uses-scenario reference", () => {
    const node = parseInvariantNode(
      [
        "(invariant SC_INV",
        '  (description "scenario invariant")',
        "  (severity high)",
        "  (uses-scenario fund-flow)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.usesScenario?.scenarioId).toBe("fund-flow");
  });

  it("rejects uses-scenario without an identifier", () => {
    const node = parseInvariantNode(
      [
        "(invariant SC_BAD",
        '  (description "bad scenario")',
        "  (severity high)",
        '  (uses-scenario "not-id")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("must reference a scenario id");
    }
  });

  it("rejects uses-scenario with extra arguments", () => {
    const node = parseInvariantNode(
      [
        "(invariant SC_MULTI",
        '  (description "scenario with extras")',
        "  (severity high)",
        "  (uses-scenario one two)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("expects exactly one scenario id");
    }
  });

  it("captures whenExpression from a (when ...) field", () => {
    const node = parseInvariantNode(
      [
        "(invariant WHEN_INV",
        '  (description "scoped invariant")',
        "  (severity high)",
        "  (when (eq active true))",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.whenExpression).toBeDefined();
    expect(result.whenExpression?.kind).toBe("list");
  });

  it("captures depends-on identifiers", () => {
    const node = parseInvariantNode(
      [
        "(invariant DEP_INV",
        '  (description "has deps")',
        "  (severity high)",
        "  (depends-on FOO BAR)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.dependsOn.map((d) => d.id)).toEqual(["FOO", "BAR"]);
  });

  it("rejects depends-on entries that are not identifiers", () => {
    const node = parseInvariantNode(
      [
        "(invariant DEP_BAD",
        '  (description "bad deps")',
        "  (severity high)",
        '  (depends-on "FOO")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("invalid dependency entry");
    }
  });

  it("captures category as an InvariantSingleValueField", () => {
    const node = parseInvariantNode(
      [
        "(invariant CAT_INV",
        '  (description "with category")',
        "  (severity high)",
        "  (category business-rule)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.category?.kind).toBe("field");
    expect(result.category?.name).toBe("category");
    expect(result.category?.valueNode).toBeDefined();
  });

  it("captures tolerance as an InvariantSingleValueField", () => {
    const node = parseInvariantNode(
      [
        "(invariant TOL_INV",
        '  (description "with tolerance")',
        "  (severity high)",
        "  (tolerance (relative 0.001))",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.tolerance?.kind).toBe("field");
    expect(result.tolerance?.name).toBe("tolerance");
  });

  it("captures rationale, since, and applies-to single-value fields", () => {
    const node = parseInvariantNode(
      [
        "(invariant DOC_INV",
        '  (description "documented")',
        "  (severity high)",
        '  (rationale "for safety")',
        '  (since "2026-01-01")',
        '  (applies-to (module "ledger"))',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.rationale?.name).toBe("rationale");
    expect(result.since?.name).toBe("since");
    expect(result.appliesTo?.name).toBe("applies-to");
  });

  it("captures tags as an InvariantMultiValueField", () => {
    const node = parseInvariantNode(
      [
        "(invariant TAG_INV",
        '  (description "tagged")',
        "  (severity high)",
        "  (tags critical ledger compliance)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const result = parseInvariantDeclaration(TEST_FILE, node);
    expect(result.tags?.kind).toBe("field");
    expect(result.tags?.name).toBe("tags");
    expect(result.tags?.valueNodes).toHaveLength(3);
  });

  it("rejects tags declared with no values", () => {
    const node = parseInvariantNode(
      [
        "(invariant TAG_EMPTY",
        '  (description "no tags")',
        "  (severity high)",
        "  (tags)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain('"tags" expects at least one value');
    }
  });

  it("rejects single-value field with multiple values", () => {
    const node = parseInvariantNode(
      [
        "(invariant CAT_MULTI",
        '  (description "category with multi")',
        "  (severity high)",
        "  (category one two)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    try {
      parseInvariantDeclaration(TEST_FILE, node);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("expects exactly one value");
    }
  });
});

describe("readSingleExpression", () => {
  it("returns the single child of a list", () => {
    const list = parseListByHead(
      [
        "(invariant TARGET",
        "  (severity high)",
        '  (description "ok")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "severity",
    );

    const child = readSingleExpression(list, "test label");
    expect(child.kind).toBe("identifier");
    if (child.kind === "identifier") {
      expect(child.value).toBe("high");
    }
  });

  it("throws E0305 with the label when the list is empty", () => {
    const list = parseListByHead(
      [
        "(invariant TARGET",
        "  (severity high)",
        '  (description "ok")',
        "  (tags)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "tags",
    );

    expect(() => readSingleExpression(list, "my-label")).toThrowError(SteleError);

    try {
      readSingleExpression(list, "my-label");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305", category: "Validation Error" });
      expect((err as SteleError).message).toContain("my-label");
      expect((err as SteleError).message).toContain("expects exactly one value");
      expect((err as SteleError).detail).toContain("Found 0 value(s)");
    }
  });

  it("throws E0305 with the label when the list has multiple children", () => {
    const list = parseListByHead(
      [
        "(invariant TARGET",
        "  (severity high)",
        '  (description "ok")',
        "  (depends-on FOO BAR BAZ)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "depends-on",
    );

    expect(() => readSingleExpression(list, "another-label")).toThrowError(SteleError);

    try {
      readSingleExpression(list, "another-label");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("another-label");
      expect((err as SteleError).detail).toContain("Found 3 value(s)");
    }
  });
});
