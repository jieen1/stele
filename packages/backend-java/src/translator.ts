import {
  SteleError,
  stableStringCompare,
  type AstNode,
  type Contract,
  type InvariantDeclaration,
  type ListNode,
  type ScenarioDeclaration,
  type ScenarioOperation,
} from "@stele/core";
import { arithmeticOperatorHandlers } from "./templates/arithmetic.js";
import { collectionOperatorHandlers } from "./templates/collection.js";
import { comparisonOperatorHandlers } from "./templates/comparison.js";
import { logicOperatorHandlers, wrapForLogical } from "./templates/logic.js";
import { stringOperatorHandlers } from "./templates/string.js";
import { temporalOperatorHandlers } from "./templates/temporal.js";

// INDENT constant removed (was unused)

/**
 * Reserved-word set used by `sanitizeJavaIdentifier`.
 * Includes Java keywords plus contextual identifiers we never want to collide with.
 */
const JAVA_RESERVED_WORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "default", "do", "double", "else", "enum", "extends", "false",
  "final", "finally", "float", "for", "goto", "if", "implements", "import", "instanceof",
  "int", "interface", "long", "native", "new", "null", "package", "private", "protected",
  "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized",
  "this", "throw", "throws", "transient", "true", "try", "var", "void", "volatile", "while",
  "yield", "record", "sealed", "permits", "ctx", "runtime", "SteleRuntime", "SteleConftest",
]);

export type TranslationContext = {
  /** Variable bindings introduced by quantifiers; empty at the top level. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Identifier representing the root context inside generated test methods. */
  readonly rootContextName: string;
  /** Symbols that have already been generated and must not be reused. */
  readonly usedNames: ReadonlySet<string>;
  /** Allocate a binding for a CDL identifier; returns the next context. */
  bind(identifier: string): { name: string; context: TranslationContext };
  /** Resolve a CDL identifier to its generated name, or `undefined`. */
  resolve(identifier: string): string | undefined;
};

type ExpressionTranslator = (node: AstNode, context: TranslationContext) => string;
type OperatorHandler = (node: ListNode, context: TranslationContext, translate: ExpressionTranslator) => string;

const OPERATOR_HANDLERS: Record<string, OperatorHandler> = {
  path: translatePath,
  collection: translateCollection,
  value: translateValue,
  field: translateField,
  ...comparisonOperatorHandlers,
  ...arithmeticOperatorHandlers,
  ...collectionOperatorHandlers,
  ...logicOperatorHandlers,
  ...stringOperatorHandlers,
  ...temporalOperatorHandlers,
  // Control flow operators
  when: translateWhen,
  if: translateIf,
  implies: translateImplies,
  iff: translateIff,
  "not-null": translateNotNull,
  between: translateBetween,
  "approx-eq": translateApproxEq,
  // Quantifiers
  forall: (node, context, translate) => translateQuantifier(node, context, translate, "forall", "steleForall"),
  exists: (node, context, translate) => translateQuantifier(node, context, translate, "exists", "steleExists"),
  where: (node, context, translate) => translateQuantifier(node, context, translate, "where", "steleWhere"),
  none: (node, context, translate) => translateQuantifier(node, context, translate, "none", "steleNone"),
  // EP04 batch 1: filter is a strict alias of where.
  filter: (node, context, translate) => translateQuantifier(node, context, translate, "where", "steleWhere"),
  // EP04: data access
  "type-of": (node, context, translate) => translateUnaryOp(node, context, translate, "type-of", "steleTypeOf"),
  // "in" operator (alias for exists-in)
  "in": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "in" expects exactly two operands.',
        node.span, `Found ${node.items.length} operand(s).`, "Pass a value and a collection.");
    }
    const value = translate(node.items[0]!, context);
    const container = translate(node.items[1]!, context);
    return `SteleRuntime.steleExistsIn(${value}, ${container})`;
  },
};

/**
 * Generate a JUnit 5 test source file for a contract slice.
 *
 * Emits one `public class <className>` with one `@Test void test_<id>()`
 * per invariant. Each invariant translates its `(assert ...)` expression and
 * wraps it in `assertTrue(...)`. Phase C adds support for `(when ...)` guards,
 * `(uses-checker ...)`, and `(uses-scenario ...)`.
 *
 * @param contract - The contract (or group slice) to translate.
 * @param className - The Java class name. Must match the output filename.
 * @param groupName - Optional group name rendered as a JavaDoc comment.
 */
export function generateJUnitSource(
  contract: Contract,
  className: string = "Test_contract",
  groupName?: string,
): string {
  const invariants = contract.invariants.slice().sort(compareInvariants);
  const scenariosById = new Map<string, ScenarioDeclaration>(
    contract.scenarios.map((scenario: ScenarioDeclaration) => [scenario.id, scenario] as const),
  );
  const usedTestNames = new Set<string>();
  const lines: string[] = [];

  lines.push("package contract;");
  lines.push("");
  lines.push("import org.junit.jupiter.api.Test;");
  lines.push("import static contract.SteleRuntime.*;");
  lines.push("import static contract.SteleRuntime.CheckerFunction;");
  lines.push("import static contract.SteleRuntime.CheckerResult;");
  lines.push("import static org.junit.jupiter.api.Assertions.*;");
  lines.push("import java.util.*;");
  lines.push("");
  if (groupName) {
    lines.push(`/** Tests for group: ${groupName} */`);
  }
  lines.push(`class ${className} {`);
  lines.push("");
  lines.push("    private final Map<String, Object> ctx = SteleConftest.steleContext();");
  lines.push("");

  if (invariants.length === 0) {
    lines.push("    @Test");
    lines.push("    void test_empty_contract() {");
    lines.push("        // intentionally empty");
    lines.push("    }");
  }

  for (const invariant of invariants) {
    lines.push("");
    const testName = allocateUniqueName(sanitizeJavaIdentifier(invariant.id, "test"), usedTestNames);
    usedTestNames.add(testName);
    lines.push(...renderInvariantTest(invariant, testName, scenariosById));
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Translate one CDL expression to its Java equivalent string.
 */
export function translateExpression(node: AstNode, context: TranslationContext = createTranslationContext()): string {
  return translateNode(node, context);
}

/**
 * Sanitize a CDL identifier so it can be reused as a Java identifier.
 * Converts kebab-case to camelCase.
 */
export function sanitizeJavaIdentifier(identifier: string, fallbackPrefix = "value"): string {
  // kebab -> camelCase
  let cleaned = identifier.replace(/-([a-z])/g, (_match, c) => c.toUpperCase());
  // Remove non-identifier chars not allowed in Java identifiers
  cleaned = cleaned.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withFallback = cleaned.length === 0 ? fallbackPrefix : cleaned;
  return /^[0-9]/.test(withFallback) ? `${fallbackPrefix}_${withFallback}` : withFallback;
}

function renderInvariantTest(
  invariant: InvariantDeclaration,
  testName: string,
  scenariosById: ReadonlyMap<string, ScenarioDeclaration>,
): string[] {
  const usesScenario = invariant.usesScenario !== undefined;
  const usesChecker = invariant.usesChecker !== undefined;

  if (!usesChecker && invariant.assertExpression === undefined) {
    throw new SteleError("E0601", "Backend Error",
      `Invariant "${invariant.id}" lacks an assert expression and is not a checker invariant.`,
      invariant.span, "Every invariant must contain either an (assert ...) clause or a (uses-checker ...) form.",
      "Add an (assert ...) clause or wire up a checker.");
  }

  const assertionContextName = usesScenario ? "steleAssertContext" : "ctx";
  const expressionContext = createTranslationContext(undefined, undefined, assertionContextName);
  const lines = [`    @Test`, `    void ${testName}() {`];

  if (usesScenario) {
    const scenarioId = invariant.usesScenario!.scenarioId;
    const scenario = scenariosById.get(scenarioId);
    if (scenario === undefined) {
      throw new SteleError("E0605", "Backend Error",
        `Invariant "${invariant.id}" references an unknown scenario "${scenarioId}".`,
        invariant.usesScenario!.span, "Scenario references should have been validated by @stele/core before backend generation.",
        "Fix the contract or re-run generation after scenario validation passes.");
    }
    const scenarioLiteral = renderScenarioLiteral(scenario);
    lines.push(`        Map<String, Object> steleScenarioDef = ${scenarioLiteral};`);
    lines.push(`        Map<String, Object> steleScenarioContext = SteleRuntime.steleRunScenario(steleScenarioDef, ctx);`);
    lines.push(`        Map<String, Object> steleAssertContext = SteleRuntime.steleMergeContexts(ctx, steleScenarioContext);`);
  }

  if (invariant.whenExpression !== undefined) {
    const guard = wrapForLogical(translateExpression(invariant.whenExpression, expressionContext));
    lines.push(`        if (!${guard}) {`);
    lines.push(`            return;`);
    lines.push(`        }`);
  }

  if (usesChecker) {
    const checker = invariant.usesChecker!;
    const argsLiteral = renderCheckerArgs(checker.args, expressionContext);
    lines.push(`        CheckerResult steleCheckerResult = SteleRuntime.steleCallChecker(`);
    lines.push(`            ctx, "${checker.checkerId}", ${argsLiteral});`);
    lines.push(`        assertTrue(steleCheckerResult.ok,`);
    lines.push(`            steleCheckerResult.message != null ? steleCheckerResult.message : "Checker failed: ${checker.checkerId}");`);
    lines.push(`    }`);
    return lines;
  }

  const translated = translateExpression(invariant.assertExpression!, expressionContext);
  lines.push(`        assertTrue(${translated});`);
  lines.push(`    }`);
  return lines;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderCheckerArgs(args: readonly AstNode[], _context: TranslationContext): string {
  if (args.length === 0) {
    return "Collections.emptyList()";
  }
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.kind !== "list" || arg.items.length < 2) continue;
    if (arg.items[0]?.kind !== "identifier") continue;
    const key = arg.items[0].value;
    const valueNode = arg.items[1];
    if (valueNode === undefined) continue;
    parts.push(`"${key}"`);
  }
  return parts.length > 0 ? `Arrays.asList(${parts.join(", ")})` : "Collections.emptyList()";
}

function renderScenarioLiteral(scenario: ScenarioDeclaration): string {
  const map = serializeScenario(scenario);
  return renderJavaMap(map);
}

function serializeScenario(scenario: ScenarioDeclaration): Record<string, unknown> {
  return {
    id: scenario.id,
    executor: scenario.executor,
    sandbox: scenario.sandbox,
    steps: scenario.steps.map(serializeScenarioOperation),
  };
}

function serializeScenarioOperation(step: ScenarioOperation): Record<string, unknown> {
  if (step.kind === "step") {
    return { kind: step.kind, id: step.id, capture: step.capture, call: serializeScenarioCall(step.call.target, step.call.body) };
  }
  return { kind: step.kind, capture: step.capture, call: serializeScenarioCall(step.call.target, step.call.body) };
}

function serializeScenarioCall(target: string, body: AstNode | undefined): Record<string, unknown> {
  return { target, ...(body === undefined ? {} : { body: serializeScenarioValue(body) }) };
}

function serializeScenarioValue(node: AstNode): unknown {
  if (node.kind === "number") return node.value;
  if (node.kind === "string") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  if (node.kind === "identifier") {
    switch (node.value) {
      case "true": return true;
      case "false": return false;
      case "null": case "none": return null;
      default:
        throw new SteleError("E0606", "Backend Error", `Unsupported bare identifier "${node.value}" in scenario body.`,
          node.span, "Scenario bodies support object, ref, gen, booleans, and null.", "Wrap the value in a supported form.");
    }
  }
  if (node.head === "object") return Object.fromEntries(node.items.map(serializeScenarioObjectField));
  if (node.head === "ref") return { $ref: serializeScenarioRef(node) };
  if (node.head === "gen") return { $gen: serializeScenarioGenerator(node) };
  throw new SteleError("E0606", "Backend Error", `Unsupported scenario body operator "${node.head}".`,
    node.span, "Java scenario bodies support object, ref, and gen forms.", "Rewrite using supported expressions.");
}

function serializeScenarioObjectField(node: AstNode): [string, unknown] {
  if (node.kind !== "list") throw new SteleError("E0606", "Backend Error", "Scenario object fields must be list entries.", node.span, "Each field should look like (key expr).", "Rewrite as a single-field list.");
  if (node.items.length !== 1) throw new SteleError("E0606", "Backend Error",
    `Scenario object field "${node.head}" expects exactly one value.`, node.span, `Found ${node.items.length} value(s).`, "Keep a single value per key.");
  return [node.head, serializeScenarioValue(node.items[0]!)];
}

function serializeScenarioRef(node: ListNode): string[] {
  const [captureNode, ...fieldNodes] = node.items;
  if (captureNode?.kind !== "identifier") throw new SteleError("E0606", "Backend Error", "Scenario ref must start with a captured identifier.",
    captureNode?.span ?? node.span, `Found ${captureNode === undefined ? "nothing" : captureNode.kind}.`, "Use (ref fund id).");
  return [captureNode.value, ...fieldNodes.map((n: AstNode) => n.kind === "identifier" ? n.value : n.kind === "keyword" ? `:${n.value}` : n.kind === "number" ? String(n.value) : n.kind === "string" ? n.value : String(n.head))];
}

function serializeScenarioGenerator(node: ListNode): Record<string, unknown> {
  const [kindNode, prefixNode] = node.items;
  if (kindNode?.kind !== "identifier" || kindNode.value !== "unique-name") throw new SteleError("E0606", "Backend Error",
    "Scenario gen currently supports only unique-name.", kindNode?.span ?? node.span, `Found ${kindNode === undefined ? "nothing" : kindNode.kind}.`,
    'Use (gen unique-name "fund").');
  if (prefixNode?.kind !== "string" || node.items.length !== 2) throw new SteleError("E0606", "Backend Error",
    "Scenario gen unique-name expects exactly one string prefix.", prefixNode?.span ?? node.span,
    `Found ${node.items.length - 1} argument(s).`, 'Use (gen unique-name "fund").');
  return { kind: "unique-name", prefix: prefixNode.value };
}

function renderJavaMap(value: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("new LinkedHashMap<String, Object>() {{");
  for (const [key, val] of Object.entries(value)) {
    lines.push(`    put("${escapeJavaString(key)}", ${renderJavaValue(val, 1)});`);
  }
  lines.push("}}");
  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderJavaValue(value: unknown, _indent: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isInteger(value) ? `${value}L` : `${value}d`;
  }
  if (typeof value === "string") return `"${escapeJavaString(value)}"`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "Collections.emptyList()";
    return `Arrays.asList(${value.map((v) => renderJavaValue(v, 0)).join(", ")})`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "Collections.emptyMap()";
    return renderJavaMap(Object.fromEntries(entries));
  }
  return "null";
}

function escapeJavaString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function translateNode(node: AstNode, context: TranslationContext): string {
  if (node.kind === "number") return node.raw;
  if (node.kind === "string") return `"${escapeJavaString(node.value)}"`;
  if (node.kind === "keyword") return `"${escapeJavaString(":" + node.value)}"`;
  if (node.kind === "identifier") {
    const binding = context.resolve(node.value);
    if (binding !== undefined) return binding;
    switch (node.value) {
      case "true": return "true";
      case "false": return "false";
      case "null": case "none": return "null";
      default:
        throw new SteleError("E0602", "Backend Error",
          `Unsupported bare identifier "${node.value}" in Java backend expression.`,
          node.span, "Only bound variables, booleans, null-like symbols, and operator forms translate directly to Java.",
          "Wrap the value in a supported operator such as path, collection, or value.");
    }
  }

  const handler = OPERATOR_HANDLERS[node.head];
  if (handler === undefined) {
    throw new SteleError("E0601", "Backend Error",
      `Unsupported Java backend operator "${node.head}".`,
      node.span, "@stele/backend-java implements all core operators.",
      "Use a supported operator or extend the backend translator.");
  }
  return handler(node, context, translateNode);
}

function translatePath(node: ListNode, context: TranslationContext): string {
  if (node.items.length === 0) {
    throw new SteleError("E0603", "Backend Error", 'Operator "path" requires at least one segment.',
      node.span, "A path expression needs one or more symbol segments.", "Use a form like (path account cash).");
  }

  const [root, ...rest] = node.items;
  if (root?.kind !== "identifier" && root?.kind !== "keyword") {
    throw new SteleError("E0603", "Backend Error", 'Operator "path" expects symbol-like path segments.',
      root?.span ?? node.span, `Found ${root?.kind ?? "nothing"} where the root path segment should be.`,
      "Use identifiers or keywords for path parts.");
  }

  const rootKey = root.kind === "keyword" ? `:${root.value}` : root.value;
  const binding = root.kind === "identifier" ? context.resolve(root.value) : undefined;
  const segments = rest.map(readPathPart);

  if (binding !== undefined) {
    return segments.length === 0
      ? binding
      : `SteleRuntime.getAtPath(${binding}, ${formatSegmentArray(segments)})`;
  }
  return `SteleRuntime.getAtPath(${context.rootContextName}, ${formatSegmentArray([rootKey, ...segments])})`;
}

function translateCollection(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects exactly one symbol argument.',
      node.span, `Found ${node.items.length} operand(s).`, "Use a form like (collection transactions).");
  }
  const target = node.items[0]!;
  if (target.kind !== "identifier") {
    throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects an identifier target.',
      target.span, `Found ${target.kind} where the collection name should be.`, "Use a form like (collection transactions).");
  }
  return `SteleRuntime.getAtPath(${context.rootContextName}, new String[]{"${target.value}"})`;
}

function translateValue(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", 'Operator "value" expects exactly one operand.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass a single value, e.g. (value 5).");
  }
  return translate(node.items[0]!, context);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function translateField(node: ListNode, context: TranslationContext, _translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", 'Operator "field" expects a path and a field name.',
      node.span, `Found ${node.items.length} operand(s).`, "Use a form like (field (path account) cash).");
  }
  // Extend the path by one segment
  const pathNode = node.items[0]!;
  const fieldNode = node.items[1]!;
  if (pathNode.kind !== "list" || pathNode.head !== "path") {
    throw new SteleError("E0603", "Backend Error", 'Operator "field" expects its first argument to be a path expression.',
      pathNode.span ?? node.span, "The Java backend extends existing path expressions by appending one field segment.",
      'Use a form like (field (path account) cash).');
  }
  const extendedPath: ListNode = { kind: "list", head: "path", items: [...pathNode.items, fieldNode], span: node.span };
  return translatePath(extendedPath, context);
}

function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  throw new SteleError("E0603", "Backend Error", "Path segments must be identifiers or keywords.",
    node.span, `Found ${node.kind} in a path expression.`, "Replace with a symbol-like path part.");
}

function formatSegmentArray(segments: readonly string[]): string {
  return `new String[]{${segments.map((s) => `"${escapeJavaString(s)}"`).join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Control flow operators
// ---------------------------------------------------------------------------

function translateWhen(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", 'Operator "when" expects exactly two operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass a condition and body, e.g. (when (gt x 0) (lt x 10)).");
  }
  const condition = wrapForLogical(translate(node.items[0]!, context));
  const body = wrapForLogical(translate(node.items[1]!, context));
  return `(!${condition} || ${body})`;
}

function translateIf(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError("E0603", "Backend Error", 'Operator "if" expects exactly three operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass condition, then-branch, and else-branch.");
  }
  const condition = translate(node.items[0]!, context);
  const consequent = translate(node.items[1]!, context);
  const alternate = translate(node.items[2]!, context);
  return `(${condition} ? ${consequent} : ${alternate})`;
}

function translateImplies(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", 'Operator "implies" expects exactly two operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass two booleans, e.g. (implies (eq x 1) (gt y 0)).");
  }
  const left = wrapForLogical(translate(node.items[0]!, context));
  const right = wrapForLogical(translate(node.items[1]!, context));
  return `(!${left} || ${right})`;
}

function translateIff(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", 'Operator "iff" expects exactly two operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass two booleans, e.g. (iff (eq x 1) (eq y 1)).");
  }
  const left = wrapForLogical(translate(node.items[0]!, context));
  const right = wrapForLogical(translate(node.items[1]!, context));
  return `(${left} == ${right})`;
}

function translateNotNull(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", 'Operator "not-null" expects exactly one operand.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass a single path, e.g. (not-null (path account email)).");
  }
  return `SteleRuntime.steleNotNull(${translate(node.items[0]!, context)})`;
}

function translateBetween(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError("E0603", "Backend Error", 'Operator "between" expects exactly three operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass value, low, and high, e.g. (between x 0 10).");
  }
  return `SteleRuntime.steleBetween(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)}, ${translate(node.items[2]!, context)})`;
}

function translateApproxEq(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError("E0603", "Backend Error", 'Operator "approx-eq" expects exactly three operands.',
      node.span, `Found ${node.items.length} operand(s).`, "Pass two values and a tolerance, e.g. (approx-eq a b 1e-6).");
  }
  return `SteleRuntime.steleApproxEq(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)}, ${translate(node.items[2]!, context)})`;
}

function translateUnaryOp(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", `Operator "${operatorName}" expects exactly one operand.`,
      node.span, `Found ${node.items.length} operand(s).`, `Pass a single value, e.g. (${operatorName} (path foo)).`);
  }
  return `SteleRuntime.${helper}(${translate(node.items[0]!, context)})`;
}

// ---------------------------------------------------------------------------
// Quantifiers (forall / exists / where / none)
// ---------------------------------------------------------------------------

function translateQuantifier(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 3) {
    throw new SteleError("E0603", "Backend Error",
      `Quantifier "${operatorName}" expects exactly three operands: (binding collection predicate).`,
      node.span, `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} item (collection items) (gt (path item value) 0)).`);
  }
  const binding = node.items[0]!;
  if (binding.kind !== "identifier") {
    throw new SteleError("E0603", "Backend Error", `Quantifier "${operatorName}" must bind an identifier.`,
      node.span, "The first quantifier argument names the element available inside the predicate body.",
      `Use a form like (${operatorName} item (collection items) ...).`);
  }
  const bound = context.bind(binding.value);
  const collection = translate(node.items[1]!, context);
  const predicateBody = translate(node.items[2]!, bound.context);
  const predicateSource = astToSource(node.items[2]!);
  return `SteleRuntime.${helper}(${collection}, ${bound.name} -> ${wrapForLogical(predicateBody)}, "${escapeJavaString(predicateSource)}")`;
}

/**
 * Render an AST node back to a CDL-shaped source string for predicate_source.
 */
export function astToSource(node: AstNode): string {
  if (node.kind === "number") return node.raw;
  if (node.kind === "string") return JSON.stringify(node.value);
  if (node.kind === "keyword") return `:${node.value}`;
  if (node.kind === "identifier") return node.value;
  const parts = [node.head, ...node.items.map((item: AstNode) => astToSource(item))];
  return `(${parts.join(" ")})`;
}

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    stableStringCompare(left.filePath, right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    stableStringCompare(left.id, right.id)
  );
}

// ---------------------------------------------------------------------------
// Translation context helpers
// ---------------------------------------------------------------------------

function createTranslationContext(
  bindings: ReadonlyMap<string, string> = new Map(),
  usedNames: ReadonlySet<string> = new Set(),
  rootContextName: string = "ctx",
): TranslationContext {
  return {
    bindings,
    rootContextName,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniqueName(sanitizeJavaIdentifier(identifier, "item"), usedNames);
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

function allocateUniqueName(baseName: string, usedNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate) || JAVA_RESERVED_WORDS.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}
