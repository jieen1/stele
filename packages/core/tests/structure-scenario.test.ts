import { describe, expect, it } from "vitest";
import type { AstNode, ListNode } from "../src/ast/types.js";
import { SteleError } from "../src/errors/SteleError.js";
import { parseFile } from "../src/parser/parser.js";
import {
  parseScenarioCall,
  parseScenarioCaptureState,
  parseScenarioDeclaration,
  parseScenarioExecutor,
  parseScenarioSandbox,
  parseScenarioStep,
} from "../src/validator/structure-scenario.js";

const FILE = "test.stele";

// -- helpers ---------------------------------------------------------------

function parseFirstList(input: string): ListNode {
  const parsed = parseFile(input, FILE);
  const first = parsed.body[0];
  if (first === undefined || first.kind !== "list") {
    throw new Error(`Expected first body item to be a list, got ${JSON.stringify(first)}`);
  }
  return first;
}

function expectSteleError(
  fn: () => unknown,
  expectation: { code: string; messageIncludes: string },
): void {
  expect(fn).toThrowError(SteleError);

  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect(err).toMatchObject({ code: expectation.code });
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

// -- parseScenarioDeclaration ----------------------------------------------

describe("parseScenarioDeclaration", () => {
  it("accepts a minimal valid scenario with a step", () => {
    const node = parseFirstList(
      [
        "(scenario fund-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup-fund',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    );

    const result = parseScenarioDeclaration(FILE, node);

    expect(result.kind).toBe("scenario");
    expect(result.id).toBe("fund-flow");
    expect(result.sandbox).toBe("transactional");
    expect(result.executor).toBe("python-import");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("step");
    expect(result.filePath).toBe(FILE);
    expect(result.span).toBe(node.span);
  });

  it("accepts a scenario with both step and capture-state forms", () => {
    const node = parseFirstList(
      [
        "(scenario fund-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup-fund',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund))",
        '  (capture-state pnl',
        '    (call "tests.contract_scenarios:get_pnl")))',
      ].join("\n"),
    );

    const result = parseScenarioDeclaration(FILE, node);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].kind).toBe("step");
    expect(result.steps[1].kind).toBe("capture-state");
  });

  it("rejects when first item is not an identifier", () => {
    const node = parseFirstList('(scenario "not-an-id")');

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "Scenario declarations must start with an identifier",
    });
  });

  it("rejects when scenario id is missing entirely", () => {
    const node = parseFirstList("(scenario)");

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "Scenario declarations must start with an identifier",
    });
  });

  it("rejects an unsupported field entry that is not a list", () => {
    const node = parseFirstList("(scenario my-flow loose-atom)");

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "contains an unsupported field entry",
    });
  });

  it("rejects unknown scenario fields", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (mystery-field x)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: 'has an unknown field "mystery-field"',
    });
  });

  it("rejects a scenario missing the sandbox field", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "is missing a sandbox field",
    });
  });

  it("rejects a scenario missing the executor field", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (sandbox transactional)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "is missing an executor field",
    });
  });

  it("rejects a scenario with no steps", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (sandbox transactional)",
        "  (executor python-import))",
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "must declare at least one step",
    });
  });

  it("rejects duplicate sandbox fields", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (sandbox transactional)",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });

  it("rejects duplicate executor fields", () => {
    const node = parseFirstList(
      [
        "(scenario my-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );

    expectSteleError(() => parseScenarioDeclaration(FILE, node), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });
});

// -- parseScenarioSandbox --------------------------------------------------

describe("parseScenarioSandbox", () => {
  it("accepts the only supported value 'transactional'", () => {
    const outer = parseFirstList("(scenario my-flow (sandbox transactional))");
    const sandboxField = outer.items[1];
    if (sandboxField === undefined || sandboxField.kind !== "list") {
      throw new Error("Expected a sandbox list field");
    }

    const result = parseScenarioSandbox(sandboxField, "my-flow");
    expect(result).toBe("transactional");
  });

  it("rejects a non-identifier sandbox value", () => {
    const outer = parseFirstList('(scenario my-flow (sandbox "transactional"))');
    const sandboxField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioSandbox(sandboxField, "my-flow"), {
      code: "E0317",
      messageIncludes: "sandbox must be an identifier",
    });
  });

  it("rejects unsupported sandbox identifier", () => {
    const outer = parseFirstList("(scenario my-flow (sandbox isolated))");
    const sandboxField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioSandbox(sandboxField, "my-flow"), {
      code: "E0317",
      messageIncludes: 'sandbox "isolated" is not supported',
    });
  });

  it("rejects sandbox with multiple values", () => {
    const outer = parseFirstList("(scenario my-flow (sandbox transactional extra))");
    const sandboxField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioSandbox(sandboxField, "my-flow"), {
      code: "E0317",
      messageIncludes: "expects exactly one value",
    });
  });

  it("rejects sandbox with no value", () => {
    const outer = parseFirstList("(scenario my-flow (sandbox))");
    const sandboxField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioSandbox(sandboxField, "my-flow"), {
      code: "E0317",
      messageIncludes: "expects exactly one value",
    });
  });
});

// -- parseScenarioExecutor -------------------------------------------------

describe("parseScenarioExecutor", () => {
  it("accepts the only supported executor 'python-import'", () => {
    const outer = parseFirstList("(scenario my-flow (executor python-import))");
    const executorField = outer.items[1] as ListNode;

    const result = parseScenarioExecutor(executorField, "my-flow");
    expect(result).toBe("python-import");
  });

  it("rejects a non-identifier executor value", () => {
    const outer = parseFirstList('(scenario my-flow (executor "python-import"))');
    const executorField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioExecutor(executorField, "my-flow"), {
      code: "E0317",
      messageIncludes: "executor must be an identifier",
    });
  });

  it("rejects unsupported executor identifier", () => {
    const outer = parseFirstList("(scenario my-flow (executor http))");
    const executorField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioExecutor(executorField, "my-flow"), {
      code: "E0317",
      messageIncludes: 'executor "http" is not supported',
    });
  });

  it("rejects executor with no value", () => {
    const outer = parseFirstList("(scenario my-flow (executor))");
    const executorField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioExecutor(executorField, "my-flow"), {
      code: "E0317",
      messageIncludes: "expects exactly one value",
    });
  });
});

// -- parseScenarioStep -----------------------------------------------------

describe("parseScenarioStep", () => {
  it("accepts a minimal step with a call only", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")))',
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    const result = parseScenarioStep(FILE, stepField, "my-flow");
    expect(result.kind).toBe("step");
    expect(result.id).toBe("setup");
    expect(result.call.target).toBe("tests.contract_scenarios:create_fund");
    expect(result.capture).toBeUndefined();
    expect(result.filePath).toBe(FILE);
  });

  it("accepts a step with both call and capture", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    const result = parseScenarioStep(FILE, stepField, "my-flow");
    expect(result.id).toBe("setup");
    expect(result.capture).toBe("fund");
  });

  it("rejects a step missing its id", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step (call "a:b")))',
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "step declarations must start with an identifier",
    });
  });

  it("rejects a step containing a non-list field entry", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        "  (step setup loose-atom))",
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "contains an unsupported field entry",
    });
  });

  it("rejects an unknown field inside a step", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (mystery-field x)))",
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: 'has an unknown field "mystery-field"',
    });
  });

  it("rejects a step missing the call field", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup (capture fund)))',
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "is missing a call field",
    });
  });

  it("rejects duplicate call fields", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        '    (call "tests.contract_scenarios:other")))',
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });

  it("rejects duplicate capture fields", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)",
        "    (capture other)))",
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });

  it("rejects a capture field whose value is not an identifier", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        '    (capture "fund")))',
      ].join("\n"),
    );
    const stepField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioStep(FILE, stepField, "my-flow"), {
      code: "E0317",
      messageIncludes: "must be an identifier",
    });
  });
});

// -- parseScenarioCaptureState ---------------------------------------------

describe("parseScenarioCaptureState", () => {
  it("accepts a minimal capture-state declaration", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (capture-state pnl',
        '    (call "tests.contract_scenarios:get_pnl")))',
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    const result = parseScenarioCaptureState(FILE, captureField, "my-flow");
    expect(result.kind).toBe("capture-state");
    expect(result.capture).toBe("pnl");
    expect(result.call.target).toBe("tests.contract_scenarios:get_pnl");
    expect(result.filePath).toBe(FILE);
  });

  it("rejects when capture id is missing or not an identifier", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (capture-state "pnl"',
        '    (call "tests.contract_scenarios:get_pnl")))',
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCaptureState(FILE, captureField, "my-flow"), {
      code: "E0317",
      messageIncludes: "capture-state declarations must start with an identifier",
    });
  });

  it("rejects a capture-state with a non-list field entry", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (capture-state pnl loose-atom))',
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCaptureState(FILE, captureField, "my-flow"), {
      code: "E0317",
      messageIncludes: "contains an unsupported field entry",
    });
  });

  it("rejects unknown fields inside capture-state", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (capture-state pnl',
        '    (call "tests.contract_scenarios:get_pnl")',
        "    (capture other)))",
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCaptureState(FILE, captureField, "my-flow"), {
      code: "E0317",
      messageIncludes: 'has an unknown field "capture"',
    });
  });

  it("rejects a capture-state missing the call field", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        "  (capture-state pnl))",
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCaptureState(FILE, captureField, "my-flow"), {
      code: "E0317",
      messageIncludes: "is missing a call field",
    });
  });

  it("rejects duplicate call fields inside capture-state", () => {
    const outer = parseFirstList(
      [
        "(scenario my-flow",
        '  (capture-state pnl',
        '    (call "tests.contract_scenarios:get_pnl")',
        '    (call "tests.contract_scenarios:other")))',
      ].join("\n"),
    );
    const captureField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCaptureState(FILE, captureField, "my-flow"), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });
});

// -- parseScenarioCall -----------------------------------------------------

describe("parseScenarioCall", () => {
  it("accepts a minimal call with only a target string", () => {
    const outer = parseFirstList('(step setup (call "tests.contract_scenarios:create_fund"))');
    const callField = outer.items[1] as ListNode;

    const result = parseScenarioCall(callField, 'Scenario step "setup"');
    expect(result.target).toBe("tests.contract_scenarios:create_fund");
    expect(result.body).toBeUndefined();
    expect(result.span).toBe(callField.span);
  });

  it("accepts a call with an optional body form", () => {
    const outer = parseFirstList(
      '(step setup (call "tests.contract_scenarios:create_fund" (body 42)))',
    );
    const callField = outer.items[1] as ListNode;

    const result = parseScenarioCall(callField, 'Scenario step "setup"');
    expect(result.target).toBe("tests.contract_scenarios:create_fund");
    expect(result.body).toBeDefined();
    const body = result.body as AstNode;
    expect(body.kind).toBe("number");
  });

  it("rejects a call missing its target (zero arity)", () => {
    const outer = parseFirstList("(step setup (call))");
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "call target must be a string literal",
    });
  });

  it("rejects a call whose target is not a string literal", () => {
    const outer = parseFirstList("(step setup (call 42))");
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "call target must be a string literal",
    });
  });

  it("rejects a call whose target is an identifier rather than a string", () => {
    const outer = parseFirstList("(step setup (call create_fund))");
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "call target must be a string literal",
    });
  });

  it("rejects a target string missing the colon separator", () => {
    const outer = parseFirstList('(step setup (call "no_colon_target"))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: 'call target must use "module:function"',
    });
  });

  it("rejects a target string with a colon in leading position (empty module)", () => {
    const outer = parseFirstList('(step setup (call ":missing_module"))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: 'call target must use "module:function"',
    });
  });

  it("rejects a target string with multiple colon separators", () => {
    const outer = parseFirstList('(step setup (call "module:function:extra"))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: 'call target must use "module:function"',
    });
  });

  it("rejects a target string with empty function part", () => {
    const outer = parseFirstList('(step setup (call "module:"))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: 'call target must use "module:function"',
    });
  });

  it("rejects an extra non-body field after the target", () => {
    const outer = parseFirstList('(step setup (call "a:b" (extra value)))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "has an unsupported field",
    });
  });

  it("rejects a non-list field after the target", () => {
    const outer = parseFirstList('(step setup (call "a:b" loose-atom))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "has an unsupported field",
    });
  });

  it("rejects duplicate body fields", () => {
    const outer = parseFirstList('(step setup (call "a:b" (body 1) (body 2)))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "may only be declared once",
    });
  });

  it("rejects a body field with no value", () => {
    const outer = parseFirstList('(step setup (call "a:b" (body)))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "expects exactly one value",
    });
  });

  it("rejects a body field with multiple values", () => {
    const outer = parseFirstList('(step setup (call "a:b" (body 1 2)))');
    const callField = outer.items[1] as ListNode;

    expectSteleError(() => parseScenarioCall(callField, 'Scenario step "setup"'), {
      code: "E0317",
      messageIncludes: "expects exactly one value",
    });
  });
});

