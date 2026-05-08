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
  const directory = await mkdtemp(join(tmpdir(), "stele-core-validator-types-missing-"));
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
// neq type checking
// ---------------------------------------------------------------------------
describe("neq type checking", () => {
  it("rejects neq with mismatched string and number types", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NEQ_TYPE_MISMATCH",
        "  (severity high)",
        '  (description "neq must reject mismatched operand types like eq does.")',
        '  (assert (neq 42 "hello")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: 'Operands of "neq" must have matching types',
    });
  });

  it("accepts neq with matching string types", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NEQ_STR_OK",
        "  (severity high)",
        '  (description "neq accepts two matching string literals.")',
        '  (assert (neq "a" "b")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts neq with matching number types", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NEQ_NUM_OK",
        "  (severity high)",
        '  (description "neq accepts two matching number literals.")',
        "  (assert (neq 1 2)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sub type checking
// ---------------------------------------------------------------------------
describe("sub type checking", () => {
  it("rejects sub with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant SUB_BAD_FIRST",
        "  (severity high)",
        '  (description "sub must reject non-number first arg.")',
        '  (assert (eq (sub "x" 1) 0)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects sub with string in second argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant SUB_BAD_SECOND",
        "  (severity high)",
        '  (description "sub must reject non-number second arg.")',
        '  (assert (eq (sub 1 "x") 0)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("accepts sub with valid number arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant SUB_OK",
        "  (severity high)",
        '  (description "sub accepts two numbers.")',
        "  (assert (eq (sub 10 3) 7)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// div type checking
// ---------------------------------------------------------------------------
describe("div type checking", () => {
  it("rejects div with string in first argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DIV_BAD_FIRST",
        "  (severity high)",
        '  (description "div must reject non-number first arg.")',
        '  (assert (eq (div "x" 2) 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("rejects div with string in second argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DIV_BAD_SECOND",
        "  (severity high)",
        '  (description "div must reject non-number second arg.")',
        '  (assert (eq (div 10 "x") 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("accepts div with valid number arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DIV_OK",
        "  (severity high)",
        '  (description "div accepts two numbers.")',
        "  (assert (eq (div 10 2) 5)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// neg type checking
// ---------------------------------------------------------------------------
describe("neg type checking", () => {
  it("rejects neg with string argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NEG_BAD_TYPE",
        "  (severity high)",
        '  (description "neg must reject non-number arguments.")',
        '  (assert (eq (neg "x") 0)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("accepts neg with valid number argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NEG_OK",
        "  (severity high)",
        '  (description "neg accepts a number.")',
        "  (assert (eq (neg 5) -5)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// abs type checking
// ---------------------------------------------------------------------------
describe("abs type checking", () => {
  it("rejects abs with string argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ABS_BAD_TYPE",
        "  (severity high)",
        '  (description "abs must reject non-number arguments.")',
        '  (assert (eq (abs "x") 0)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("accepts abs with valid number argument", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ABS_OK",
        "  (severity high)",
        '  (description "abs accepts a number.")',
        "  (assert (eq (abs -5) 5)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// avg type checking
// ---------------------------------------------------------------------------
describe("avg type checking", () => {
  it("rejects avg with non-collection first arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AVG_BAD_FIRST",
        "  (severity high)",
        '  (description "avg must reject non-collection first arg.")',
        "  (assert (gt (avg (path items)) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("rejects avg with number as first arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AVG_NUM_FIRST",
        "  (severity high)",
        '  (description "avg must reject a number as its first arg.")',
        "  (assert (gt (avg 42) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts avg with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AVG_OK",
        "  (severity high)",
        '  (description "avg accepts a collection and optional path.")',
        "  (assert (gt (avg (collection items)) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// min type checking
// ---------------------------------------------------------------------------
describe("min type checking", () => {
  it("rejects min with non-collection arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MIN_BAD_TYPE",
        "  (severity high)",
        '  (description "min must reject non-collection arguments.")',
        "  (assert (gt (min (path items)) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts min with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MIN_OK",
        "  (severity high)",
        '  (description "min accepts a collection.")',
        "  (assert (gt (min (collection items)) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// max type checking
// ---------------------------------------------------------------------------
describe("max type checking", () => {
  it("rejects max with non-collection arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MAX_BAD_TYPE",
        "  (severity high)",
        '  (description "max must reject non-collection arguments.")',
        "  (assert (gt (max (path items)) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts max with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MAX_OK",
        "  (severity high)",
        '  (description "max accepts a collection.")',
        "  (assert (gt (max (collection items)) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// distinct type checking
// ---------------------------------------------------------------------------
describe("distinct type checking", () => {
  it("rejects distinct with non-collection arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DISTINCT_BAD_TYPE",
        "  (severity high)",
        '  (description "distinct must reject non-collection arguments.")',
        "  (assert (gt (count (distinct (path items))) 0)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts distinct with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DISTINCT_OK",
        "  (severity high)",
        '  (description "distinct accepts a collection.")',
        "  (assert (gt (count (distinct (collection items))) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// in type checking
// ---------------------------------------------------------------------------
describe("in type checking", () => {
  it("rejects in with non-collection second arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IN_BAD_SECOND",
        "  (severity high)",
        '  (description "in must reject non-collection second arg.")',
        "  (assert (in 1 (path items))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("rejects in with number as second arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IN_NUM_SECOND",
        "  (severity high)",
        '  (description "in must reject a number as its second arg.")',
        "  (assert (in 1 42)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts in with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IN_OK",
        "  (severity high)",
        '  (description "in accepts a value and a collection.")',
        "  (assert (in 1 (collection items))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// exists-in type checking
// ---------------------------------------------------------------------------
describe("exists-in type checking", () => {
  it("rejects exists-in with non-collection second arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant EXISTS_IN_BAD_SECOND",
        "  (severity high)",
        '  (description "exists-in must reject non-collection second arg.")',
        "  (assert (exists-in 1 (path items))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts exists-in with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant EXISTS_IN_OK",
        "  (severity high)",
        '  (description "exists-in accepts a value and a collection.")',
        "  (assert (exists-in 1 (collection items))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// unique type checking
// ---------------------------------------------------------------------------
describe("unique type checking", () => {
  it("rejects unique with non-collection arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant UNIQUE_BAD_TYPE",
        "  (severity high)",
        '  (description "unique must reject non-collection arguments.")',
        "  (assert (unique (path items))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts unique with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant UNIQUE_OK",
        "  (severity high)",
        '  (description "unique accepts a collection.")',
        "  (assert (unique (collection items))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// within type checking
// ---------------------------------------------------------------------------
describe("within type checking", () => {
  it("rejects within with wrong arg types", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant WITHIN_BAD_TYPE",
        "  (severity high)",
        '  (description "within must reject wrong argument types.")',
        "  (assert (within 1 2)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected TimeRange",
    });
  });
});

// ---------------------------------------------------------------------------
// after type checking
// ---------------------------------------------------------------------------
describe("after type checking", () => {
  it("accepts after with valid arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant AFTER_OK",
        "  (severity high)",
        '  (description "after accepts two arguments.")',
        "  (assert (after (path event-a) (path event-b))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// before type checking
// ---------------------------------------------------------------------------
describe("before type checking", () => {
  it("accepts before with valid arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BEFORE_OK",
        "  (severity high)",
        '  (description "before accepts two arguments.")',
        "  (assert (before (path event-a) (path event-b))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// modified type checking
// ---------------------------------------------------------------------------
describe("modified type checking", () => {
  it("rejects modified with non-path arg (number)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MODIFIED_BAD_TYPE",
        "  (severity high)",
        '  (description "modified must reject non-path arguments.")',
        "  (assert (modified 42)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Path",
    });
  });

  it("rejects modified with string arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MODIFIED_BAD_STR",
        "  (severity high)",
        '  (description "modified must reject string arguments.")',
        '  (assert (modified "x")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Path",
    });
  });

  it("accepts modified with valid path", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MODIFIED_OK",
        "  (severity high)",
        '  (description "modified accepts a path.")',
        "  (assert (modified (path account balance))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// state-before usage context validation
// ---------------------------------------------------------------------------
describe("state-before usage context", () => {
  it("accepts state-before in an assertion context", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STATE_BEFORE_OK",
        "  (severity high)",
        '  (description "state-before is a zero-arg operator returning Unknown.")',
        "  (assert (eq (state-before) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// state-after usage context validation
// ---------------------------------------------------------------------------
describe("state-after usage context", () => {
  it("accepts state-after in an assertion context", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STATE_AFTER_OK",
        "  (severity high)",
        '  (description "state-after is a zero-arg operator returning Unknown.")',
        "  (assert (eq (state-after) 100)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// is-empty type checking
// ---------------------------------------------------------------------------
describe("is-empty type checking", () => {
  it("rejects is-empty with non-collection arg (path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IS_EMPTY_BAD_TYPE",
        "  (severity high)",
        '  (description "is-empty must reject non-collection arguments.")',
        "  (assert (is-empty (path items))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("rejects is-empty with number arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IS_EMPTY_NUM",
        "  (severity high)",
        '  (description "is-empty must reject a number as its arg.")',
        "  (assert (is-empty 42)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("accepts is-empty with valid collection", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant IS_EMPTY_OK",
        "  (severity high)",
        '  (description "is-empty accepts a collection.")',
        "  (assert (is-empty (collection items))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// has-length type checking
// ---------------------------------------------------------------------------
describe("has-length type checking", () => {
  it("rejects has-length with non-collection first arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant HAS_LENGTH_BAD_FIRST",
        "  (severity high)",
        '  (description "has-length must reject non-collection first arg.")',
        "  (assert (has-length (path items) 5)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Collection",
    });
  });

  it("rejects has-length with non-number second arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant HAS_LENGTH_BAD_SECOND",
        "  (severity high)",
        '  (description "has-length must reject non-number second arg.")',
        '  (assert (has-length (collection items) "five")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Number but found String",
    });
  });

  it("accepts has-length with valid arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant HAS_LENGTH_OK",
        "  (severity high)",
        '  (description "has-length accepts a collection and a number.")',
        "  (assert (has-length (collection items) 5)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// when type checking
// ---------------------------------------------------------------------------
describe("when type checking", () => {
  it("rejects when with non-boolean condition", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant WHEN_BAD_COND",
        "  (severity high)",
        '  (description "when must reject non-boolean condition.")',
        "  (assert (when 42 (gt 1 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Boolean",
    });
  });

  it("accepts when with valid boolean condition and predicate", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant WHEN_OK",
        "  (severity high)",
        '  (description "when accepts a boolean condition and a predicate.")',
        "  (assert (when (gt 1 0) (lt 2 3))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// not-null type checking
// ---------------------------------------------------------------------------
describe("not-null type checking", () => {
  it("rejects not-null with non-path arg (number)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NOT_NULL_BAD_TYPE",
        "  (severity high)",
        '  (description "not-null must reject non-path arguments.")',
        "  (assert (not-null 42)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Path",
    });
  });

  it("rejects not-null with string arg", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NOT_NULL_BAD_STR",
        "  (severity high)",
        '  (description "not-null must reject string arguments.")',
        '  (assert (not-null "x")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      messageIncludes: "Expected Path",
    });
  });

  it("accepts not-null with valid path", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NOT_NULL_OK",
        "  (severity high)",
        '  (description "not-null accepts a path.")',
        "  (assert (not-null (path account id))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// value operator type checking
// ---------------------------------------------------------------------------
describe("value operator type checking", () => {
  it("accepts value wrapping a number", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VALUE_NUM",
        "  (severity high)",
        '  (description "value wraps literal values.")',
        "  (assert (eq (value 42) 42)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts value wrapping a string", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VALUE_STR",
        "  (severity high)",
        '  (description "value wraps string literals.")',
        '  (assert (eq (value "hello") "hello")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts value wrapping a boolean", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VALUE_BOOL",
        "  (severity high)",
        '  (description "value wraps boolean literals.")',
        "  (assert (eq (value true) true)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("contains edge cases", () => {
  it("accepts contains with empty string arguments", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant CONTAINS_EMPTY_BOTH",
        "  (severity high)",
        '  (description "contains accepts empty string arguments.")',
        '  (assert (contains "" "")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });

  it("accepts contains with empty first string and non-empty second", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant CONTAINS_EMPTY_FIRST",
        "  (severity high)",
        '  (description "contains accepts empty string as first arg -- empty string is still a string.")',
        '  (assert (contains "" "hello")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
  });
});
