import {
  SteleError,
  type AstNode,
  type BoundaryDeclaration,
  type ClassShapeDeclaration,
  type CodeShapeDeclaration,
  type Contract,
  type FilePolicyDeclaration,
  type FunctionShapeDeclaration,
  type InvariantDeclaration,
  type ListNode,
  type ScenarioDeclaration,
  type ScenarioOperation,
  type TypePolicyDeclaration,
} from "@stele/core";
import { getPythonRuntimeSource, PYTEST_RUNTIME_PATH } from "./runtime.js";
import { arithmeticOperatorHandlers } from "./templates/arithmetic.js";
import { collectionOperatorHandlers } from "./templates/collection.js";
import { comparisonOperatorHandlers, extendedComparisonHandlers } from "./templates/comparison.js";
import { logicOperatorHandlers } from "./templates/logic.js";
import { temporalOperatorHandlers } from "./templates/temporal.js";
import { stringOperatorHandlers } from "./templates/string.js";

export const PYTEST_PACKAGE_INIT_PATH = "tests/contract/__init__.py";
export const PYTEST_TEST_PATH = "tests/contract/test_contract.py";
export const PYTEST_CODE_SHAPE_PATH = "tests/contract/test_code_shape.py";

export type GeneratedPytestFile = {
  path: string;
  content: string;
};

export type PythonExpressionTranslator = (node: AstNode, context?: TranslationContext) => string;

export type PythonOperatorHandler = (
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
) => string;

export type TranslationContext = {
  readonly bindings: ReadonlyMap<string, string>;
  readonly rootContextName: string;
  readonly usedNames: ReadonlySet<string>;
  bind(identifier: string): { name: string; context: TranslationContext };
  resolve(identifier: string): string | undefined;
};

const INDENT = "    ";
const BASE_RUNTIME_HELPERS = ["stele_call_checker", "stele_get_path", "stele_is_modified", "stele_sum"];
const SCENARIO_RUNTIME_HELPERS = ["stele_merge_contexts", "stele_run_scenario"];
const EP04_RUNTIME_HELPERS = [
  "stele_ceil",
  "stele_concat",
  "stele_first",
  "stele_floor",
  "stele_join",
  "stele_last",
  "stele_length",
  "stele_lower",
  "stele_map",
  "stele_mod",
  "stele_pow",
  "stele_round",
  "stele_sort_by",
  "stele_sort_by_desc",
  "stele_split",
  "stele_trim",
  "stele_type_of",
  "stele_upper",
];
const CODE_SHAPE_RUNTIME_HELPERS = [
  "stele_collect_imports",
  "stele_get_class_fields",
  "stele_get_type_hints",
  "stele_glob",
  "stele_has_callable",
  "stele_has_field",
  "stele_import_allowed",
  "stele_read_file",
  "stele_resolve_class",
  "stele_resolve_function",
  "stele_type_matches",
];
const PYTHON_RESERVED_WORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "_",
]);

const PYTHON_OPERATOR_HANDLERS: Record<string, PythonOperatorHandler> = {
  path: translatePath,
  field: translateField,
  value: translateValue,
  ...comparisonOperatorHandlers,
  ...extendedComparisonHandlers,
  ...arithmeticOperatorHandlers,
  ...collectionOperatorHandlers,
  ...logicOperatorHandlers,
  ...temporalOperatorHandlers,
  ...stringOperatorHandlers,
};

export function generatePytestFiles(contract: Contract): GeneratedPytestFile[] {
  const files: GeneratedPytestFile[] = [
    {
      path: PYTEST_PACKAGE_INIT_PATH,
      content: "",
    },
    {
      path: PYTEST_RUNTIME_PATH,
      content: getPythonRuntimeSource(),
    },
    {
      path: PYTEST_TEST_PATH,
      content: generatePytestSource(contract),
    },
  ];

  if (contract.codeShapes.length > 0) {
    files.push({
      path: PYTEST_CODE_SHAPE_PATH,
      content: generatePytestCodeShapeSource(contract),
    });
  }

  return files;
}

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

/**
 * EP06: render the per-contract Code Shape pytest file.
 *
 * Each declaration becomes one `def test_<kind>_<id>(stele_context):` whose
 * body uses runtime helpers from `_stele_runtime.py`. The file is only
 * emitted when the contract carries at least one Code Shape declaration —
 * see `generatePytestFiles`.
 */
export function generatePytestCodeShapeSource(contract: Contract): string {
  const declarations = contract.codeShapes.slice().sort(compareCodeShapes);
  const usedTestNames = new Set<string>();
  const bodyLines: string[] = [];

  declarations.forEach((declaration, index) => {
    const testName = allocateUniquePythonName(
      `test_${codeShapeTestPrefix(declaration.kind)}_${sanitizePythonIdentifier(declaration.id, "code_shape")}`,
      usedTestNames,
    );
    usedTestNames.add(testName);
    bodyLines.push(...renderCodeShapeTest(declaration, testName));
    if (index !== declarations.length - 1) {
      bodyLines.push("");
      bodyLines.push("");
    }
  });

  const lines = [buildCodeShapeImportLine(), "", "", ...bodyLines, ""];
  return lines.join("\n");
}

export function translateExpression(node: AstNode, context = createTranslationContext()): string {
  if (node.kind === "number") {
    return node.raw;
  }

  if (node.kind === "string") {
    return toPythonString(node.value);
  }

  if (node.kind === "keyword") {
    return toPythonString(`:${node.value}`);
  }

  if (node.kind === "identifier") {
    const binding = context.resolve(node.value);

    if (binding !== undefined) {
      return binding;
    }

    switch (node.value) {
      case "true":
        return "True";
      case "false":
        return "False";
      case "null":
      case "none":
        return "None";
      default:
        throw new SteleError(
          "E0602",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in Python backend expression.`,
          node.span,
          "Only bound variables, booleans, null-like symbols, and operator forms translate directly to Python.",
          "Wrap values in supported operators such as path, collection, or value.",
        );
    }
  }

  const handler = PYTHON_OPERATOR_HANDLERS[node.head];

  if (handler === undefined) {
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Unsupported Python backend operator "${node.head}".`,
      node.span,
      "This operator is not yet implemented by @stele/backend-python.",
      "Use a supported operator or extend the backend translator before generating pytest output.",
    );
  }

  return handler(node, context, translateExpression);
}

export function sanitizePythonIdentifier(identifier: string, fallbackPrefix = "value"): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withPrefix = sanitized.length === 0 ? fallbackPrefix : sanitized;
  return /^[0-9]/.test(withPrefix) ? `${fallbackPrefix}_${withPrefix}` : withPrefix;
}

function renderInvariantTest(
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

function renderAssertionLines(node: AstNode, context: TranslationContext): string[] {
  if (node.kind === "list" && node.head === "eq" && node.items.length === 2 && isMultilineArithmetic(node.items[1])) {
    return [
      `${INDENT}assert ${translateExpression(node.items[0]!, context)} == (`,
      ...renderArithmeticExpressionLines(node.items[1] as ListNode, 2, context),
      `${INDENT})`,
    ];
  }

  if (node.kind === "list" && node.head === "forall" && node.items.length === 3) {
    return renderForallAssertionLines(node, context);
  }

  return [`${INDENT}assert ${translateExpression(node, context)}`];
}

function renderForallAssertionLines(node: ListNode, context: TranslationContext): string[] {
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

function renderArithmeticExpressionLines(node: ListNode, indentLevel: number, context: TranslationContext): string[] {
  const symbol = arithmeticSymbol(node.head);
  const prefix = INDENT.repeat(indentLevel);

  return node.items.map((item, index) => `${prefix}${index === 0 ? "" : `${symbol} `}${translateExpression(item, context)}`);
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

function isMultilineArithmetic(node: AstNode | undefined): node is ListNode {
  return node?.kind === "list" && (node.head === "add" || node.head === "mul" || node.head === "sub" || node.head === "div");
}

function translatePath(node: ListNode, context: TranslationContext): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" requires at least one segment.',
      node.span,
      "A path expression needs one or more symbol segments to translate to Python.",
      'Use a form like (path account cash).',
    );
  }

  const [root, ...parts] = node.items;

  if (root?.kind !== "identifier" && root?.kind !== "keyword") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" expects symbol-like path segments.',
      root?.span ?? node.span,
      `Found ${root?.kind ?? "nothing"} where the root path segment should be.`,
      "Use identifiers or keywords for path parts.",
    );
  }

  const rootKey = root.kind === "keyword" ? `:${root.value}` : root.value;
  const binding = root.kind === "identifier" ? context.resolve(root.value) : undefined;
  const pathParts = parts.map(readPathPart);

  if (binding !== undefined) {
    return pathParts.length === 0 ? binding : `stele_get_path(${binding}, ${JSON.stringify(pathParts)})`;
  }

  if (parts.length === 0) {
    return `stele_get_path(${context.rootContextName}, ${JSON.stringify([rootKey])})`;
  }

  return `stele_get_path(${context.rootContextName}[${toPythonString(rootKey)}], ${JSON.stringify(pathParts)})`;
}

function translateField(node: ListNode, context: TranslationContext): string {
  const base = node.items[0];
  const field = node.items[1];

  if (base?.kind !== "list" || base.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects its first argument to be a path expression.',
      base?.span ?? node.span,
      "The Python backend extends existing path expressions by appending one field segment.",
      'Use a form like (field (path account) cash).',
    );
  }

  if (field?.kind !== "identifier" && field?.kind !== "keyword") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects an identifier or keyword segment.',
      field?.span ?? node.span,
      `Found ${field?.kind ?? "nothing"} where the appended field should be.`,
      "Replace the appended segment with a symbol-like path part.",
    );
  }

  const extendedPath: ListNode = {
    kind: "list",
    head: "path",
    items: [...base.items, field],
    span: node.span,
  };

  return translatePath(extendedPath, context);
}

function translateValue(node: ListNode, context: TranslationContext): string {
  return translateExpression(node.items[0]!, context);
}

function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") {
    return node.value;
  }

  if (node.kind === "keyword") {
    return `:${node.value}`;
  }

  throw new SteleError(
    "E0603",
    "Backend Error",
    'Path segments must be identifiers or keywords in the Python backend.',
    node.span,
    `Found ${node.kind} in a translated path expression.`,
    "Replace the segment with a symbol-like path part.",
  );
}

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

function buildPytestImportLine(contract: Contract, generatedBody = ""): string {
  const helpers = contract.invariants.some((invariant) => invariant.usesScenario !== undefined)
    ? [...BASE_RUNTIME_HELPERS.slice(0, 3), ...SCENARIO_RUNTIME_HELPERS, BASE_RUNTIME_HELPERS[3]!]
    : [...BASE_RUNTIME_HELPERS];

  // EP04 batch 1: only add new helper imports when the generated body actually
  // calls them. Word-boundary regex avoids false positives on prefix matches
  // (e.g. stele_first vs stele_first_seen). Helpers stay alphabetically sorted
  // after the base/scenario block.
  const referencedEp04Helpers = EP04_RUNTIME_HELPERS.filter((helper) => {
    const pattern = new RegExp(`\\b${helper}\\b`);
    return pattern.test(generatedBody);
  });

  return `from ._stele_runtime import ${[...helpers, ...referencedEp04Helpers].join(", ")}`;
}

function serializeScenario(scenario: ScenarioDeclaration): Record<string, unknown> {
  return {
    id: scenario.id,
    executor: scenario.executor,
    sandbox: scenario.sandbox,
    steps: scenario.steps.map((step) => serializeScenarioOperation(step)),
  };
}

function serializeScenarioOperation(step: ScenarioOperation): Record<string, unknown> {
  if (step.kind === "step") {
    return {
      kind: step.kind,
      id: step.id,
      capture: step.capture,
      call: serializeScenarioCall(step.call.target, step.call.body),
    };
  }

  return {
    kind: step.kind,
    capture: step.capture,
    call: serializeScenarioCall(step.call.target, step.call.body),
  };
}

function serializeScenarioCall(target: string, body: AstNode | undefined): Record<string, unknown> {
  return {
    target,
    ...(body === undefined ? {} : { body: serializeScenarioValue(body) }),
  };
}

function serializeScenarioValue(node: AstNode): unknown {
  if (node.kind === "number") {
    return node.value;
  }

  if (node.kind === "string") {
    return node.value;
  }

  if (node.kind === "keyword") {
    return `:${node.value}`;
  }

  if (node.kind === "identifier") {
    switch (node.value) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
      case "none":
        return null;
      default:
        throw new SteleError(
          "E0606",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in scenario body.`,
          node.span,
          "Scenario bodies currently support object, ref, gen, booleans, and null-like identifiers.",
          "Wrap the value in a supported scenario expression or quote it as a string literal.",
        );
    }
  }

  if (node.head === "object") {
    return Object.fromEntries(node.items.map((item) => serializeScenarioObjectField(item)));
  }

  if (node.head === "ref") {
    return {
      $ref: serializeScenarioRef(node),
    };
  }

  if (node.head === "gen") {
    return {
      $gen: serializeScenarioGenerator(node),
    };
  }

  throw new SteleError(
    "E0606",
    "Backend Error",
    `Unsupported scenario body operator "${node.head}".`,
    node.span,
    "The Python scenario slice supports object, ref, and gen forms inside scenario call bodies.",
    "Rewrite this body using the supported scenario expression forms.",
  );
}

function serializeScenarioObjectField(node: AstNode): [string, unknown] {
  if (node.kind !== "list") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario object fields must be list entries.",
      node.span,
      "Each object field should look like (key expr).",
      "Rewrite this object entry as a single-field list.",
    );
  }

  if (node.items.length !== 1) {
    throw new SteleError(
      "E0606",
      "Backend Error",
      `Scenario object field "${node.head}" expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value for each object key.",
    );
  }

  return [node.head, serializeScenarioValue(node.items[0]!)];
}

function serializeScenarioRef(node: ListNode): string[] {
  const [captureNode, ...fieldNodes] = node.items;

  if (captureNode?.kind !== "identifier") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario ref expressions must start with a captured identifier.",
      captureNode?.span ?? node.span,
      `Found ${captureNode === undefined ? "nothing" : captureNode.kind} where the capture name should be.`,
      "Use a form like (ref fund id).",
    );
  }

  return [captureNode.value, ...fieldNodes.map(readPathPart)];
}

function serializeScenarioGenerator(node: ListNode): Record<string, unknown> {
  const [kindNode, prefixNode] = node.items;

  if (kindNode?.kind !== "identifier" || kindNode.value !== "unique-name") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario gen expressions currently support only unique-name.",
      kindNode?.span ?? node.span,
      `Found ${kindNode === undefined ? "nothing" : describeScenarioNode(kindNode)} instead.`,
      'Use a form like (gen unique-name "fund").',
    );
  }

  if (prefixNode?.kind !== "string" || node.items.length !== 2) {
    throw new SteleError(
      "E0606",
      "Backend Error",
      'Scenario gen unique-name expects exactly one string prefix.',
      prefixNode?.span ?? node.span,
      `Found ${node.items.length - 1} generator argument(s).`,
      'Use a form like (gen unique-name "fund").',
    );
  }

  return {
    kind: "unique-name",
    prefix: prefixNode.value,
  };
}

function renderPythonValue(value: unknown, indentLevel: number): string[] {
  const prefix = INDENT.repeat(indentLevel);

  if (value === null) {
    return [`${prefix}None,`];
  }

  if (typeof value === "string") {
    return [`${prefix}${toPythonString(value)},`];
  }

  if (typeof value === "number") {
    return [`${prefix}${String(value)},`];
  }

  if (typeof value === "boolean") {
    return [`${prefix}${value ? "True" : "False"},`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[],`];
    }

    const lines = [`${prefix}[`];

    for (const item of value) {
      lines.push(...renderPythonValue(item, indentLevel + 1));
    }

    lines.push(`${prefix}],`);
    return lines;
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    return [`${prefix}{},`];
  }

  const lines = [`${prefix}{`];

  for (const [key, entryValue] of entries) {
    const renderedInline = renderInlinePythonValue(entryValue);

    if (renderedInline !== undefined) {
      lines.push(`${INDENT.repeat(indentLevel + 1)}${toPythonString(key)}: ${renderedInline},`);
      continue;
    }

    lines.push(`${INDENT.repeat(indentLevel + 1)}${toPythonString(key)}:`);
    lines.push(...renderPythonValue(entryValue, indentLevel + 2));
  }

  lines.push(`${prefix}},`);
  return lines;
}

function renderInlinePythonValue(value: unknown): string | undefined {
  if (value === null) {
    return "None";
  }

  if (typeof value === "string") {
    return toPythonString(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return `[${value.map((item) => toPythonString(item)).join(", ")}]`;
    }

    return undefined;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0) {
      return "{}";
    }

    if (entries.every(([, entryValue]) => renderInlinePythonValue(entryValue) !== undefined)) {
      return `{${entries
        .map(([key, entryValue]) => `${toPythonString(key)}: ${renderInlinePythonValue(entryValue)}`)
        .join(", ")}}`;
    }
  }

  return undefined;
}

function describeScenarioNode(node: AstNode): string {
  if (node.kind === "list") {
    return `list "${node.head}"`;
  }

  return `${node.kind} "${node.value}"`;
}

function createTranslationContext(
  bindings = new Map<string, string>(),
  usedNames = new Set<string>(),
  rootContextName = "stele_context",
): TranslationContext {
  return {
    bindings,
    rootContextName,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniquePythonName(sanitizePythonIdentifier(identifier, "item"), usedNames);
      const nextBindings = new Map(bindings);
      const nextUsedNames = new Set(usedNames);
      nextBindings.set(identifier, name);
      nextUsedNames.add(name);
      return {
        name,
        context: createTranslationContext(nextBindings, nextUsedNames, rootContextName),
      };
    },
    resolve(identifier: string) {
      return bindings.get(identifier);
    },
  };
}

function allocateUniquePythonName(baseName: string, usedNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate) || PYTHON_RESERVED_WORDS.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function toPythonString(value: string): string {
  return JSON.stringify(value);
}

export function wrapExpression(value: string): string {
  return /^[A-Za-z0-9_.\[\]"]+$/.test(value) ? value : `(${value})`;
}

function encodeCheckerArgs(args: AstNode[], _context: TranslationContext): string {
  if (args.length === 0) {
    return "{}";
  }

  const pairs: string[] = [];

  for (const arg of args) {
    if (arg.kind !== "list" || arg.items.length !== 2 || arg.items[0]?.kind !== "identifier") {
      continue;
    }

    const key = arg.items[0].value;
    const valueNode = arg.items[1];

    if (valueNode?.kind === "number") {
      pairs.push(`${toPythonString(key)}: ${valueNode.raw}`);
    } else if (valueNode?.kind === "string") {
      pairs.push(`${toPythonString(key)}: ${toPythonString(valueNode.value)}`);
    } else if (valueNode?.kind === "identifier") {
      if (valueNode.value === "true") {
        pairs.push(`${toPythonString(key)}: True`);
      } else if (valueNode.value === "false") {
        pairs.push(`${toPythonString(key)}: False`);
      } else if (valueNode.value === "null" || valueNode.value === "none") {
        pairs.push(`${toPythonString(key)}: None`);
      }
    }
  }

  return `{${pairs.join(", ")}}`;
}

// ---------------------------------------------------------------------------
// EP06: Code Shape pytest emitters
// ---------------------------------------------------------------------------

type CodeShapeTarget = {
  pathPattern: string;
  selectorName?: string;
  selectorFilter?: string;
};

function compareCodeShapes(left: CodeShapeDeclaration, right: CodeShapeDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

function buildCodeShapeImportLine(): string {
  const helpers = ["pytest"].join(", ");
  const runtimeHelpers = CODE_SHAPE_RUNTIME_HELPERS.join(", ");
  return [
    `import inspect`,
    `import ${helpers}`,
    `from ._stele_runtime import ${runtimeHelpers}`,
  ].join("\n");
}

function codeShapeTestPrefix(kind: CodeShapeDeclaration["kind"]): string {
  switch (kind) {
    case "boundary":
      return "boundary";
    case "class-shape":
      return "class_shape";
    case "function-shape":
      return "function_shape";
    case "type-policy":
      return "type_policy";
    case "file-policy":
      return "file_policy";
  }
}

function parseCodeShapeTarget(target: string): CodeShapeTarget {
  const separator = target.indexOf("::");
  if (separator === -1) {
    return { pathPattern: target };
  }
  const pathPattern = target.slice(0, separator);
  const selector = target.slice(separator + 2).trim();
  if (selector.startsWith("[") && selector.endsWith("]")) {
    return { pathPattern, selectorFilter: selector.slice(1, -1) };
  }
  const filterIndex = selector.indexOf("[");
  if (filterIndex !== -1 && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorName: selector.slice(0, filterIndex),
      selectorFilter: selector.slice(filterIndex + 1, -1),
    };
  }
  return { pathPattern, selectorName: selector };
}

/**
 * Convert a literal Python file path to a dotted module path.
 *
 * "app/account.py" -> "app.account"
 * "app/__init__.py" -> "app"
 *
 * Throws E0608 when the path contains glob metacharacters; class-shape /
 * function-shape declarations need a single concrete module, so a wildcard
 * target cannot be resolved at runtime.
 */
function fileToModulePath(declaration: CodeShapeDeclaration, pathPattern: string): string {
  if (/[*?\[\]]/.test(pathPattern)) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} cannot use glob metacharacters when a class or function selector is present.`,
      declaration.span,
      `${declaration.kind} declarations need a literal file path so the Python backend can resolve a single module.`,
      `Use a single file like (target "app/account.py::Account").`,
    );
  }
  if (!pathPattern.endsWith(".py")) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} must end with ".py".`,
      declaration.span,
      "Python module resolution needs a .py file path so the backend can derive the dotted module name.",
      `Use a target like (target "app/account.py::Account").`,
    );
  }
  const stripped = pathPattern.slice(0, -3);
  const segments = stripped.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} did not yield any module segments.`,
      declaration.span,
      "Python module resolution needs at least one path segment so the backend can derive a dotted module name.",
      `Use a target like (target "app/account.py::Account").`,
    );
  }
  if (segments[segments.length - 1] === "__init__") {
    segments.pop();
  }
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new SteleError(
        "E0608",
        "Backend Error",
        `Code shape "${declaration.id}" target segment ${JSON.stringify(segment)} is not a valid Python identifier.`,
        declaration.span,
        "Each path segment must form a valid Python module name.",
        "Rename the directory/file so each component is a Python identifier.",
      );
    }
  }
  return segments.join(".");
}

function renderCodeShapeTest(declaration: CodeShapeDeclaration, testName: string): string[] {
  const header = `def ${testName}(stele_context):`;
  let body: string[];
  switch (declaration.kind) {
    case "class-shape":
      body = renderClassShapeBody(declaration);
      break;
    case "function-shape":
      body = renderFunctionShapeBody(declaration);
      break;
    case "boundary":
      body = renderBoundaryBody(declaration);
      break;
    case "type-policy":
      body = renderTypePolicyBody(declaration);
      break;
    case "file-policy":
      body = renderFilePolicyBody(declaration);
      break;
  }
  if (body.length === 0) {
    body = [`${INDENT}pass`];
  }
  return [header, ...body];
}

function renderClassShapeBody(declaration: ClassShapeDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  if (target.selectorName === undefined || target.selectorName === "") {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Class shape "${declaration.id}" must specify a class name after "::" (e.g. "app/account.py::Account").`,
      declaration.span,
      "The Python backend resolves a single class via importlib; a glob target alone is ambiguous.",
      `Add a class name to the target.`,
    );
  }
  const modulePath = fileToModulePath(declaration, target.pathPattern);
  const qualified = `${modulePath}.${target.selectorName}`;
  const lines: string[] = [];
  lines.push(`${INDENT}cls = stele_resolve_class(${toPythonString(qualified)})`);

  for (const field of declaration.mustHaveFields) {
    const failureMessage = field.type === undefined
      ? `class-shape ${declaration.id}: field ${JSON.stringify(field.name)} missing on ${qualified}`
      : `class-shape ${declaration.id}: field ${JSON.stringify(field.name)} missing or wrong type (expected ${field.type}) on ${qualified}`;
    if (field.type === undefined) {
      lines.push(`${INDENT}if not stele_has_field(cls, ${toPythonString(field.name)}):`);
    } else {
      lines.push(
        `${INDENT}if not stele_has_field(cls, ${toPythonString(field.name)}, expected_type=${toPythonString(field.type)}):`,
      );
    }
    lines.push(`${INDENT}${INDENT}pytest.fail(${toPythonString(failureMessage)})`);
  }

  for (const method of declaration.mustHaveMethods) {
    lines.push(`${INDENT}if not stele_has_callable(cls, ${toPythonString(method)}):`);
    lines.push(
      `${INDENT}${INDENT}pytest.fail(${toPythonString(`class-shape ${declaration.id}: method ${JSON.stringify(method)} missing or not callable on ${qualified}`)})`,
    );
  }

  for (const base of declaration.mustExtend) {
    const baseExpr = `getattr(cls_base, "__name__", None) == ${toPythonString(base)} or getattr(cls_base, "__qualname__", "").endswith(${toPythonString(`.${base}`)})`;
    lines.push(`${INDENT}if not any(${baseExpr} for cls_base in getattr(cls, "__mro__", [cls])[1:]):`);
    lines.push(
      `${INDENT}${INDENT}pytest.fail(${toPythonString(`class-shape ${declaration.id}: ${qualified} must extend ${base}`)})`,
    );
  }

  return lines;
}

function renderFunctionShapeBody(declaration: FunctionShapeDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  if (target.selectorName === undefined || target.selectorName === "") {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Function shape "${declaration.id}" must specify a function name after "::" (e.g. "app/totals.py::calculate_total").`,
      declaration.span,
      "The Python backend resolves a single function via importlib; a glob target alone is ambiguous.",
      `Add a function name to the target.`,
    );
  }
  const modulePath = fileToModulePath(declaration, target.pathPattern);
  // Function selectors may be dotted (e.g. ClassName.method); peel the last
  // segment as the symbol and append intermediate segments to the module
  // path so importlib can still resolve the immediate parent.
  const selectorParts = target.selectorName.split(".");
  const symbolName = selectorParts.pop()!;
  const owningModule = selectorParts.length === 0 ? modulePath : `${modulePath}.${selectorParts.join(".")}`;
  const qualified = `${owningModule}.${symbolName}`;
  const lines: string[] = [];
  lines.push(`${INDENT}fn = stele_resolve_function(${toPythonString(qualified)})`);

  if (declaration.mustHaveParameters.length > 0) {
    lines.push(`${INDENT}signature = inspect.signature(fn)`);
    lines.push(`${INDENT}actual_parameters = list(signature.parameters.keys())`);
    for (const parameter of declaration.mustHaveParameters) {
      const snake = kebabToSnake(parameter);
      lines.push(`${INDENT}if ${toPythonString(snake)} not in actual_parameters:`);
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`function-shape ${declaration.id}: missing parameter ${snake} on ${qualified}`)})`,
      );
    }
  }

  if (declaration.mustHaveDecorators.length > 0) {
    lines.push(`${INDENT}fn_decorators = list(getattr(fn, "__stele_decorators__", []))`);
    lines.push(`${INDENT}fn_wraps = getattr(fn, "__wrapped__", None)`);
    lines.push(`${INDENT}if fn_wraps is not None:`);
    lines.push(`${INDENT}${INDENT}fn_decorators.append(getattr(fn_wraps, "__name__", ""))`);
    for (const decorator of declaration.mustHaveDecorators) {
      const snake = kebabToSnake(decorator);
      lines.push(
        `${INDENT}if not any(name == ${toPythonString(snake)} or name.endswith(${toPythonString(`.${snake}`)}) for name in fn_decorators):`,
      );
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`function-shape ${declaration.id}: decorator ${snake} not detectable on ${qualified} (runtime cannot inspect source decorators reliably; see stele check for AST-based verification)`)})`,
      );
    }
  }

  if (declaration.mustHaveCalls.length > 0) {
    // Runtime introspection of internal calls is not reliable across
    // CPython versions; emit a comment so the test still runs but defers to
    // `stele check` (which reads source via AST) for full enforcement.
    lines.push(
      `${INDENT}# must-have-call rules are enforced by AST analysis in 'stele check';`,
    );
    lines.push(
      `${INDENT}# the runtime test below only verifies the function exists and is callable.`,
    );
  }

  // Optional return-type check via typing.get_type_hints
  lines.push(`${INDENT}return_hints = stele_get_type_hints(fn)`);
  lines.push(`${INDENT}if "return" in return_hints:`);
  lines.push(`${INDENT}${INDENT}# Return type recorded for downstream type-policy checks; no assertion here.`);
  lines.push(`${INDENT}${INDENT}pass`);
  return lines;
}

function renderBoundaryBody(declaration: BoundaryDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];
  const allowedExpr = renderPythonStringList(declaration.allowTargets);
  const deniedExpr = renderPythonStringList(declaration.denyImports);
  lines.push(`${INDENT}matched = stele_glob(${toPythonString(target.pathPattern)})`);
  lines.push(`${INDENT}allowed_targets = ${allowedExpr}`);
  lines.push(`${INDENT}denied_imports = ${deniedExpr}`);
  lines.push(`${INDENT}for filepath in matched:`);
  lines.push(`${INDENT}${INDENT}if any(stele_import_allowed(filepath, allowed=[pattern]) for pattern in allowed_targets):`);
  lines.push(`${INDENT}${INDENT}${INDENT}continue`);
  lines.push(`${INDENT}${INDENT}imports = stele_collect_imports(filepath)`);
  lines.push(`${INDENT}${INDENT}for imp in imports:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if not stele_import_allowed(imp, allowed=[], forbidden=denied_imports):`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`boundary ${declaration.id}: forbidden import `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ repr(imp) + ${toPythonString(" in ")} + repr(filepath)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

function renderTypePolicyBody(declaration: TypePolicyDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];

  if (target.selectorName !== undefined && target.selectorName !== "") {
    const modulePath = fileToModulePath(declaration, target.pathPattern);
    const qualified = `${modulePath}.${target.selectorName}`;
    lines.push(`${INDENT}cls = stele_resolve_class(${toPythonString(qualified)})`);
    lines.push(`${INDENT}fields = stele_get_class_fields(cls)`);

    for (const requiredType of declaration.requireTypes) {
      lines.push(`${INDENT}if not any(stele_type_matches(field_type, ${toPythonString(requiredType)}) for field_type in fields.values()):`);
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`type-policy ${declaration.id}: ${qualified} has no field of type ${requiredType}`)})`,
      );
    }
    for (const denied of declaration.denyTypes) {
      lines.push(`${INDENT}for field_name, field_type in fields.items():`);
      lines.push(`${INDENT}${INDENT}if stele_type_matches(field_type, ${toPythonString(denied)}):`);
      lines.push(`${INDENT}${INDENT}${INDENT}message = (`);
      lines.push(
        `${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: ${qualified} field `)}`,
      );
      lines.push(
        `${INDENT}${INDENT}${INDENT}${INDENT}+ str(field_name) + ${toPythonString(` uses denied type ${denied}`)}`,
      );
      lines.push(`${INDENT}${INDENT}${INDENT})`);
      lines.push(`${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
    }
    return lines;
  }

  // No class selector — iterate over all matched .py files and grep their
  // module-level type annotations as plain text. This stays true to v0.2's
  // "best-effort runtime check; AST analysis lives in stele check" stance.
  lines.push(`${INDENT}required_names = ${renderPythonStringList(declaration.requireTypes)}`);
  lines.push(`${INDENT}denied_names = ${renderPythonStringList(declaration.denyTypes)}`);
  lines.push(`${INDENT}seen_required = {name: False for name in required_names}`);
  lines.push(`${INDENT}for filepath in stele_glob(${toPythonString(target.pathPattern)}):`);
  lines.push(`${INDENT}${INDENT}text = stele_read_file(filepath)`);
  lines.push(`${INDENT}${INDENT}for name in required_names:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if name in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}seen_required[name] = True`);
  lines.push(`${INDENT}${INDENT}for name in denied_names:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if name in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" uses denied type ")} + str(name)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  lines.push(`${INDENT}for name, was_seen in seen_required.items():`);
  lines.push(`${INDENT}${INDENT}if not was_seen:`);
  lines.push(`${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: required type `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}+ str(name) + ${toPythonString(" not found in matched files")}`);
  lines.push(`${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

function renderFilePolicyBody(declaration: FilePolicyDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];
  lines.push(`${INDENT}required_substrings = ${renderPythonStringList(declaration.mustContain)}`);
  lines.push(`${INDENT}required_endings = ${renderPythonStringList(declaration.mustEndWith)}`);
  lines.push(`${INDENT}for filepath in stele_glob(${toPythonString(target.pathPattern)}):`);
  lines.push(`${INDENT}${INDENT}text = stele_read_file(filepath)`);
  lines.push(`${INDENT}${INDENT}for needle in required_substrings:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if needle not in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`file-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" missing required substring ")} + repr(needle)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  lines.push(`${INDENT}${INDENT}for ending in required_endings:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if not text.endswith(ending):`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`file-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" does not end with ")} + repr(ending)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

function renderPythonStringList(values: readonly string[]): string {
  if (values.length === 0) {
    return "[]";
  }
  return `[${values.map((value) => toPythonString(value)).join(", ")}]`;
}

function kebabToSnake(name: string): string {
  return name.replaceAll("-", "_");
}
