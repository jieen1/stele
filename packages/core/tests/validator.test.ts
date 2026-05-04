import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("loadContract validation", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects unknown top-level declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(metadata",
        '  (stele-version "0.1")',
        '  (project "ledger")',
        "  (target-language python))",
        "(rule active)",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0301",
      file: project.rootPath,
      line: 5,
      column: 1,
      messageIncludes: "Unknown top-level declaration",
    });
  });

  it("rejects duplicate metadata blocks in a single file", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(metadata (stele-version "0.1") (project "ledger") (target-language python))',
        '(metadata (stele-version "0.1") (project "ledger-duplicate") (target-language python))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0302",
      file: project.rootPath,
      line: 2,
      column: 1,
      messageIncludes: 'metadata may appear at most once',
    });
  });

  it("rejects duplicate invariant ids across imported files and groups", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "modules/account.stele")',
        "(invariant DUP_001",
        "  (severity high)",
        '  (description "Top-level duplicate invariant id.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "modules/account.stele": [
        "(group account-group",
        "  (invariant DUP_001",
        "    (severity critical)",
        '    (description "Imported duplicate invariant id.")',
        "    (assert (eq 1 1))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0306",
      file: join(project.directory, "modules", "account.stele"),
      line: 2,
      column: 3,
      messageIncludes: 'Invariant id "DUP_001" is already defined',
    });
  });

  it("preserves accepted optional invariant fields in the contract model", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant OPTIONAL_FIELDS",
        "  (severity high)",
        '  (description "Preserve optional fields for later pipeline stages.")',
        "  (assert (eq 1 1))",
        "  (category business-rule)",
        "  (tags critical-path ledger)",
        "  (tolerance (relative 0.001))",
        '  (rationale "Protects downstream generators from data loss.")',
        '  (since "2026-05-04")',
        '  (applies-to (module "ledger-service")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const invariant = contract.invariants[0];

    expect(invariant).toMatchObject({
      id: "OPTIONAL_FIELDS",
      category: {
        valueNode: { kind: "identifier", value: "business-rule" },
      },
      tags: {
        valueNodes: [
          { kind: "identifier", value: "critical-path" },
          { kind: "identifier", value: "ledger" },
        ],
      },
      tolerance: {
        valueNode: { kind: "list", head: "relative" },
      },
      rationale: {
        valueNode: { kind: "string", value: "Protects downstream generators from data loss." },
      },
      since: {
        valueNode: { kind: "string", value: "2026-05-04" },
      },
      appliesTo: {
        valueNode: { kind: "list", head: "module" },
      },
    });
    expect(invariant.category?.span).toEqual({ file: project.rootPath, line: 5, column: 3 });
    expect(invariant.tags?.span).toEqual({ file: project.rootPath, line: 6, column: 3 });
    expect(invariant.tolerance?.valueNode.span).toEqual({ file: project.rootPath, line: 7, column: 14 });
    expect(invariant.appliesTo?.valueNode.span).toEqual({ file: project.rootPath, line: 10, column: 15 });
  });

  it("rejects duplicate checker ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(checker shared_checker",
        '  (description "First checker declaration."))',
        "(checker shared_checker",
        '  (description "Second checker declaration."))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0312",
      file: project.rootPath,
      line: 3,
      column: 1,
      messageIncludes: 'Checker id "shared_checker" is already defined',
    });
  });

  it("rejects duplicate group ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group shared_group",
        "  (invariant FIRST_GROUP_RULE",
        "    (severity high)",
        '    (description "First group declaration.")',
        "    (assert (eq 1 1))))",
        "(group shared_group",
        "  (invariant SECOND_GROUP_RULE",
        "    (severity high)",
        '    (description "Second group declaration.")',
        "    (assert (eq 1 1))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0313",
      file: project.rootPath,
      line: 6,
      column: 1,
      messageIncludes: 'Group id "shared_group" is already defined',
    });
  });

  it("rejects duplicate operator ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(operator project_op",
        '  (description "First operator declaration."))',
        "(operator project_op",
        '  (description "Second operator declaration."))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0314",
      file: project.rootPath,
      line: 3,
      column: 1,
      messageIncludes: 'Operator id "project_op" is already defined',
    });
  });

  it("rejects uses-checker references that do not resolve to a known checker", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BROKEN_CHECKER",
        "  (severity high)",
        '  (description "References a checker that does not exist.")',
        "  (uses-checker missing_checker))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0307",
      file: project.rootPath,
      line: 4,
      column: 17,
      messageIncludes: 'Unknown checker "missing_checker"',
    });
  });

  it("rejects depends-on references that do not resolve to an invariant id", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BROKEN_DEPENDENCY",
        "  (severity high)",
        '  (description "Depends on an invariant that does not exist.")',
        "  (assert (eq 1 1))",
        "  (depends-on MISSING_ID))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0308",
      file: project.rootPath,
      line: 5,
      column: 15,
      messageIncludes: 'Unknown invariant dependency "MISSING_ID"',
    });
  });

  it("enforces operator arity using the core operator registry", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_ARITY",
        "  (severity high)",
        '  (description "Calls gt with too few arguments.")',
        "  (assert",
        "    (gt 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0309",
      file: project.rootPath,
      line: 5,
      column: 5,
      messageIncludes: 'Operator "gt" expects 2 arguments',
    });
  });

  it("rejects provable literal and logical type mismatches", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_TYPES",
        "  (severity high)",
        '  (description "Contains provable type mismatches.")',
        "  (assert",
        "    (and",
        '      (gt "x" 1)',
        '      "still-not-a-predicate")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      file: project.rootPath,
      line: 6,
      column: 11,
      messageIncludes: 'Expected Number but found String',
    });
  });

  it("rejects eq and neq when both operand types are known and mismatched", async () => {
    const eqProject = await createTempProject({
      "main.stele": [
        "(invariant BAD_EQ_TYPES",
        "  (severity high)",
        '  (description "eq must reject known type mismatches.")',
        '  (assert (eq 1 "x")))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(eqProject.rootPath), {
      code: "E0310",
      file: eqProject.rootPath,
      line: 4,
      column: 17,
      messageIncludes: 'Operands of "eq" must have matching types',
    });

    const neqProject = await createTempProject({
      "main.stele": [
        "(invariant BAD_NEQ_TYPES",
        "  (severity high)",
        '  (description "neq must reject known type mismatches.")',
        '  (assert (neq "x" 1)))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(neqProject.rootPath), {
      code: "E0310",
      file: neqProject.rootPath,
      line: 4,
      column: 20,
      messageIncludes: 'Operands of "neq" must have matching types',
    });
  });

  it("rejects path expressions in structural slots such as quantifier collections", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_QUANTIFIER_COLLECTION",
        "  (severity high)",
        '  (description "Quantifiers require a real collection expression.")',
        "  (assert",
        "    (forall txn",
        "      (path account total)",
        "      (gt (path txn amount) 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      file: project.rootPath,
      line: 6,
      column: 7,
      messageIncludes: 'Expected Collection but found Path',
    });
  });

  it("accepts unknown path values in value slots and binds quantifier symbols inside predicates", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant QUANTIFIED_ACCOUNT_RULE",
        "  (severity high)",
        '  (description "Uses path values and quantifier bindings conservatively.")',
        "  (assert",
        "    (and",
        "      (eq (path account owner-name) \"alice\")",
        "      (path account active)",
        "      (gt (path account total) 0)",
        "      (forall txn",
        "        (collection transactions)",
        "        (gt (path txn amount) 0)))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);

    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0]).toMatchObject({
      id: "QUANTIFIED_ACCOUNT_RULE",
      severity: "high",
    });
  });
});

async function expectSteleError(
  promise: Promise<unknown>,
  expectation: {
    code: string;
    file: string;
    line: number;
    column: number;
    messageIncludes: string;
  },
): Promise<void> {
  await expect(promise).rejects.toThrowError(SteleError);

  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SteleError);
    expect(error).toMatchObject({
      code: expectation.code,
      span: {
        file: expectation.file,
        line: expectation.line,
        column: expectation.column,
      },
    });
    expect((error as SteleError).message).toContain(expectation.messageIncludes);
  }
}

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-validator-"));
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
