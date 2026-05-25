import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("invariant validation", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("requires id field", async () => {
    const project = await createTempProject({
      "main.stele": ["(invariant)"].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: "Invariant declarations must start with an identifier",
    });
  });

  it("requires severity field", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NO_SEVERITY",
        '  (description "Missing severity.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: "is missing a severity field",
    });
  });

  it("requires description field", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NO_DESC",
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: "is missing a description field",
    });
  });

  it("requires assert or uses-checker but not both", async () => {
    const noBody = await createTempProject({
      "main.stele": [
        "(invariant NO_BODY",
        '  (description "Missing assert and uses-checker.")',
        "  (severity high))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(noBody.rootPath), {
      code: "E0305",
      messageIncludes: "must declare exactly one of assert or uses-checker",
    });

    const both = await createTempProject({
      "main.stele": [
        "(invariant BOTH",
        '  (description "Has both assert and uses-checker.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (uses-checker my_checker))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(both.rootPath), {
      code: "E0305",
      messageIncludes: "must declare exactly one of assert or uses-checker",
    });
  });

  it("accepts valid invariant with assert", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VALID_ASSERT",
        '  (description "Simple invariant with assert.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0].id).toBe("VALID_ASSERT");
    expect(contract.invariants[0].assertExpression).toBeDefined();
    expect(contract.invariants[0].usesChecker).toBeUndefined();
  });

  it("accepts valid invariant with uses-checker", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(checker my_checker)",
        "(invariant VALID_CHECKER",
        '  (description "Invariant using external checker.")',
        "  (severity high)",
        "  (uses-checker my_checker))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0].id).toBe("VALID_CHECKER");
    expect(contract.invariants[0].usesChecker?.checkerId).toBe("my_checker");
    expect(contract.invariants[0].assertExpression).toBeUndefined();
  });

  it("accepts all allowed optional invariant fields", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ANOTHER_INVARIANT",
        '  (description "Dependency invariant.")',
        "  (severity low)",
        "  (assert (eq 1 1)))",
        "(invariant FULL_INVARIANT",
        '  (description "Has every allowed optional field.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (category business-rule)",
        "  (tags critical ledger)",
        "  (when (eq 1 1))",
        "  (tolerance (relative 0.001))",
        "  (depends-on ANOTHER_INVARIANT)",
        '  (rationale "For completeness.")',
        '  (since "2026-01-01")',
        '  (applies-to (module "ledger")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const inv = contract.invariants.find((i: any) => i.id === "FULL_INVARIANT");
    expect(inv).toBeDefined();
    expect(inv!.severity).toBe("high");
    expect(inv!.category?.name).toBe("category");
    expect(inv!.tags?.name).toBe("tags");
    expect(inv!.tolerance?.name).toBe("tolerance");
    expect(inv!.rationale?.name).toBe("rationale");
    expect(inv!.since?.name).toBe("since");
    expect(inv!.appliesTo?.name).toBe("applies-to");
    expect(inv!.whenExpression).toBeDefined();
    expect(inv!.dependsOn).toHaveLength(1);
    expect(inv!.dependsOn[0].id).toBe("ANOTHER_INVARIANT");
  });

  it("rejects unknown invariant fields", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_FIELD",
        '  (description "Has an unknown field.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (unknown-field foo))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: 'has an unknown field "unknown-field"',
    });
  });

  it("rejects duplicate invariant fields", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DUPLICATE_SEV",
        '  (description "Duplicate severity.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (severity low))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: "may declare",
    });
  });
});

describe("scenario validation", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("requires id, sandbox, executor, and at least one step", async () => {
    const emptyScenario = await createTempProject({
      "main.stele": ["(scenario)"].join("\n"),
    });

    await expectSteleError(getLoadContract()(emptyScenario.rootPath), {
      code: "E0317",
      messageIncludes: "Scenario declarations must start with an identifier",
    });

    const noFields = await createTempProject({
      "main.stele": ["(scenario my-scenario)"].join("\n"),
    });

    await expectSteleError(getLoadContract()(noFields.rootPath), {
      code: "E0317",
      messageIncludes: "is missing a sandbox field",
    });

    const noSteps = await createTempProject({
      "main.stele": [
        "(scenario no-steps",
        "  (sandbox transactional)",
        "  (executor python-import))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(noSteps.rootPath), {
      code: "E0317",
      messageIncludes: "must declare at least one step",
    });
  });

  it("accepts valid scenario with step and capture-state", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario fund-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup-fund',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund))",
        '  (capture-state pnl',
        '    (call "tests.contract_scenarios:get_pnl")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.scenarios).toHaveLength(1);
    const scenario = contract.scenarios[0];
    expect(scenario.id).toBe("fund-flow");
    expect(scenario.sandbox).toBe("transactional");
    expect(scenario.executor).toBe("python-import");
    expect(scenario.steps).toHaveLength(2);
    expect(scenario.steps[0].kind).toBe("step");
    expect(scenario.steps[1].kind).toBe("capture-state");
  });

  it("rejects unsupported sandbox value", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario bad-sandbox",
        "  (sandbox isolated)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0317",
      messageIncludes: 'sandbox "isolated" is not supported',
    });
  });

  it("rejects unsupported executor value", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario bad-executor",
        "  (sandbox transactional)",
        "  (executor http)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0317",
      messageIncludes: 'executor "http" is not supported',
    });
  });

  it("rejects malformed call target in step", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario bad-call",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "not-a-valid-target")',
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0317",
      messageIncludes: 'call target must use "module:function"',
    });
  });

  it("rejects non-string call target", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario bad-call-num",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup",
        "    (call 42)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0317",
      messageIncludes: "call target must be a string literal",
    });
  });
});

describe("code-shape declarations", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("accepts boundary declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "requests" "urllib3")',
        '  (deny-call "eval")',
        '  (allow-target "src/api/safe.py"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.codeShapes).toHaveLength(1);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("boundary");
    expect(shape.id).toBe("api_boundary");
    expect(shape.lang).toBe("python");
    expect(shape.target).toBe("src/api/*.py");
    expect(shape.denyImports).toEqual(["requests", "urllib3"]);
    expect(shape.denyCalls).toEqual(["eval"]);
    expect(shape.allowTargets).toEqual(["src/api/safe.py"]);
  });

  it("accepts class-shape declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(class-shape service_class",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        '  (must-have-field id "UUID")',
        "  (must-have-field created_at)",
        "  (must-have-method save)",
        "  (must-extend BaseService))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("class-shape");
    expect(shape.mustHaveFields).toMatchObject([
      { name: "id", type: "UUID" },
      { name: "created_at", type: undefined },
    ]);
    expect(shape.mustHaveMethods).toEqual(["save"]);
    expect(shape.mustExtend).toEqual(["BaseService"]);
  });

  it("accepts class-shape declarations with aggregate-members for free-function targets (Closeout 3a)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(class-shape check_aggregate_shape",
        "  (lang typescript)",
        '  (target "packages/cli/src/commands/check.ts::runCheck")',
        '  (must-have-method "runCheck")',
        '  (must-have-method "prepareCheckContextWithContract")',
        '  (aggregate-members "prepareCheckContextWithContract" "runCheckImpl"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("class-shape");
    if (shape.kind !== "class-shape") {
      throw new Error("expected class-shape");
    }
    expect(shape.mustHaveMethods).toEqual(["runCheck", "prepareCheckContextWithContract"]);
    expect(shape.aggregateMembers).toEqual([
      "prepareCheckContextWithContract",
      "runCheckImpl",
    ]);
  });

  it("class-shape without aggregate-members exposes an empty array (back-compat with class targets)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(class-shape regular_class",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        "  (must-have-method save))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("class-shape");
    if (shape.kind !== "class-shape") {
      throw new Error("expected class-shape");
    }
    expect(shape.aggregateMembers).toEqual([]);
  });

  it("accepts function-shape declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(function-shape handler_fn",
        "  (lang python)",
        '  (target "src/handlers.py::handle")',
        '  (must-have-call "transaction.atomic")',
        "  (must-have-decorator login_required)",
        "  (must-have-parameter request))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("function-shape");
    expect(shape.mustHaveCalls).toEqual(["transaction.atomic"]);
    expect(shape.mustHaveDecorators).toEqual(["login_required"]);
    expect(shape.mustHaveParameters).toEqual(["request"]);
  });

  it("accepts type-policy declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(type-policy typing_rules",
        "  (lang python)",
        '  (target "src/**/*.py")',
        '  (deny-type "Any")',
        '  (require-type "Decimal"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("type-policy");
    expect(shape.denyTypes).toEqual(["Any"]);
    expect(shape.requireTypes).toEqual(["Decimal"]);
  });

  it("accepts file-policy declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(file-policy formatting_rules",
        "  (lang python)",
        '  (target "src/settings.py")',
        '  (must-contain "from __future__ import annotations")',
        '  (must-end-with "\\n"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const shape = contract.codeShapes[0];
    expect(shape.kind).toBe("file-policy");
    expect(shape.mustContain).toEqual(["from __future__ import annotations"]);
    expect(shape.mustEndWith).toEqual(["\n"]);
  });

  it("rejects code-shape missing lang", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(boundary no_lang',
        '  (target "src/api/*.py"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: "is missing a lang field",
    });
  });

  it("rejects code-shape missing target", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary no_target",
        "  (lang python))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: "is missing a target field",
    });
  });

  it("rejects unknown fields in boundary", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary bad_boundary",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (must-have-call "eval"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'has an unknown field "must-have-call"',
    });
  });

  it("rejects unsupported language (Round 14 P1: python + typescript both supported now)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(function-shape rust_fn",
        "  (lang rust)",
        '  (target "src/handlers.rs"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: 'lang "rust" is not supported',
    });
  });

  it("rejects class-shape must-have-field with non-string type", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(class-shape bad_class",
        "  (lang python)",
        '  (target "src/services.py::Service")',
        "  (must-have-field id 42))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: "must-have-field type must be a string literal",
    });
  });

  it("rejects duplicate code-shape ids across different kinds", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary shared_id",
        "  (lang python)",
        '  (target "src/api/*.py"))',
        "(type-policy shared_id",
        "  (lang python)",
        '  (target "src/**/*.py")',
        '  (deny-type "Any"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0319",
      messageIncludes: 'Code-shape id "shared_id" is already defined',
    });
  });
});

describe("contract metadata", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("accepts metadata with project and stele-version", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(metadata',
        '  (stele-version "0.1")',
        '  (project "ledger")',
        "  (target-language python))",
        "(invariant MY_RULE",
        '  (description "Rule with metadata.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.metadata).toHaveLength(1);
    expect(contract.invariants).toHaveLength(1);
  });

  it("rejects duplicate metadata blocks in same file", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(metadata (stele-version "0.1") (project "first"))',
        '(metadata (stele-version "0.2") (project "second"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0302",
      messageIncludes: "metadata may appear at most once",
    });
  });

  it("aggregates declarations from imported files into contract", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "module.stele")',
        "(invariant ROOT_INVARIANT",
        '  (description "Root invariant.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "module.stele": [
        "(invariant IMPORTED_INVARIANT",
        '  (description "Imported invariant.")',
        "  (severity low)",
        "  (assert (eq 2 2)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants).toHaveLength(2);
    const ids = contract.invariants.map((inv: any) => inv.id);
    expect(ids).toContain("ROOT_INVARIANT");
    expect(ids).toContain("IMPORTED_INVARIANT");
    expect(contract.files).toHaveLength(2);
  });
});

describe("error codes", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("E0101: unmatched opening parenthesis", async () => {
    const project = await createTempProject({
      "main.stele": ["(invariant INCOMPLETE"].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0101",
      messageIncludes: "Unmatched opening parenthesis",
    });
  });

  it("E0102: list head must be identifier", async () => {
    const project = await createTempProject({
      "main.stele": ["(42 foo)"].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0102",
      messageIncludes: "List head must be an identifier",
    });
  });

  it("E0101: unmatched closing parenthesis", async () => {
    const project = await createTempProject({
      "main.stele": [")closing"].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0101",
      messageIncludes: "Unmatched closing parenthesis",
    });
  });

  it("E0306: duplicate invariant ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant DUP_ID",
        '  (description "First.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
        "(invariant DUP_ID",
        '  (description "Duplicate.")',
        "  (severity high)",
        "  (assert (eq 2 2)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0306",
      messageIncludes: 'Invariant id "DUP_ID" is already defined',
    });
  });

  it("E0307: unknown checker reference", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_CHECKER_REF",
        '  (description "References missing checker.")',
        "  (severity high)",
        "  (uses-checker nonexistent_checker))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0307",
      messageIncludes: 'Unknown checker "nonexistent_checker"',
    });
  });

  it("E0308: unknown invariant dependency", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_DEP",
        '  (description "Depends on non-existent invariant.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (depends-on MISSING_INVARIANT))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0308",
      messageIncludes: 'Unknown invariant dependency "MISSING_INVARIANT"',
    });
  });

  it("E0312: duplicate checker ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(checker my_checker)',
        '(checker my_checker)',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0312",
      messageIncludes: 'Checker id "my_checker" is already defined',
    });
  });

  it("E0313: duplicate group ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group my-group",
        "  (invariant A",
        '    (description "First.")',
        "    (severity high)",
        "    (assert (eq 1 1))))",
        "(group my-group",
        "  (invariant B",
        '    (description "Second.")',
        "    (severity high)",
        "    (assert (eq 2 2))))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0313",
      messageIncludes: 'Group id "my-group" is already defined',
    });
  });

  it("E0314: duplicate operator ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(operator my-operator)",
        "(operator my-operator)",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0314",
      messageIncludes: 'Operator id "my-operator" is already defined',
    });
  });

  it("E0315: duplicate scenario ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario my-scenario",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
        "(scenario my-scenario",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup2',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund2)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0315",
      messageIncludes: 'Scenario id "my-scenario" is already defined',
    });
  });

  it("E0316: unknown scenario reference", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant BAD_SCENARIO_REF",
        "  (uses-scenario nonexistent-scenario)",
        '  (description "References missing scenario.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0316",
      messageIncludes: 'Unknown scenario "nonexistent-scenario"',
    });
  });

  it("E0317: scenario step missing call", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario missing-call",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step no-call",
        "    (capture fund)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0317",
      messageIncludes: "is missing a call field",
    });
  });

  it("E0318: code-shape validation errors", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(file-policy bad-policy",
        '  (must-contain "something"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0318",
      messageIncludes: "is missing",
    });
  });

  it("E0319: duplicate code-shape ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary dup",
        "  (lang python)",
        '  (target "a.py"))',
        "(class-shape dup",
        "  (lang python)",
        '  (target "b.py::C"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0319",
      messageIncludes: 'Code-shape id "dup" is already defined',
    });
  });
});

describe("invariant severity validation", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("accepts identifier severity values", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ID_SEVERITY",
        '  (description "Identifier severity.")',
        "  (severity critical)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants[0].severity).toBe("critical");
  });

  it("accepts string severity values", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(invariant STRING_SEVERITY',
        '  (description "String severity.")',
        '  (severity "warning")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.invariants[0].severity).toBe("warning");
  });

  it("rejects numeric severity", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant NUM_SEVERITY",
        '  (description "Numeric severity should fail.")',
        "  (severity 42)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0305",
      messageIncludes: "severity must be an identifier or string literal",
    });
  });
});

describe("unknown top-level declarations", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects unrecognized declaration types", async () => {
    const project = await createTempProject({
      "main.stele": ["(rule active)"].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0301",
      messageIncludes: 'Unknown top-level declaration "rule"',
    });
  });
});

// Helper functions

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
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect(err).toMatchObject({ code: expectation.code });

    if (expectation.file !== undefined || expectation.line !== undefined || expectation.column !== undefined) {
      expect(err).toMatchObject({
        span: {
          file: expectation.file,
          line: expectation.line,
          column: expectation.column,
        },
      });
    }

    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-struct-"));
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
