import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-validator-types-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}

function getLoadContract(): (rootPath: string) => Promise<any> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<any>;
}

async function expectSteleError(promise: Promise<unknown>, expectation: {
  code: string;
  messageIncludes: string;
}): Promise<void> {
  await expect(promise).rejects.toThrowError(SteleError);

  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SteleError);
    expect(error).toMatchObject({ code: expectation.code });
    expect((error as SteleError).message).toContain(expectation.messageIncludes);
  }
}

// ---------------------------------------------------------------------------
// Path expression type inference
// ---------------------------------------------------------------------------
describe("path expression type inference", () => {
  it("accepts path expressions in value slots", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant PATH_IN_EQ",
        "  (severity high)",
        '  (description "Path expressions resolve to Unknown value type.")',
        "  (assert (eq (path account balance) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts nested path expressions via field operator", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant FIELD_PATH",
        "  (severity high)",
        '  (description "Field appends to existing paths.")',
        "  (assert (eq (field (path account) balance) 100)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Collection expression type inference
// ---------------------------------------------------------------------------
describe("collection expression type inference", () => {
  it("accepts collection expressions in quantifier slots", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant COLLECTION_OK",
        "  (severity high)",
        '  (description "Collection expressions are valid in quantifiers.")',
        "  (assert (forall item (collection items) (gt (path item value) 0))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts collection expressions in sum/count/avg/min/max operators", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant COLLECTION_AGG",
        "  (severity high)",
        '  (description "Collection expressions work with aggregation operators.")',
        "  (assert (gt (sum (collection amounts)) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Arithmetic expression type inference
// ---------------------------------------------------------------------------
describe("arithmetic expression type inference", () => {
  it("accepts valid arithmetic expressions", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ARITHMETIC_EXPRS",
        "  (severity high)",
        '  (description "Arithmetic operators with numbers produce numbers.")',
        "  (assert (eq (add 1 2) 3)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts variadic add/mul operators", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VARIADIC_ADD",
        "  (severity high)",
        '  (description "Variadic arithmetic accepts extra arguments.")',
        "  (assert (eq (add 1 2 3 4) 10)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects arithmetic with string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ARITH_BAD_TYPE",
        "  (severity high)",
        '  (description "Arithmetic must reject non-number arguments.")',
        '  (assert (add "x" 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });
});

// ---------------------------------------------------------------------------
// Comparison operator type checking
// ---------------------------------------------------------------------------
describe("comparison operator type checking", () => {
  it("accepts gt with valid number arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant GT_OK",
        "  (severity high)",
        '  (description "gt accepts two numbers.")',
        "  (assert (gt 10 5)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects gt with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant GT_BAD_FIRST",
        "  (severity high)",
        '  (description "gt must reject non-number first arg.")',
        '  (assert (gt "x" 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects gte with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant GTE_BAD_FIRST",
        "  (severity high)",
        '  (description "gte must reject non-number first arg.")',
        '  (assert (gte "x" 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects lt with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant LT_BAD_FIRST",
        "  (severity high)",
        '  (description "lt must reject non-number first arg.")',
        '  (assert (lt "x" 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects lte with string in second argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant LTE_BAD_SECOND",
        "  (severity high)",
        '  (description "lte must reject non-number second arg.")',
        '  (assert (lte 1 "x")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects gt with too few arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant GT_TOO_FEW",
        "  (severity high)",
        '  (description "gt must reject too few arguments.")',
        "  (assert (gt 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0309",
      messageIncludes: 'Operator "gt" expects 2 arguments',
    });
  });
});

// ---------------------------------------------------------------------------
// Type mismatches that should be rejected
// ---------------------------------------------------------------------------
describe("type mismatches that should be rejected", () => {
  it("rejects string where Predicate is expected", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STR_NOT_PRED",
        "  (severity high)",
        '  (description "Strings are not valid predicates in assert.")',
        '  (assert "this is not a predicate"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Predicate but found String",
    });
  });

  it("rejects number where Predicate is expected in when", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NUM_NOT_PRED_WHEN",
        "  (severity high)",
        '  (description "Numbers are not valid predicates in when.")',
        "  (assert (gt 1 2))",
        "  (when 42))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Predicate but found Number",
    });
  });

  it("rejects collection where Number is expected", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant COLLECTION_AS_NUMBER",
        "  (severity high)",
        '  (description "Collection expressions must not appear in number slots.")',
        "  (assert (gt (collection items) 10)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number",
    });
  });

  it("rejects path where Collection is expected", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant PATH_AS_COLLECTION",
        "  (severity high)",
        '  (description "Path expressions must not appear where collections are expected.")',
        "  (assert (count (path items))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });
});

// ---------------------------------------------------------------------------
// Quantifier type inference (where, forall, exists, none)
// ---------------------------------------------------------------------------
describe("quantifier type inference", () => {
  it("accepts where with identifier binding and collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant WHERE_OK",
        "  (severity high)",
        '  (description "where binds an identifier and filters a collection.")',
        "  (assert (gt (count (where item (collection items) (gt (path item value) 0))) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts exists with valid predicate", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant EXISTS_OK",
        "  (severity high)",
        '  (description "exists checks if any item satisfies a predicate.")',
        "  (assert (exists item (collection items) (gt (path item value) 0))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts none with valid predicate", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NONE_OK",
        "  (severity high)",
        '  (description "none checks that no items satisfy a predicate.")',
        "  (assert (none item (collection items) (lt (path item value) 0))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects quantifier when binding is not an identifier", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_BINDING",
        "  (severity high)",
        '  (description "Quantifier binding must be an identifier.")',
        "  (assert (forall 1 (collection items) (gt (path item value) 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "must bind an identifier",
    });
  });

  it("rejects quantifier when predicate is not a valid predicate type", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_QUANTIFIER_PRED",
        "  (severity high)",
        '  (description "Quantifier predicate must be a predicate.")',
        '  (assert (forall item (collection items) "not-a-pred")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Predicate",
    });
  });

  it("rejects quantifier when collection is a path expression", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant QUANTIFIER_PATH_COLL",
        "  (severity high)",
        '  (description "Quantifier collection must be a collection expression.")',
        "  (assert (forall item (path items) (gt (path item value) 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });
});

// ---------------------------------------------------------------------------
// EP04 batch 1: filter alias type inference
// ---------------------------------------------------------------------------
describe("EP04 batch 1: filter operator alias", () => {
  it("accepts filter with the same shape as where", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant FILTER_OK",
        "  (severity high)",
        '  (description "filter binds an identifier and filters a collection (alias of where).")',
        "  (assert (gt (count (filter item (collection items) (gt (path item value) 0))) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects filter when binding is not an identifier", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant FILTER_BAD_BIND",
        "  (severity high)",
        '  (description "filter binding must be an identifier.")',
        "  (assert (gt (count (filter 1 (collection items) (gt (path item value) 0))) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "must bind an identifier",
    });
  });
});

// ---------------------------------------------------------------------------
// EP04 batch 1: arity / type checks on a sample of new operators
// ---------------------------------------------------------------------------
describe("EP04 batch 1: arity and type checks on new operators", () => {
  it("rejects (length) with no arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant LENGTH_BAD_ARITY",
        "  (severity high)",
        '  (description "length expects exactly one collection.")',
        "  (assert (gt (length) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0309",
      messageIncludes: "length",
    });
  });

  it("rejects (round) with three arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROUND_BAD_ARITY",
        "  (severity high)",
        '  (description "round expects 1 or 2 args (value plus optional digits).")',
        "  (assert (gt (round 1.5 2 3) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0309",
      messageIncludes: "round",
    });
  });

  it("accepts (concat) with multiple collections", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant CONCAT_OK",
        "  (severity high)",
        '  (description "concat is variadic over Collection arguments.")',
        "  (assert (gt (length (concat (collection a) (collection b))) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts (type-of) on any value (Unknown parameter)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant TYPE_OF_OK",
        "  (severity high)",
        '  (description "type-of accepts an Unknown value.")',
        '  (assert (eq (type-of (path account balance)) "number")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Logical operator type inference (and, or, not, implies, iff)
// ---------------------------------------------------------------------------
describe("logical operator type inference", () => {
  it("accepts and with multiple predicates", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AND_MULTI",
        "  (severity high)",
        '  (description "and accepts multiple predicate arguments.")',
        "  (assert (and (gt 10 5) (lt 3 8) (eq 1 1))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts or with multiple predicates", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant OR_MULTI",
        "  (severity high)",
        '  (description "or accepts multiple predicate arguments.")',
        "  (assert (or (gt 1 100) (eq 1 1))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts not with a predicate", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NOT_OK",
        "  (severity high)",
        '  (description "not inverts a predicate.")',
        "  (assert (not (gt 1 100))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts implies with boolean arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IMPLIES_OK",
        "  (severity high)",
        '  (description "implies accepts two boolean arguments.")',
        "  (assert (implies (gt 1 0) (lt 1 100))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts iff with boolean arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IFF_OK",
        "  (severity high)",
        '  (description "iff accepts two boolean arguments.")',
        "  (assert (iff (gt 1 0) (gt 2 1))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects and with a string argument instead of predicate", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AND_BAD_ARG",
        "  (severity high)",
        '  (description "and must reject non-predicate arguments.")',
        '  (assert (and (gt 1 0) "not-pred")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Predicate but found String",
    });
  });

  it("rejects implies with non-boolean arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IMPLIES_BAD_ARG",
        "  (severity high)",
        '  (description "implies must reject non-boolean arguments.")',
        "  (assert (implies 1 (gt 1 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Boolean",
    });
  });
});

// ---------------------------------------------------------------------------
// String operator type inference (contains, matches, starts-with, ends-with)
// ---------------------------------------------------------------------------
describe("string operator type inference", () => {
  it("accepts contains with two string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant CONTAINS_OK",
        "  (severity high)",
        '  (description "contains accepts two strings.")',
        '  (assert (contains "hello world" "world")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts matches with two string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MATCHES_OK",
        "  (severity high)",
        '  (description "matches accepts string and pattern.")',
        '  (assert (matches "hello" "h.*o")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts starts-with with two string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STARTS_WITH_OK",
        "  (severity high)",
        '  (description "starts-with accepts two strings.")',
        '  (assert (starts-with "hello" "hel")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts ends-with with two string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ENDS_WITH_OK",
        "  (severity high)",
        '  (description "ends-with accepts two strings.")',
        '  (assert (ends-with "hello" "llo")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects contains with number in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant CONTAINS_BAD",
        "  (severity high)",
        '  (description "contains must reject non-string first arg.")',
        '  (assert (contains 1 "x")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected String but found Number",
    });
  });

  it("rejects matches with number in second argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MATCHES_BAD",
        "  (severity high)",
        '  (description "matches must reject non-string second arg.")',
        '  (assert (matches "pattern" 123)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected String but found Number",
    });
  });
});

// ---------------------------------------------------------------------------
// Nested expression type inference
// ---------------------------------------------------------------------------
describe("nested expression type inference", () => {
  it("accepts deeply nested logical expressions", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DEEP_NESTED",
        "  (severity high)",
        '  (description "Deeply nested expressions are type checked correctly.")',
        "  (assert (and (not (gt 1 0)) (or (lt 2 3) (implies (eq 1 1) (iff (gt 5 0) (lt 5 10)))))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts nested quantifiers with path values", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NESTED_QUANTIFIERS",
        "  (severity high)",
        '  (description "Nested quantifiers bind symbols correctly.")',
        "  (assert (forall outer (collection groups) (exists inner (collection items) (and (eq (path inner group-id) (path outer id)) (gt (path inner value) 0))))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts nested arithmetic in comparison", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NESTED_ARITH_CMP",
        "  (severity high)",
        '  (description "Nested arithmetic inside comparisons.")',
        "  (assert (gt (add (mul 2 3) (sub 10 1)) 15)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown type widening scenarios
// ---------------------------------------------------------------------------
describe("unknown type widening", () => {
  it("accepts path values in Unknown slots (widening)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(invariant UNKNOWN_WIDENING',
        '  (severity high)',
        '  (description "Path values with Unknown valueType widen to Unknown slots.")',
        '  (assert (eq (path account balance) "high")))',
      ].join("\n"),
    });

    // Path returns Path/Unknown value type, which widens to Unknown.
    // eq(unknown, unknown) is allowed because Unknown types don't
    // trigger the strict equality check.
    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts path values in eq against numbers (Unknown widening)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant PATH_EQ_NUM",
        "  (severity high)",
        '  (description "Path values widen to Unknown so eq does not reject.")',
        "  (assert (eq (path item amount) 100)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects known-literal mismatches (no widening for concrete types)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(invariant KNOWN_MISMATCH',
        '  (severity high)',
        '  (description "Two known literal types that mismatch must be rejected.")',
        '  (assert (eq 42 "hello")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: 'Operands of "eq" must have matching types',
    });
  });
});

// ---------------------------------------------------------------------------
// Type inference for if expressions
// ---------------------------------------------------------------------------
describe("if expression type inference", () => {
  it("accepts if with boolean condition and two value arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IF_OK",
        "  (severity high)",
        '  (description "if accepts boolean condition and two values.")',
        "  (assert (eq (if (gt 1 0) 10 20) 10)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects if with non-boolean condition", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IF_BAD_COND",
        "  (severity high)",
        '  (description "if must reject non-boolean condition.")',
        "  (assert (if 1 10 20)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Boolean",
    });
  });
});

// ---------------------------------------------------------------------------
// Type inference for between and approx-eq
// ---------------------------------------------------------------------------
describe("between and approx-eq type inference", () => {
  it("accepts between with three number arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BETWEEN_OK",
        "  (severity high)",
        '  (description "between checks value is within [low, high].")',
        "  (assert (between 5 1 10)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts approx-eq with three number arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant APPROX_EQ_OK",
        "  (severity high)",
        '  (description "approx-eq checks equality within tolerance.")',
        "  (assert (approx-eq 3.14 3.14159 0.01)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects between with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(invariant BETWEEN_BAD',
        '  (severity high)',
        '  (description "between must reject non-number arguments.")',
        '  (assert (between "x" 1 10)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects approx-eq with string in second argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(invariant APPROX_EQ_BAD',
        '  (severity high)',
        '  (description "approx-eq must reject non-number arguments.")',
        '  (assert (approx-eq 3.14 "hello" 0.01)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects between with wrong arity (too few args)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BETWEEN_TOO_FEW",
        "  (severity high)",
        '  (description "between needs 3 arguments.")',
        "  (assert (between 5 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0309",
      messageIncludes: 'Operator "between" expects 3 arguments',
    });
  });
});
