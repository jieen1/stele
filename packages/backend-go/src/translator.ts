import {
  SteleError,
  type AstNode,
  type Contract,
  type InvariantDeclaration,
  type ListNode,
  type ScenarioDeclaration,
  type ScenarioOperation,
} from "@stele/core";
import { isComparisonOp, emitComparison } from "./templates/comparison.js";
import { emitAnd, emitOr, emitNot, emitImplies, emitIff, emitWhen } from "./templates/logic.js";
import {
  isAggregateOp,
  emitAggregate,
  isQuantifierOp,
  emitQuantifier,
} from "./templates/collection.js";
import {
  isBinaryArithOp,
  emitBinaryArith,
  isVariadicArithOp,
  emitUnaryArith,
  emitRound,
} from "./templates/arithmetic.js";
import { isStringOp, emitStringBinary, emitStringUnary } from "./templates/string.js";
import { emitTemporalBinary, emitStateBefore, emitStateAfter, emitModified } from "./templates/temporal.js";

const INDENT = "\t";

/**
 * Reserved Go identifiers that must not be used as generated symbols.
 */
const GO_RESERVED_WORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "struct", "switch", "type", "var",
  "true", "false", "nil", "iota",
  // Contextual identifiers we avoid colliding with.
  "t", "ctx", "globalCtx", "err", "ok",
  "NewContext", "SetupSteleContext", "TestMain",
]);

/**
 * Import allowlist for generated Go code. Matches design doc §10.4.
 */
export const STELE_ALLOWED_IMPORTS = new Set([
  "encoding/json", "fmt", "math", "os", "reflect", "regexp", "sort",
  "strconv", "strings", "sync", "testing", "time", "path/filepath",
]);

/**
 * Translation context carries variable bindings and used names.
 */
export type TranslationContext = {
  readonly bindings: ReadonlyMap<string, string>;
  readonly rootContextName: string;
  readonly usedNames: ReadonlySet<string>;
  bind(identifier: string): { name: string; context: TranslationContext };
  resolve(identifier: string): string | undefined;
};

type ExpressionTranslator = (node: AstNode, context: TranslationContext) => string;

/**
 * Generate a Go test file source for a contract slice.
 *
 * Emits one `func Test...` per invariant. Each invariant translates its
 * (assert ...) expression and wraps it in `steleAssertTrue(t, ..., msg)`.
 */
export function generateGoTestSource(contract: Contract): string {
  const lines: string[] = [];
  const usedTestNames = new Set<string>();
  const invariants = contract.invariants.slice().sort(compareInvariants);
  const scenariosById = new Map(contract.scenarios.map((s) => [s.id, s] as const));

  lines.push("package contract_test");
  lines.push("");
  lines.push("import (");
  lines.push("\t\"testing\"");
  lines.push(")");
  lines.push("");

  if (invariants.length === 0) {
    lines.push("func TestEmptyContract(t *testing.T) {");
    lines.push("\t// intentionally empty");
    lines.push("}");
  }

  for (const invariant of invariants) {
    lines.push("");
    const testName = allocateUniqueName(
      sanitizeGoIdentifier(invariant.id, "invariant"),
      usedTestNames,
    );
    usedTestNames.add(testName);
    lines.push(...renderInvariantTest(invariant, testName, scenariosById));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Translate one CDL expression to its Go equivalent string.
 */
export function translateExpression(
  node: AstNode,
  context: TranslationContext = createTranslationContext(),
): string {
  return translateNode(node, context);
}

/**
 * Sanitize a CDL identifier so it can be used as a Go identifier.
 */
export function sanitizeGoIdentifier(identifier: string, fallbackPrefix = "value"): string {
  const cleaned = identifier
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withFallback = cleaned.length === 0 ? fallbackPrefix : cleaned;
  return /^[0-9]/.test(withFallback) ? `${fallbackPrefix}_${withFallback}` : withFallback;
}

/**
 * Render a single invariant as a Go test function.
 */
function renderInvariantTest(
  invariant: InvariantDeclaration,
  testName: string,
  scenariosById: ReadonlyMap<string, ScenarioDeclaration>,
): string[] {
  const usesScenario = invariant.usesScenario !== undefined;
  const usesChecker = invariant.usesChecker !== undefined;

  if (!usesChecker && invariant.assertExpression === undefined) {
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Invariant "${invariant.id}" lacks an assert expression and is not a checker invariant.`,
      invariant.span,
      "Every invariant must contain either an (assert ...) clause or a (uses-checker ...) form.",
      "Add an (assert ...) clause or wire up a checker.",
    );
  }

  const assertionContextName = usesScenario ? "steleAssertCtx" : "globalCtx";
  const expressionContext = createTranslationContext(undefined, undefined, assertionContextName);
  const lines = [`func Test${toGoExported(testName)}(t *testing.T) {`];

  if (usesScenario) {
    const scenarioId = invariant.usesScenario!.scenarioId;
    const scenario = scenariosById.get(scenarioId);
    if (scenario === undefined) {
      throw new SteleError(
        "E0605",
        "Backend Error",
        `Invariant "${invariant.id}" references an unknown scenario "${scenarioId}".`,
        invariant.usesScenario!.span,
        "Scenario references should have been validated by @stele/core before backend generation.",
        "Fix the contract or re-run generation after scenario validation passes.",
      );
    }
    const scenarioLiteral = renderScenarioLiteral(scenario);
    lines.push(`\tsteleScenario := []ScenarioStep{${scenarioLiteral}}`);
    lines.push(`\tsteleScenarioCtx, _ := steleRunScenario(steleScenario, globalCtx)`);
    lines.push(`\tsteleAssertCtx := steleMergeContexts(globalCtx, steleScenarioCtx)`);
  }

  if (invariant.whenExpression !== undefined) {
    const guard = translateExpression(invariant.whenExpression, expressionContext);
    lines.push(`\tif !${wrapBool(guard)} {`);
    lines.push(`\t\treturn`);
    lines.push(`\t}`);
  }

  if (usesChecker) {
    const checker = invariant.usesChecker!;
    const argsLiteral = renderCheckerArgs(checker.args, expressionContext);
    lines.push(`\tsteleCheckerResult, err := steleCallChecker("${checker.checkerId}", ${argsLiteral}, ${assertionContextName})`);
    lines.push(`\tif err != nil {`);
    lines.push(`\t\tt.Fatalf("checker error: %%v", err)`);
    lines.push(`\t}`);
    lines.push(`\tsteleAssertTrue(t, steleCheckerResult.Ok, "Checker failed: ${checker.checkerId}")`);
    lines.push(`}`);
    return lines;
  }

  const translated = translateExpression(invariant.assertExpression!, expressionContext);
  lines.push(`\tsteleAssertTrue(t, ${translated}, "Invariant ${invariant.id} violated")`);
  lines.push("}");
  return lines;
}

function renderCheckerArgs(args: readonly AstNode[], context: TranslationContext): string {
  if (args.length === 0) {
    return "[]any{}";
  }
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.kind !== "list") continue;
    if (arg.items.length !== 1) continue;
    parts.push(translateNode(arg.items[0]!, context));
  }
  return `[]any{${parts.join(", ")}}`;
}

function renderScenarioLiteral(scenario: ScenarioDeclaration): string {
  const steps = scenario.steps.map(serializeScenarioStep).join(",\n\t");
  return steps;
}

function serializeScenarioStep(step: ScenarioOperation): string {
  if (step.kind === "step") {
    return `ScenarioStep{Type: "execute", Path: "${step.call.target}"}`;
  }
  return `ScenarioStep{Type: "capture-state", Path: "${step.call.target}"}`;
}

/**
 * Convert a name to Go exported form (capitalize first letter).
 */
function toGoExported(name: string): string {
  if (name.length === 0) return name;
  return name[0]!.toUpperCase() + name.slice(1);
}

/**
 * Translate an AST node to a Go expression string.
 */
function translateNode(node: AstNode, context: TranslationContext): string {
  if (node.kind === "number") {
    return node.raw;
  }
  if (node.kind === "string") {
    return goStringLiteral(node.value);
  }
  if (node.kind === "keyword") {
    return goStringLiteral(`:${node.value}`);
  }
  if (node.kind === "identifier") {
    const binding = context.resolve(node.value);
    if (binding !== undefined) {
      return binding;
    }
    switch (node.value) {
      case "true":
        return "true";
      case "false":
        return "false";
      case "null":
      case "none":
        return "nil";
      default:
        throw new SteleError(
          "E0602",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in Go backend expression.`,
          node.span,
          "Wrap the value in a supported operator such as path or value.",
          "Use a supported operator or wrap in (path ...) or (value ...).",
        );
    }
  }

  const handler = OPERATOR_HANDLERS[node.head];
  if (handler === undefined) {
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Unsupported Go backend operator "${node.head}".`,
      node.span,
      "Use a supported operator.",
      "Check the operator registry for available operators.",
    );
  }
  return handler(node, context, translateNode);
}

/**
 * Map of operator names to handler functions.
 */
const OPERATOR_HANDLERS: Record<string, (node: ListNode, context: TranslationContext, translate: ExpressionTranslator) => string> = {
  path: (node, context, translate) => translatePath(node, context),
  field: (node, context, translate) => translateField(node, context, translate),
  collection: (node, context) => translateCollection(node, context),
  value: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "value" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a single value, e.g. (value 5).");
    }
    return translate(node.items[0]!, context);
  },
  // Comparison operators
  eq: (node, context, translate) => translateComparison(node, context, translate, "eq"),
  neq: (node, context, translate) => translateComparison(node, context, translate, "neq"),
  gt: (node, context, translate) => translateComparison(node, context, translate, "gt"),
  gte: (node, context, translate) => translateComparison(node, context, translate, "gte"),
  lt: (node, context, translate) => translateComparison(node, context, translate, "lt"),
  lte: (node, context, translate) => translateComparison(node, context, translate, "lte"),
  // Logic operators
  and: (node, context, translate) => {
    if (node.items.length === 0) {
      throw new SteleError("E0603", "Backend Error", 'Operator "and" requires at least one operand.', node.span, "An (and) form must wrap one or more predicates.", "Pass at least one predicate.");
    }
    return emitAnd(node.items.map((item) => translate(item, context)));
  },
  or: (node, context, translate) => {
    if (node.items.length === 0) {
      throw new SteleError("E0603", "Backend Error", 'Operator "or" requires at least one operand.', node.span, "An (or) form must wrap one or more predicates.", "Pass at least one predicate.");
    }
    return emitOr(node.items.map((item) => translate(item, context)));
  },
  not: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "not" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a single predicate.");
    }
    return emitNot(translate(node.items[0]!, context));
  },
  // Arithmetic operators
  add: (node, context, translate) => {
    if (node.items.length < 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "add" requires at least two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass at least two operands.");
    }
    return `steleAdd(${node.items.map((i) => translate(i, context)).join(", ")})`;
  },
  mul: (node, context, translate) => {
    if (node.items.length < 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "mul" requires at least two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass at least two operands.");
    }
    return `steleMul(${node.items.map((i) => translate(i, context)).join(", ")})`;
  },
  sub: (node, context, translate) => translateBinaryArith(node, context, translate, "sub", "steleSub"),
  div: (node, context, translate) => translateBinaryArith(node, context, translate, "div", "steleDiv"),
  mod: (node, context, translate) => translateBinaryArith(node, context, translate, "mod", "steleMod"),
  pow: (node, context, translate) => translateBinaryArith(node, context, translate, "pow", "stelePow"),
  neg: (node, context, translate) => translateUnaryArith(node, context, translate, "neg", "steleNeg"),
  abs: (node, context, translate) => translateUnaryArith(node, context, translate, "abs", "steleAbs"),
  ceil: (node, context, translate) => translateUnaryArith(node, context, translate, "ceil", "steleCeil"),
  floor: (node, context, translate) => translateUnaryArith(node, context, translate, "floor", "steleFloor"),
  round: (node, context, translate) => {
    if (node.items.length < 1 || node.items.length > 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "round" expects one number and optionally a digit count.', node.span, `Found ${node.items.length} operand(s).`, "Use (round x) or (round x 2).");
    }
    const value = translate(node.items[0]!, context);
    if (node.items.length === 1) {
      return `steleRound(${value})`;
    }
    return `steleRound(${value}, ${translate(node.items[1]!, context)})`;
  },
  // Aggregate operators
  sum: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "sum", "steleSum"),
  count: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "count" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a single collection.");
    }
    return `steleCount(${translate(node.items[0]!, context)})`;
  },
  avg: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "avg", "steleAvg"),
  min: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "min", "steleMin"),
  max: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "max", "steleMax"),
  distinct: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "distinct", "steleDistinct"),
  unique: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "unique", "steleUnique"),
  // Collection operators
  "has-length": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "has-length" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass a collection and expected length.");
    }
    return `steleHasLength(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
  },
  "is-empty": (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "is-empty" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a collection.");
    }
    return `steleIsEmpty(${translate(node.items[0]!, context)})`;
  },
  "exists-in": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "exists-in" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass a value and container.");
    }
    return `steleExistsIn(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
  },
  // "in" is a semantic alias for "exists-in"
  "in": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "in" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass a value and a collection.");
    }
    return `steleExistsIn(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
  },
  length: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "length" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a collection.");
    }
    return `steleLength(${translate(node.items[0]!, context)})`;
  },
  concat: (node, context, translate) => {
    if (node.items.length < 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "concat" expects at least one collection.', node.span, `Found ${node.items.length} operand(s).`, "Pass one or more collections.");
    }
    return `steleConcat(${node.items.map((i) => translate(i, context)).join(", ")})`;
  },
  // String operators
  contains: (node, context, translate) => translateBinaryRuntime(node, context, translate, "contains", "steleContains"),
  "starts-with": (node, context, translate) => translateBinaryRuntime(node, context, translate, "starts-with", "steleStartsWith"),
  "ends-with": (node, context, translate) => translateBinaryRuntime(node, context, translate, "ends-with", "steleEndsWith"),
  matches: (node, context, translate) => translateBinaryRuntime(node, context, translate, "matches", "steleMatches"),
  trim: (node, context, translate) => translateUnaryRuntime(node, context, translate, "trim", "steleTrim"),
  lower: (node, context, translate) => translateUnaryRuntime(node, context, translate, "lower", "steleLower"),
  upper: (node, context, translate) => translateUnaryRuntime(node, context, translate, "upper", "steleUpper"),
  split: (node, context, translate) => translateBinaryRuntime(node, context, translate, "split", "steleSplit"),
  join: (node, context, translate) => translateBinaryRuntime(node, context, translate, "join", "steleJoin"),
  "json-path": (node, context, translate) => translateBinaryRuntime(node, context, translate, "json-path", "steleJsonPath"),
  // Data access
  "type-of": (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "type-of" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a single value.");
    }
    return `steleTypeOf(${translate(node.items[0]!, context)})`;
  },
  // Control operators
  when: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "when" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass condition and body.");
    }
    return emitWhen(translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  if: (node, context, translate) => {
    if (node.items.length !== 3) {
      throw new SteleError("E0603", "Backend Error", 'Operator "if" expects exactly three operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass condition, then, else.");
    }
    const cond = translate(node.items[0]!, context);
    const then_ = translate(node.items[1]!, context);
    const else_ = translate(node.items[2]!, context);
    return `func() bool { if ${cond} { return ${then_} }; return ${else_} }()`;
  },
  implies: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "implies" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass two booleans.");
    }
    return emitImplies(translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  iff: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "iff" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass two booleans.");
    }
    return emitIff(translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  "not-null": (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "not-null" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a single path.");
    }
    return `steleNotNull(${translate(node.items[0]!, context)})`;
  },
  between: (node, context, translate) => {
    if (node.items.length !== 3) {
      throw new SteleError("E0603", "Backend Error", 'Operator "between" expects exactly three operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass value, low, high.");
    }
    return `steleBetween(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)}, ${translate(node.items[2]!, context)})`;
  },
  "approx-eq": (node, context, translate) => {
    if (node.items.length !== 3) {
      throw new SteleError("E0603", "Backend Error", 'Operator "approx-eq" expects exactly three operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass two values and tolerance.");
    }
    return `steleApproxEq(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)}, ${translate(node.items[2]!, context)})`;
  },
  "decimal-eq": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "decimal-eq" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Pass two values to compare.");
    }
    return `steleDecimalEq(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
  },
  // Quantifiers
  forall: (node, context, translate) => translateQuantifier(node, context, translate, "forall"),
  exists: (node, context, translate) => translateQuantifier(node, context, translate, "exists"),
  where: (node, context, translate) => translateQuantifier(node, context, translate, "where"),
  none: (node, context, translate) => translateQuantifier(node, context, translate, "none"),
  filter: (node, context, translate) => translateQuantifier(node, context, translate, "where"),
  // Temporal
  modified: (node, context) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "modified" expects exactly one (path ...) operand.', node.span, `Found ${node.items.length} operand(s).`, "Use (modified (path account balance)).");
    }
    const segments = readModifiedPath(node.items[0]!, node);
    return emitModified(context.rootContextName, segments);
  },
  "state-before": (node, context) => {
    if (node.items.length !== 0) {
      throw new SteleError("E0603", "Backend Error", 'Operator "state-before" takes no operands.', node.span, `Found ${node.items.length} operand(s).`, "Use (state-before).");
    }
    return emitStateBefore(context.rootContextName);
  },
  "state-after": (node, context) => {
    if (node.items.length !== 0) {
      throw new SteleError("E0603", "Backend Error", 'Operator "state-after" takes no operands.', node.span, `Found ${node.items.length} operand(s).`, "Use (state-after).");
    }
    return emitStateAfter(context.rootContextName);
  },
  within: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "within" expects an event and duration.', node.span, `Found ${node.items.length} operand(s).`, "Use (within event 30).");
    }
    return emitTemporalBinary("within", translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  before: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "before" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Use (before a b).");
    }
    return emitTemporalBinary("before", translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  after: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "after" expects exactly two operands.', node.span, `Found ${node.items.length} operand(s).`, "Use (after a b).");
    }
    return emitTemporalBinary("after", translate(node.items[0]!, context), translate(node.items[1]!, context));
  },
  // EP04: sort-by, sort-by-desc
  "sort-by": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "sort-by" expects collection and (path ...).', node.span, `Found ${node.items.length} operand(s).`, "Use (sort-by (collection items) (path price)).");
    }
    const segments = readProjectionPath(node.items[1]!, "sort-by");
    return `steleSortBy(${translate(node.items[0]!, context)}, ${formatGoStringSlice(segments)})`;
  },
  "sort-by-desc": (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "sort-by-desc" expects collection and (path ...).', node.span, `Found ${node.items.length} operand(s).`, "Use (sort-by-desc (collection items) (path price)).");
    }
    const segments = readProjectionPath(node.items[1]!, "sort-by-desc");
    return `steleSortByDesc(${translate(node.items[0]!, context)}, ${formatGoStringSlice(segments)})`;
  },
  // EP04: map, first, last
  map: (node, context, translate) => {
    if (node.items.length !== 2) {
      throw new SteleError("E0603", "Backend Error", 'Operator "map" expects collection and (path ...).', node.span, `Found ${node.items.length} operand(s).`, "Use (map (collection items) (path price)).");
    }
    const segments = readProjectionPath(node.items[1]!, "map");
    return `steleMap(${translate(node.items[0]!, context)}, ${formatGoStringSlice(segments)})`;
  },
  first: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "first" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a collection.");
    }
    return `steleFirst(${translate(node.items[0]!, context)})`;
  },
  last: (node, context, translate) => {
    if (node.items.length !== 1) {
      throw new SteleError("E0603", "Backend Error", 'Operator "last" expects exactly one operand.', node.span, `Found ${node.items.length} operand(s).`, "Pass a collection.");
    }
    return `steleLast(${translate(node.items[0]!, context)})`;
  },
};

/**
 * Translate `(path root field1 field2 ...)` to Go path access.
 */
function translatePath(node: ListNode, context: TranslationContext): string {
  if (node.items.length === 0) {
    throw new SteleError("E0603", "Backend Error", 'Operator "path" requires at least one segment.', node.span, "A path expression needs one or more symbol segments.", "Use (path account cash).");
  }

  const [root, ...rest] = node.items;
  if (root === undefined || (root.kind !== "identifier" && root.kind !== "keyword")) {
    throw new SteleError("E0603", "Backend Error", 'Operator "path" expects symbol-like segments.', node.span, `Found ${root?.kind ?? "nothing"}.`, "Use identifiers or keywords for path parts.");
  }

  const rootKey = root.kind === "keyword" ? `:${root.value}` : root.value;
  const binding = root.kind === "identifier" ? context.resolve(root.value) : undefined;
  const segments = rest.map(readPathPart);

  if (binding !== undefined) {
    if (segments.length === 0) {
      return binding;
    }
    return `steleGetPathVal(${binding}, ${formatGoStringSlice(segments)})`;
  }
  return `steleGetPathVal(${context.rootContextName}, ${formatGoStringSlice([rootKey, ...segments])})`;
}

/**
 * Translate `(collection name)` to Go path access.
 */
function translateCollection(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects exactly one symbol argument.', node.span, `Found ${node.items.length} operand(s).`, "Use (collection transactions).");
  }
  const target = node.items[0]!;
  if (target.kind !== "identifier") {
    throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects an identifier target.', target.span, `Found ${target.kind}.`, "Use an identifier for the collection name.");
  }
  return `steleGetPathVal(${context.rootContextName}, ${formatGoStringSlice([target.value])})`;
}

/**
 * Translate `(field (path root ...) field_name)` to Go path access.
 * Extends an existing path by appending one field segment.
 */
function translateField(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", 'Operator "field" expects a path and a field name.', node.span, `Found ${node.items.length} operand(s).`, "Use (field (path account) cash).");
  }
  const pathNode = node.items[0]!;
  const fieldNode = node.items[1]!;
  if (pathNode.kind !== "list" || pathNode.head !== "path") {
    throw new SteleError("E0603", "Backend Error", 'Operator "field" expects its first argument to be a path expression.',
      pathNode.span ?? node.span, "The Go backend extends existing path expressions by appending one field segment.",
      "Use (field (path account) cash).");
  }
  // Build an extended path node that includes the new field segment
  const extendedPath: ListNode = { kind: "list", head: "path", items: [...pathNode.items, fieldNode], span: node.span };
  return translatePath(extendedPath, context);
}

/**
 * Translate comparison operators (eq, neq, gt, gte, lt, lte).
 */
function translateComparison(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", `Operator "${op}" expects exactly two operands.`, node.span, `Found ${node.items.length} operand(s).`, "Pass two arguments.");
  }
  return emitComparison(op, translate(node.items[0]!, context), translate(node.items[1]!, context));
}

/**
 * Translate binary arithmetic operators.
 */
function translateBinaryArith(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", `Operator "${opName}" expects exactly two operands.`, node.span, `Found ${node.items.length} operand(s).`, "Pass two arguments.");
  }
  return `${helper}(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
}

/**
 * Translate unary arithmetic operators.
 */
function translateUnaryArith(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: string,
  helper: string,
): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", `Operator "${opName}" expects exactly one operand.`, node.span, `Found ${node.items.length} operand(s).`, "Pass a single value.");
  }
  return `${helper}(${translate(node.items[0]!, context)})`;
}

/**
 * Translate aggregate operators with optional path projection.
 */
function translateAggregateWithProjection(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: string,
  helper: string,
): string {
  if (node.items.length < 1 || node.items.length > 2) {
    throw new SteleError("E0603", "Backend Error", `Operator "${opName}" expects one collection and optionally a projection path.`, node.span, `Found ${node.items.length} operand(s).`, "Use (sum (path items)) or (sum (path items) (path price)).");
  }
  const collection = translate(node.items[0]!, context);
  const projection = node.items[1];
  if (projection === undefined) {
    return `${helper}(${collection})`;
  }
  const segments = readProjectionPath(projection, opName);
  return `${helper}(${collection}, ${formatGoStringSlice(segments)}...)`;
}

/**
 * Translate binary runtime operators (contains, starts-with, etc.).
 */
function translateBinaryRuntime(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError("E0603", "Backend Error", `Operator "${opName}" expects exactly two operands.`, node.span, `Found ${node.items.length} operand(s).`, "Pass two arguments.");
  }
  return `${helper}(${translate(node.items[0]!, context)}, ${translate(node.items[1]!, context)})`;
}

/**
 * Translate unary runtime operators (trim, lower, upper).
 */
function translateUnaryRuntime(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: string,
  helper: string,
): string {
  if (node.items.length !== 1) {
    throw new SteleError("E0603", "Backend Error", `Operator "${opName}" expects exactly one operand.`, node.span, `Found ${node.items.length} operand(s).`, "Pass a single value.");
  }
  return `${helper}(${translate(node.items[0]!, context)})`;
}

/**
 * Translate quantifier operators (forall, exists, where, none).
 */
function translateQuantifier(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  opName: "forall" | "exists" | "where" | "none",
): string {
  if (node.items.length !== 3) {
    throw new SteleError("E0603", "Backend Error", `Quantifier "${opName}" expects exactly three operands: (binding collection predicate).`, node.span, `Found ${node.items.length} operand(s).`, "Use (forall item (collection items) (gt (path item value) 0)).");
  }
  const binding = node.items[0]!;
  if (binding.kind !== "identifier") {
    throw new SteleError("E0603", "Backend Error", `Quantifier "${opName}" must bind an identifier.`, node.span, "The first quantifier argument names the element inside the predicate.", "Use (forall item (collection items) ...).");
  }
  const bound = context.bind(binding.value);
  const collection = translate(node.items[1]!, context);
  const predicateBody = translate(node.items[2]!, bound.context);
  const predicateSource = astToSource(node.items[2]!);
  return emitQuantifier(opName, collection, predicateBody, predicateSource, bound.name);
}

/**
 * Render an AST node back to a CDL-shaped source string (for predicate_source).
 */
export function astToSource(node: AstNode): string {
  if (node.kind === "number") return node.raw;
  if (node.kind === "string") return JSON.stringify(node.value);
  if (node.kind === "keyword") return `:${node.value}`;
  if (node.kind === "identifier") return node.value;
  const parts = [node.head, ...node.items.map((item) => astToSource(item))];
  return `(${parts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  throw new SteleError("E0603", "Backend Error", "Path segments must be identifiers or keywords.", node.span, `Found ${node.kind}.`, "Use a symbol-like path part.");
}

function readProjectionPath(node: AstNode, operatorName: string): string[] {
  if (node.kind !== "list" || node.head !== "path") {
    throw new SteleError("E0603", "Backend Error", `Operator "${operatorName}" projections must use (path ...).`, node.span, "Use path-based projections.", "Rewrite as (path field-name).");
  }
  if (node.items.length === 0) {
    throw new SteleError("E0603", "Backend Error", `Operator "${operatorName}" projections require at least one segment.`, node.span, "Need one or more identifier segments.", "Use (path value).");
  }
  return node.items.map(readPathPart);
}

function readModifiedPath(node: AstNode, owner: ListNode): string[] {
  if (node.kind !== "list" || node.head !== "path" || node.items.length === 0) {
    throw new SteleError("E0603", "Backend Error", 'Operator "modified" expects exactly one path expression.', node.span ?? owner.span, "Use (modified (path account balance)).", "Pass a path expression.");
  }
  return node.items.map(readPathPart);
}

function formatGoStringSlice(segments: readonly string[]): string {
  return `[]string{${segments.map(goStringLiteral).join(", ")}}`;
}

function goStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wrapBool(expr: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?$/.test(expr)) {
    return expr;
  }
  return `(${expr})`;
}

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

function allocateUniqueName(baseName: string, usedNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate) || GO_RESERVED_WORDS.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createTranslationContext(
  bindings = new Map<string, string>(),
  usedNames = new Set<string>(),
  rootContextName = "globalCtx",
): TranslationContext {
  return {
    bindings,
    rootContextName,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniqueName(sanitizeGoIdentifier(identifier, "item"), usedNames);
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
