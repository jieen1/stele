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

  it("parses top-level scenarios and attaches uses-scenario metadata to invariants", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_VALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL remains valid.")',
        "  (assert (gt (path pnl value) 0)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);

    expect(contract.scenarios).toHaveLength(1);
    expect(contract.scenarios[0]).toMatchObject({
      id: "fund-pnl-flow",
      sandbox: "transactional",
      executor: "python-import",
      steps: [
        {
          kind: "step",
          id: "setup-fund",
          capture: "fund",
          call: {
            target: "tests.contract_scenarios:create_fund",
            body: {
              kind: "list",
              head: "object",
            },
          },
        },
        {
          kind: "capture-state",
          capture: "pnl",
          call: {
            target: "tests.contract_scenarios:get_pnl",
            body: {
              kind: "list",
              head: "object",
            },
          },
        },
      ],
    });
    expect(contract.invariants[0]).toMatchObject({
      id: "FUND_PNL_VALID",
      usesScenario: {
        scenarioId: "fund-pnl-flow",
      },
    });
  });

  it("rejects duplicate scenario ids across loaded files", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "modules/secondary.stele")',
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
      "modules/secondary.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0315",
      file: join(project.directory, "modules", "secondary.stele"),
      line: 1,
      column: 1,
      messageIncludes: 'Scenario id "fund-pnl-flow" is already defined',
    });
  });

  it("rejects uses-scenario references that do not resolve to a known scenario", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BROKEN_SCENARIO",
        "  (uses-scenario missing-flow)",
        "  (severity high)",
        '  (description "References a scenario that does not exist.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0316",
      file: project.rootPath,
      line: 2,
      column: 18,
      messageIncludes: 'Unknown scenario "missing-flow"',
    });
  });

  it("rejects unsupported scenario executors and malformed scenario calls with source spans", async () => {
    const unsupportedExecutorProject = await createTempProject({
      "main.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor http)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(unsupportedExecutorProject.rootPath), {
      code: "E0317",
      file: unsupportedExecutorProject.rootPath,
      line: 3,
      column: 13,
      messageIncludes: 'Scenario "fund-pnl-flow" executor "http" is not supported',
    });

    const malformedCallProject = await createTempProject({
      "main.stele": [
        "(scenario broken-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        "    (call 42)",
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(malformedCallProject.rootPath), {
      code: "E0317",
      file: malformedCallProject.rootPath,
      line: 5,
      column: 11,
      messageIncludes: 'Scenario step "setup-fund" call target must be a string literal',
    });

    const malformedPythonImportTargetProject = await createTempProject({
      "main.stele": [
        "(scenario broken-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(malformedPythonImportTargetProject.rootPath), {
      code: "E0317",
      file: malformedPythonImportTargetProject.rootPath,
      line: 5,
      column: 11,
      messageIncludes: 'Scenario step "setup-fund" call target must use "module:function"',
    });
  });

  it("parses Python-only code-shape declarations and preserves their fields", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "requests" "urllib3")',
        '  (deny-call "eval")',
        '  (allow-target "src/api/safe.py"))',
        "(class-shape service_class",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        '  (must-have-field id "UUID")',
        '  (must-have-field "created_at")',
        "  (must-have-method save)",
        "  (must-extend BaseService))",
        "(function-shape handler_fn",
        "  (lang python)",
        '  (target "src/handlers.py::handle")',
        '  (must-have-call "transaction.atomic")',
        "  (must-have-decorator login_required)",
        "  (must-have-parameter request))",
        "(type-policy typing_rules",
        "  (lang python)",
        '  (target "src/**/*.py")',
        '  (deny-type "Any")',
        '  (require-type "Decimal"))',
        "(file-policy formatting_rules",
        "  (lang python)",
        '  (target "src/settings.py")',
        '  (must-contain "from __future__ import annotations")',
        '  (must-end-with "\\n"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);

    expect(contract.codeShapes).toHaveLength(5);
    expect(contract.codeShapes).toMatchObject([
      {
        kind: "boundary",
        id: "api_boundary",
        lang: "python",
        target: "src/api/*.py",
        denyImports: ["requests", "urllib3"],
        denyCalls: ["eval"],
        allowTargets: ["src/api/safe.py"],
      },
      {
        kind: "class-shape",
        id: "service_class",
        lang: "python",
        target: "src/services.py::Service",
        mustHaveFields: [
          { name: "id", type: "UUID" },
          { name: "created_at" },
        ],
        mustHaveMethods: ["save"],
        mustExtend: ["BaseService"],
      },
      {
        kind: "function-shape",
        id: "handler_fn",
        lang: "python",
        target: "src/handlers.py::handle",
        mustHaveCalls: ["transaction.atomic"],
        mustHaveDecorators: ["login_required"],
        mustHaveParameters: ["request"],
      },
      {
        kind: "type-policy",
        id: "typing_rules",
        lang: "python",
        target: "src/**/*.py",
        denyTypes: ["Any"],
        requireTypes: ["Decimal"],
      },
      {
        kind: "file-policy",
        id: "formatting_rules",
        lang: "python",
        target: "src/settings.py",
        mustContain: ["from __future__ import annotations"],
        mustEndWith: ["\n"],
      },
    ]);
    expect(contract.files[0]?.codeShapes).toHaveLength(5);
  });

  it("rejects unknown fields inside code-shape declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (must-have-call "eval"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'Boundary "api_boundary" has an unknown field "must-have-call"',
    });
  });

  it("rejects code-shape declarations that are missing target", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(file-policy formatting_rules",
        "  (lang python)",
        '  (must-contain "from __future__ import annotations"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'File policy "formatting_rules" is missing a target field',
    });
  });

  it("rejects unsupported code-shape languages (Round 14 P1: python + typescript both supported now)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(function-shape handler_fn",
        "  (lang rust)",
        '  (target "src/handlers.rs::handle")',
        "  (must-have-parameter request))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'Function shape "handler_fn" lang "rust" is not supported',
    });
  });

  it("rejects duplicate code-shape ids across different code-shape primitives", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary shared_rule",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "requests"))',
        "(class-shape shared_rule",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        "  (must-have-method save))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0319",
      messageIncludes: 'Code-shape id "shared_rule" is already defined',
    });
  });

  it("rejects class-shape must-have-field types that are not strings", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(class-shape service_class",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        "  (must-have-field id 42))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'Class shape "service_class" must-have-field type must be a string literal',
    });
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
        "    (forall p",
        "      (path positions)",
        "      (gt (path p amount) 0))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0310",
      file: project.rootPath,
      line: 6,
      column: 7,
      messageIncludes: 'Use (collection positions) instead of (path positions)',
    });
  });

  it("accepts filtered collections for cross-table numeric aggregation", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BUDGETS_RESPECT_POSTED_TRANSACTIONS",
        "  (severity high)",
        '  (description "Each budget total is computed from matching transaction rows.")',
        "  (assert",
        "    (forall budget (collection budgets)",
        "      (lte",
        "        (sum",
        "          (where txn (collection transactions)",
        "            (eq (path txn budget-id) (path budget id)))",
        "          (path amount))",
        "        (path budget limit)))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);

    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0]).toMatchObject({
      id: "BUDGETS_RESPECT_POSTED_TRANSACTIONS",
      severity: "high",
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
    file?: string;
    line?: number;
    column?: number;
    messageIncludes: string;
  },
): Promise<void> {
  await expect(promise).rejects.toThrowError(SteleError);

  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SteleError);
    expect(error).toMatchObject({ code: expectation.code });

    if (expectation.file !== undefined || expectation.line !== undefined || expectation.column !== undefined) {
      expect(error).toMatchObject({
        span: {
          file: expectation.file,
          line: expectation.line,
          column: expectation.column,
        },
      });
    }

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
