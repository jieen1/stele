import {
  type InvariantDeclaration,
  type ScenarioDeclaration,
  type Contract,
  type AstNode,
} from "@stele/core";
import { SteleError } from "@stele/core";
import {
  INDENT,
  BASE_RUNTIME_HELPERS,
  SCENARIO_RUNTIME_HELPERS,
  EP04_RUNTIME_HELPERS,
} from "./types.js";
import {
  serializeScenario,
  renderPythonValue,
} from "./scenario-serialization.js";
import { translateExpression } from "./expression.js";
import {
  allocateUniquePythonName,
  sanitizePythonIdentifier,
  createTranslationContext,
  toPythonString,
  encodeCheckerArgs,
} from "./translation-utils.js";

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

// ---------------------------------------------------------------------------
// Import lines
// ---------------------------------------------------------------------------

export function buildPytestImportLine(contract: Contract, generatedBody = ""): string {
  const helpers = contract.invariants.some((invariant) => invariant.usesScenario !== undefined)
    ? [...BASE_RUNTIME_HELPERS.slice(0, 3), ...SCENARIO_RUNTIME_HELPERS, BASE_RUNTIME_HELPERS[3]!]
    : [...BASE_RUNTIME_HELPERS];

  const referencedEp04Helpers = EP04_RUNTIME_HELPERS.filter((helper) => {
    const pattern = new RegExp(`\\b${helper}\\b`);
    return pattern.test(generatedBody);
  });

  return `from ._stele_runtime import ${[...helpers, ...referencedEp04Helpers].join(", ")}`;
}

// ---------------------------------------------------------------------------
// Invariant test rendering
// ---------------------------------------------------------------------------

export function renderInvariantTest(
  invariant: InvariantDeclaration,
  testName: string,
  scenariosById: ReadonlyMap<string, ScenarioDeclaration>,
): string[] {
  const usesScenario = invariant.usesScenario !== undefined;
  const assertionContextName = usesScenario ? "stele_assert_context" : "stele_context";
  const checkerContextName = usesScenario ? "stele_assert_context" : "stele_context";
  const expressionContext = createTranslationContext(new Map(), new Set(), assertionContextName);
  const lines = [`def ${testName}(${usesScenario ? "stele_context, stele_sandbox" : "stele_context"}):`];

  if (invariant.usesScenario !== undefined) {
    const scenario = scenariosById.get(invariant.usesScenario.scenarioId);

    if (scenario === undefined) {
      throw new SteleError(
        "E0605",
        "Backend Error",
        `Invariant "${invariant.id}" references an unknown scenario "${invariant.usesScenario.scenarioId}".`,
        invariant.usesScenario.span,
        "Scenario references should have been validated by @stele/core before backend generation.",
        "Fix the contract or re-run generation after scenario validation passes.",
      );
    }

    const scenarioLiteralLines = renderPythonValue(serializeScenario(scenario), 2);
    lines.push(`${INDENT}stele_scenario_context = stele_run_scenario(`);
    lines.push(...scenarioLiteralLines);
    lines.push(`${INDENT}${INDENT}stele_context,`);
    lines.push(`${INDENT}${INDENT}stele_sandbox,`);
    lines.push(`${INDENT})`);
    lines.push(`${INDENT}stele_assert_context = stele_merge_contexts(stele_context, stele_scenario_context)`);
  }

  if (invariant.whenExpression !== undefined) {
    lines.push(`${INDENT}if not (${translateExpression(invariant.whenExpression, expressionContext)}):`);
    lines.push(`${INDENT}${INDENT}return`);
  }

  if (invariant.usesChecker !== undefined) {
    const checkerArgs = encodeCheckerArgs(invariant.usesChecker.args, expressionContext);
    lines.push(
      `${INDENT}result = stele_call_checker(${toPythonString(invariant.usesChecker.checkerId)}, ${checkerContextName}, ${checkerArgs})`,
    );
    lines.push(
      `${INDENT}assert result["passed"], result.get("message") or ${toPythonString(`Checker failed: ${invariant.usesChecker.checkerId}`)}`,
    );
    return lines;
  }

  lines.push(...renderAssertionLines(invariant.assertExpression!, expressionContext));
  return lines;
}

// ---------------------------------------------------------------------------
// Assertion rendering
// ---------------------------------------------------------------------------

function renderAssertionLines(node: AstNode, context: ReturnType<typeof createTranslationContext>): string[] {
  if (node.kind === "list" && node.head === "eq" && node.items.length === 2 && isMultilineArithmetic(node.items[1])) {
    return [
      `${INDENT}assert ${translateExpression(node.items[0]!, context)} == (`,
      ...renderArithmeticExpressionLines(node.items[1] as any, 2, context),
      `${INDENT})`,
    ];
  }

  if (node.kind === "list" && node.head === "forall" && node.items.length === 3) {
    return renderForallAssertionLines(node as any, context);
  }

  return [`${INDENT}assert ${translateExpression(node, context)}`];
}

function renderForallAssertionLines(node: any, context: ReturnType<typeof createTranslationContext>): string[] {
  const binding = node.items[0];

  if (binding?.kind !== "identifier") {
    throw new SteleError(
      "E0602",
      "Backend Error",
      'Operator "forall" must bind an identifier.',
      node.span,
      "The first quantifier argument becomes the Python loop variable in generated pytest.",
      'Use a form like (forall txn (collection transactions) ...).',
    );
  }

  const bound = context.bind(binding.value);
  const collection = translateExpression(node.items[1]!, context);
  const predicate = translateExpression(node.items[2]!, bound.context);

  return [
    `${INDENT}assert all(`,
    `${INDENT}${INDENT}${predicate}`,
    `${INDENT}${INDENT}for ${bound.name} in ${collection}`,
    `${INDENT})`,
  ];
}

function renderArithmeticExpressionLines(node: any, indentLevel: number, context: ReturnType<typeof createTranslationContext>): string[] {
  const symbol = arithmeticSymbol(node.head);
  const prefix = INDENT.repeat(indentLevel);

  return node.items.map((item: any, index: number) => `${prefix}${index === 0 ? "" : `${symbol} `}${translateExpression(item, context)}`);
}

function arithmeticSymbol(operator: string): string {
  switch (operator) {
    case "add":
      return "+";
    case "mul":
      return "*";
    case "sub":
      return "-";
    case "div":
      return "/";
    default:
      throw new Error(`Unsupported multiline arithmetic operator "${operator}".`);
  }
}

function isMultilineArithmetic(node: AstNode | undefined): boolean {
  return node?.kind === "list" && (node.head === "add" || node.head === "mul" || node.head === "sub" || node.head === "div");
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

export function generatePytestSource(contract: Contract): string {
  const invariants = contract.invariants.slice().sort(compareInvariants);
  const scenariosById = new Map(contract.scenarios.map((scenario) => [scenario.id, scenario] as const));
  const usedTestNames = new Set<string>();
  const bodyLines: string[] = [];

  invariants.forEach((invariant, index) => {
    const testName = allocateUniquePythonName(`test_${sanitizePythonIdentifier(invariant.id, "invariant")}`, usedTestNames);
    usedTestNames.add(testName);
    bodyLines.push(...renderInvariantTest(invariant, testName, scenariosById));
    bodyLines.push(index === invariants.length - 1 ? "" : "");

    if (index !== invariants.length - 1) {
      bodyLines.push("");
    }
  });

  const lines = [buildPytestImportLine(contract, bodyLines.join("\n")), "", "", ...bodyLines];

  return `${lines.join("\n")}`;
}
