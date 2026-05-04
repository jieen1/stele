import { SteleError, type AstNode, type Contract, type InvariantDeclaration, type ListNode } from "@stele/core";
import { getPythonRuntimeSource, PYTEST_RUNTIME_PATH } from "./runtime.js";
import { arithmeticOperatorHandlers } from "./templates/arithmetic.js";
import { collectionOperatorHandlers } from "./templates/collection.js";
import { comparisonOperatorHandlers } from "./templates/comparison.js";
import { logicOperatorHandlers } from "./templates/logic.js";
import { temporalOperatorHandlers } from "./templates/temporal.js";

export const PYTEST_PACKAGE_INIT_PATH = "tests/contract/__init__.py";
export const PYTEST_TEST_PATH = "tests/contract/test_contract.py";

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
  readonly usedNames: ReadonlySet<string>;
  bind(identifier: string): { name: string; context: TranslationContext };
  resolve(identifier: string): string | undefined;
};

const INDENT = "    ";
const PYTEST_IMPORT_LINE = "from ._stele_runtime import stele_call_checker, stele_get_path, stele_sum";
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
  ...arithmeticOperatorHandlers,
  ...collectionOperatorHandlers,
  ...logicOperatorHandlers,
  ...temporalOperatorHandlers,
};

export function generatePytestFiles(contract: Contract): GeneratedPytestFile[] {
  return [
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
}

export function generatePytestSource(contract: Contract): string {
  const lines = [PYTEST_IMPORT_LINE, "", ""];
  const invariants = contract.invariants.slice().sort(compareInvariants);
  const usedTestNames = new Set<string>();

  invariants.forEach((invariant, index) => {
    const testName = allocateUniquePythonName(`test_${sanitizePythonIdentifier(invariant.id, "invariant")}`, usedTestNames);
    usedTestNames.add(testName);
    lines.push(...renderInvariantTest(invariant, testName));
    lines.push(index === invariants.length - 1 ? "" : "");

    if (index !== invariants.length - 1) {
      lines.push("");
    }
  });

  return `${lines.join("\n")}`;
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

function renderInvariantTest(invariant: InvariantDeclaration, testName: string): string[] {
  const lines = [`def ${testName}(stele_context):`];

  if (invariant.whenExpression !== undefined) {
    lines.push(`${INDENT}if not (${translateExpression(invariant.whenExpression)}):`);
    lines.push(`${INDENT}${INDENT}return`);
  }

  if (invariant.usesChecker !== undefined) {
    if (invariant.usesChecker.args.length > 0) {
      throw new SteleError(
        "E0604",
        "Backend Error",
        `Invariant "${invariant.id}" uses-checker arguments are not supported by the Python backend yet.`,
        invariant.usesChecker.span,
        `Received ${invariant.usesChecker.args.length} checker argument(s).`,
        "Remove the checker arguments for v0.1 or extend the backend argument encoder first.",
      );
    }

    lines.push(
      `${INDENT}result = stele_call_checker(${toPythonString(invariant.usesChecker.checkerId)}, stele_context, {})`,
    );
    lines.push(
      `${INDENT}assert result["passed"], result.get("message") or ${toPythonString(`Checker failed: ${invariant.usesChecker.checkerId}`)}`,
    );
    return lines;
  }

  lines.push(...renderAssertionLines(invariant.assertExpression!));
  return lines;
}

function renderAssertionLines(node: AstNode): string[] {
  if (node.kind === "list" && node.head === "eq" && node.items.length === 2 && isMultilineArithmetic(node.items[1])) {
    return [
      `${INDENT}assert ${translateExpression(node.items[0]!)} == (`,
      ...renderArithmeticExpressionLines(node.items[1] as ListNode, 2),
      `${INDENT})`,
    ];
  }

  if (node.kind === "list" && node.head === "forall" && node.items.length === 3) {
    return renderForallAssertionLines(node);
  }

  return [`${INDENT}assert ${translateExpression(node)}`];
}

function renderForallAssertionLines(node: ListNode): string[] {
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

  const context = createTranslationContext();
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

function renderArithmeticExpressionLines(node: ListNode, indentLevel: number): string[] {
  const symbol = arithmeticSymbol(node.head);
  const prefix = INDENT.repeat(indentLevel);

  return node.items.map((item, index) => `${prefix}${index === 0 ? "" : `${symbol} `}${translateExpression(item)}`);
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
    return `stele_get_path(stele_context, ${JSON.stringify([rootKey])})`;
  }

  return `stele_get_path(stele_context[${toPythonString(rootKey)}], ${JSON.stringify(pathParts)})`;
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

function createTranslationContext(
  bindings = new Map<string, string>(),
  usedNames = new Set<string>(),
): TranslationContext {
  return {
    bindings,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniquePythonName(sanitizePythonIdentifier(identifier, "item"), usedNames);
      const nextBindings = new Map(bindings);
      const nextUsedNames = new Set(usedNames);
      nextBindings.set(identifier, name);
      nextUsedNames.add(name);
      return {
        name,
        context: createTranslationContext(nextBindings, nextUsedNames),
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
