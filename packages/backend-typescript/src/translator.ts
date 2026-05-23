import {
  SteleError,
  type AstNode,
  type Contract,
  type InvariantDeclaration,
  type ListNode,
  type ScenarioDeclaration,
  type ScenarioOperation,
} from "@stele/core";

const INDENT = "  ";

/**
 * Phase A + B + C operators for `@stele/backend-typescript`.
 *
 * Phase A (11 operators):
 *   - path / eq / neq / gt / gte / lt / lte: dispatched to runtime helpers.
 *   - and / or / not: emitted inline as &&, ||, !.
 *   - assert / invariant: handled at the test-rendering layer.
 *
 * Phase B (extends Phase A with 27 more operators):
 *   - Arithmetic (6): add, sub, mul, div, neg, abs.
 *   - Aggregates (10): sum, count, avg, min, max, distinct, has-length,
 *     is-empty, unique, exists-in.
 *   - String (4): contains, starts-with, ends-with, matches.
 *   - Control (7): when, if, implies, iff, not-null, between, approx-eq.
 *
 * Phase C (extends Phase B with 10 more operators + scenario/checker):
 *   - Quantifier (4): forall, exists, where, none — bind a variable, recover
 *     predicate source for `FailureWitness.predicate_source`.
 *   - Temporal (6): modified, state-before, state-after, within, after,
 *     before — read state-before/state-after keys from the root context.
 *   - Scenario / checker integration: `(uses-scenario <id>)` translates to
 *     `runtime.steleRunScenario(...)`; `(uses-checker <id>)` translates to
 *     `runtime.steleCallChecker(...)`. (when ...) guards are now allowed.
 *
 * Future EPs may add additional registry operators (e.g. `field` for the
 * Python backend convenience extension).
 */
const PHASE_A_RUNTIME_HELPERS = [
  "steleGetPath",
  "steleEq",
  "steleNeq",
  "steleGt",
  "steleGte",
  "steleLt",
  "steleLte",
];

const PHASE_B_RUNTIME_HELPERS = [
  // arithmetic
  "steleAbs",
  "steleAdd",
  "steleSub",
  "steleMul",
  "steleDiv",
  "steleNeg",
  // aggregate
  "steleSum",
  "steleCount",
  "steleAvg",
  "steleMin",
  "steleMax",
  "steleDistinct",
  "steleUnique",
  "steleHasLength",
  "steleIsEmpty",
  "steleExistsIn",
  // string
  "steleContains",
  "steleStartsWith",
  "steleEndsWith",
  "steleMatches",
  // control
  "steleNotNull",
  "steleBetween",
  "steleApproxEq",
];

const PHASE_C_RUNTIME_HELPERS = [
  // quantifier
  "steleForall",
  "steleExists",
  "steleWhere",
  "steleNone",
  // temporal
  "steleIsModified",
  "steleStateBefore",
  "steleStateAfter",
  "steleWithin",
  "steleBefore",
  "steleAfter",
  // scenario / checker
  "steleRunScenario",
  "steleCallChecker",
  "steleMergeContexts",
];

// EP04 batch 1 helpers exposed to the generated suite. Documented in
// `void runtime; // helpers: ...` so `tsc --noUnusedParameters` stays happy
// even when no invariant exercises an EP04 operator.
const EP04_RUNTIME_HELPERS = [
  // collection (4)
  "steleLength",
  "steleConcat",
  "steleSortBy",
  "steleSortByDesc",
  // arithmetic (5)
  "steleMod",
  "stelePow",
  "steleRound",
  "steleCeil",
  "steleFloor",
  // string (6)
  "steleTrim",
  "steleLower",
  "steleUpper",
  "steleSplit",
  "steleJoin",
  "steleJsonPath",
  // comparison (1)
  "steleDecimalEq",
  // data access (1)
  "steleTypeOf",
  // FP promoted (3); filter is an alias of where -> reuses steleWhere.
  "steleMap",
  "steleFirst",
  "steleLast",
];

const RUNTIME_HELPER_DOC = [
  ...PHASE_A_RUNTIME_HELPERS,
  ...PHASE_B_RUNTIME_HELPERS,
  ...PHASE_C_RUNTIME_HELPERS,
  ...EP04_RUNTIME_HELPERS,
];

/**
 * Reserved-word set used by `sanitizeTsIdentifier`.
 *
 * Includes ECMAScript keywords plus a handful of contextual identifiers we
 * never want to collide with generated symbols (`undefined`, `globalThis`,
 * etc.).
 */
const TS_RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "as",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "async",
  "await",
  "of",
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "ctx",
  "runtime",
  "expect",
  "describe",
  "it",
  "beforeEach",
  "steleContext",
]);

export type TranslationContext = {
  /** Variable bindings introduced by quantifiers (Phase B+); Phase A keeps it empty. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Identifier representing the root context inside generated `it(...)` blocks. */
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

const COMPARISON_HELPER: Record<string, string> = {
  eq: "steleEq",
  neq: "steleNeq",
  gt: "steleGt",
  gte: "steleGte",
  lt: "steleLt",
  lte: "steleLte",
};

const OPERATOR_HANDLERS: Record<string, OperatorHandler> = {
  path: translatePath,
  // Collection / value primitives needed by aggregate operators.
  collection: translateCollection,
  value: translateValue,
  field: translateField,
  ...Object.fromEntries(
    Object.entries(COMPARISON_HELPER).map(([operator, helper]) => [
      operator,
      (node: ListNode, context: TranslationContext, translate: ExpressionTranslator) =>
        translateComparison(node, context, translate, helper),
    ]),
  ),
  and: translateAnd,
  or: translateOr,
  not: translateNot,
  // -- Phase B: arithmetic ------------------------------------------------
  // Arithmetic ops dispatch to runtime helpers so generated code typechecks
  // under `tsc --strict` even when operands come from `steleGetPath`
  // (which is typed `unknown`).
  add: (node, context, translate) => translateVariadicArithmetic(node, context, translate, "add", "steleAdd"),
  mul: (node, context, translate) => translateVariadicArithmetic(node, context, translate, "mul", "steleMul"),
  sub: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "sub", "steleSub"),
  div: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "div", "steleDiv"),
  neg: translateNeg,
  abs: translateAbs,
  // -- Phase B: aggregates ------------------------------------------------
  sum: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "sum", "steleSum"),
  count: translateCount,
  avg: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "avg", "steleAvg"),
  min: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "min", "steleMin"),
  max: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "max", "steleMax"),
  distinct: (node, context, translate) =>
    translateAggregateWithProjection(node, context, translate, "distinct", "steleDistinct"),
  unique: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "unique", "steleUnique"),
  "has-length": translateHasLength,
  "is-empty": translateIsEmpty,
  "exists-in": translateExistsIn,
  // "in" is semantically identical to "exists-in": checks whether a value
  // exists inside a collection. Reuses the same runtime helper.
  in: translateExistsIn,
  // -- Phase B: string ----------------------------------------------------
  contains: (node, context, translate) => translateBinaryRuntime(node, context, translate, "contains", "steleContains"),
  "starts-with": (node, context, translate) =>
    translateBinaryRuntime(node, context, translate, "starts-with", "steleStartsWith"),
  "ends-with": (node, context, translate) =>
    translateBinaryRuntime(node, context, translate, "ends-with", "steleEndsWith"),
  matches: (node, context, translate) => translateBinaryRuntime(node, context, translate, "matches", "steleMatches"),
  // -- Phase B: control ---------------------------------------------------
  when: translateWhen,
  if: translateIf,
  implies: translateImplies,
  iff: translateIff,
  "not-null": translateNotNull,
  between: translateBetween,
  "approx-eq": translateApproxEq,
  "decimal-eq": (node, context, translate) => translateBinaryRuntime(node, context, translate, "decimal-eq", "steleDecimalEq"),
  // -- Phase C: quantifiers -----------------------------------------------
  forall: (node, context, translate) => translateQuantifier(node, context, translate, "forall", "steleForall"),
  exists: (node, context, translate) => translateQuantifier(node, context, translate, "exists", "steleExists"),
  where: (node, context, translate) => translateQuantifier(node, context, translate, "where", "steleWhere"),
  none: (node, context, translate) => translateQuantifier(node, context, translate, "none", "steleNone"),
  // EP04 batch 1: filter is a strict alias of where. Same translator path -
  // the operator name is rewritten to "where" so the runtime call is
  // `runtime.steleWhere(...)`, guaranteeing byte-identical generated code.
  filter: (node, context, translate) => translateQuantifier(node, context, translate, "where", "steleWhere"),
  // -- Phase C: temporal --------------------------------------------------
  modified: translateModified,
  "state-before": translateStateBefore,
  "state-after": translateStateAfter,
  within: translateWithin,
  before: (node, context, translate) => translateTemporalBinary(node, context, translate, "before", "steleBefore"),
  after: (node, context, translate) => translateTemporalBinary(node, context, translate, "after", "steleAfter"),
  // -- EP04 batch 1: collection ------------------------------------------
  length: (node, context, translate) => translateUnary(node, context, translate, "length", "steleLength"),
  concat: translateConcat,
  "sort-by": (node, context, translate) => translateSortBy(node, context, translate, "sort-by", "steleSortBy"),
  "sort-by-desc": (node, context, translate) =>
    translateSortBy(node, context, translate, "sort-by-desc", "steleSortByDesc"),
  // -- EP04 batch 1: arithmetic ------------------------------------------
  mod: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "mod", "steleMod"),
  pow: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "pow", "stelePow"),
  round: translateRound,
  ceil: (node, context, translate) => translateUnary(node, context, translate, "ceil", "steleCeil"),
  floor: (node, context, translate) => translateUnary(node, context, translate, "floor", "steleFloor"),
  // -- EP04 batch 1: string ----------------------------------------------
  trim: (node, context, translate) => translateUnary(node, context, translate, "trim", "steleTrim"),
  lower: (node, context, translate) => translateUnary(node, context, translate, "lower", "steleLower"),
  upper: (node, context, translate) => translateUnary(node, context, translate, "upper", "steleUpper"),
  split: (node, context, translate) => translateBinaryRuntime(node, context, translate, "split", "steleSplit"),
  join: (node, context, translate) => translateBinaryRuntime(node, context, translate, "join", "steleJoin"),
  "json-path": (node, context, translate) => translateBinaryRuntime(node, context, translate, "json-path", "steleJsonPath"),
  // -- EP04 batch 1: data access -----------------------------------------
  "type-of": (node, context, translate) => translateUnary(node, context, translate, "type-of", "steleTypeOf"),
  // -- EP04 batch 1: FP promoted -----------------------------------------
  map: (node, context, translate) => translateMap(node, context, translate),
  first: (node, context, translate) => translateUnary(node, context, translate, "first", "steleFirst"),
  last: (node, context, translate) => translateUnary(node, context, translate, "last", "steleLast"),
};

/**
 * Generate a Vitest source file for a contract slice.
 *
 * Emits one `describe(...)` block with one `it(...)` per invariant. Each
 * invariant translates its `(assert ...)` expression and wraps it in
 * `expect(...).toBe(true)`. Phase C adds support for `(when ...)` guards,
 * `(uses-checker ...)`, and `(uses-scenario ...)`.
 */
export function generateVitestSource(contract: Contract): string {
  const lines: string[] = [];
  const usedTestNames = new Set<string>();
  const invariants = contract.invariants.slice().sort(compareInvariants);
  const scenariosById = new Map(contract.scenarios.map((scenario) => [scenario.id, scenario] as const));

  lines.push(`import { describe, it, expect, beforeEach } from "vitest";`);
  lines.push(`import { steleContext } from "./conftest.js";`);
  lines.push(`import * as runtime from "./_stele_runtime.js";`);
  lines.push(`import type { SteleContext } from "./_stele_runtime.js";`);
  lines.push("");
  // Reference the helpers to keep `tsc --noUnusedParameters` (and similar)
  // strict checks calm even when no invariant exercises them.
  lines.push(`void runtime; // helpers: ${RUNTIME_HELPER_DOC.join(", ")}`);
  lines.push("");
  lines.push(`describe("Stele Contract", () => {`);
  lines.push(`${INDENT}let ctx: SteleContext;`);
  lines.push(`${INDENT}beforeEach(() => {`);
  lines.push(`${INDENT}${INDENT}ctx = steleContext;`);
  lines.push(`${INDENT}});`);

  if (invariants.length === 0) {
    lines.push(`${INDENT}it.skip("contract has no invariants in this group", () => {`);
    lines.push(`${INDENT}${INDENT}// intentionally empty`);
    lines.push(`${INDENT}});`);
  }

  for (const invariant of invariants) {
    lines.push("");
    const testName = allocateUniqueName(sanitizeTsIdentifier(invariant.id, "invariant"), usedTestNames);
    usedTestNames.add(testName);
    lines.push(...renderInvariantTest(invariant, testName, scenariosById));
  }

  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Translate one CDL expression to its TypeScript equivalent string.
 *
 * Public so `tests/translator.test.ts` (and downstream tooling) can target a
 * single expression without a full Contract.
 */
export function translateExpression(node: AstNode, context: TranslationContext = createTranslationContext()): string {
  return translateNode(node, context);
}

/**
 * Sanitize a CDL identifier so it can be reused as a TypeScript identifier.
 *
 * Replaces non-alphanumeric/underscore characters with underscores, collapses
 * runs of underscores, strips leading/trailing underscores, and prefixes a
 * fallback when the result begins with a digit or is empty.
 */
export function sanitizeTsIdentifier(identifier: string, fallbackPrefix = "value"): string {
  const cleaned = identifier
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
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
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Invariant "${invariant.id}" lacks an assert expression and is not a checker invariant.`,
      invariant.span,
      "Every invariant must contain either an (assert ...) clause or a (uses-checker ...) form.",
      "Add an (assert ...) clause or wire up a checker.",
    );
  }

  const assertionContextName = usesScenario ? "stele_assert_context" : "ctx";
  const expressionContext = createTranslationContext(undefined, undefined, assertionContextName);

  const lines = [`${INDENT}it(${toTsString(testName)}, () => {`];

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
    // Cast through `as runtime.ScenarioDefinition` so the JSON literal's
    // inferred string types collapse onto the discriminated union without
    // forcing the user to author the scenario as a TS literal.
    lines.push(
      `${INDENT}${INDENT}const stele_scenario: runtime.ScenarioDefinition = ${scenarioLiteral} as runtime.ScenarioDefinition;`,
    );
    lines.push(
      `${INDENT}${INDENT}const stele_scenario_context = runtime.steleRunScenario(stele_scenario, ctx, (ctx as { _stele_sandbox?: runtime.ScenarioSandbox })._stele_sandbox ?? null);`,
    );
    lines.push(
      `${INDENT}${INDENT}const stele_assert_context = runtime.steleMergeContexts(ctx, stele_scenario_context);`,
    );
  }

  if (invariant.whenExpression !== undefined) {
    const guard = wrapForLogical(translateExpression(invariant.whenExpression, expressionContext));
    lines.push(`${INDENT}${INDENT}if (!${guard}) {`);
    lines.push(`${INDENT}${INDENT}${INDENT}return;`);
    lines.push(`${INDENT}${INDENT}}`);
  }

  if (usesChecker) {
    const checker = invariant.usesChecker!;
    const argsLiteral = renderCheckerArgs(checker.args, expressionContext);
    lines.push(
      `${INDENT}${INDENT}const stele_checker_result = runtime.steleCallChecker(${toTsString(checker.checkerId)}, ${assertionContextName}, ${argsLiteral});`,
    );
    lines.push(
      `${INDENT}${INDENT}expect(stele_checker_result.passed, stele_checker_result.message ?? ${toTsString(`Checker failed: ${checker.checkerId}`)}).toBe(true);`,
    );
    lines.push(`${INDENT}});`);
    return lines;
  }

  const translated = translateExpression(invariant.assertExpression!, expressionContext);
  lines.push(`${INDENT}${INDENT}expect(${translated}).toBe(true);`);
  lines.push(`${INDENT}});`);
  return lines;
}

function renderCheckerArgs(args: readonly AstNode[], context: TranslationContext): string {
  if (args.length === 0) {
    return "{}";
  }
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.kind !== "list") {
      continue;
    }
    if (arg.items.length !== 1) {
      continue;
    }
    const valueNode = arg.items[0]!;
    parts.push(`${toTsString(arg.head)}: ${translateNode(valueNode, context)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function renderScenarioLiteral(scenario: ScenarioDeclaration): string {
  return JSON.stringify(serializeScenario(scenario), null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${INDENT}${INDENT}${line}`))
    .join("\n");
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
    return { $ref: serializeScenarioRef(node) };
  }
  if (node.head === "gen") {
    return { $gen: serializeScenarioGenerator(node) };
  }
  throw new SteleError(
    "E0606",
    "Backend Error",
    `Unsupported scenario body operator "${node.head}".`,
    node.span,
    "TypeScript scenario bodies support object, ref, and gen forms inside scenario call bodies.",
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
  if (captureNode === undefined || captureNode.kind !== "identifier") {
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
      `Found ${kindNode === undefined ? "nothing" : kindNode.kind} instead.`,
      'Use a form like (gen unique-name "fund").',
    );
  }
  if (prefixNode?.kind !== "string" || node.items.length !== 2) {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario gen unique-name expects exactly one string prefix.",
      prefixNode?.span ?? node.span,
      `Found ${node.items.length - 1} generator argument(s).`,
      'Use a form like (gen unique-name "fund").',
    );
  }
  return { kind: "unique-name", prefix: prefixNode.value };
}

function translateNode(node: AstNode, context: TranslationContext): string {
  if (node.kind === "number") {
    return node.raw;
  }
  if (node.kind === "string") {
    return toTsString(node.value);
  }
  if (node.kind === "keyword") {
    return toTsString(`:${node.value}`);
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
        return "null";
      default:
        throw new SteleError(
          "E0602",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in TypeScript backend expression.`,
          node.span,
          "Phase B only translates bound variables, booleans, null-like symbols, and supported operator forms.",
          "Wrap the value in a supported operator such as path or value.",
        );
    }
  }

  const handler = OPERATOR_HANDLERS[node.head];
  if (handler === undefined) {
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Unsupported TypeScript backend operator "${node.head}".`,
      node.span,
      "@stele/backend-typescript Phase B implements 38 operators (path, eq, neq, gt, gte, lt, lte, and, or, not, assert, plus 27 Phase B ops).",
      "Use a supported operator or wait for the Phase C/D operator pack (forall/exists/where/none, scenario, checker).",
    );
  }
  return handler(node, context, translateNode);
}

function translatePath(node: ListNode, context: TranslationContext): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" requires at least one segment.',
      node.span,
      "A path expression needs one or more symbol segments to translate.",
      "Use a form like (path account cash).",
    );
  }

  const [root, ...rest] = node.items;
  if (root === undefined || (root.kind !== "identifier" && root.kind !== "keyword")) {
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
  const segments = rest.map(readPathPart);

  if (binding !== undefined) {
    return segments.length === 0
      ? binding
      : `runtime.steleGetPath(${binding}, ${formatSegmentArray(segments)})`;
  }
  return `runtime.steleGetPath(${context.rootContextName}, ${formatSegmentArray([rootKey, ...segments])})`;
}

function translateCollection(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "collection" expects exactly one symbol argument.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (collection transactions).",
    );
  }
  const target = node.items[0]!;
  if (target.kind !== "identifier") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "collection" expects an identifier target.',
      target.span,
      `Found ${target.kind} where the collection name should be.`,
      "Use a form like (collection transactions).",
    );
  }
  // Read the named collection directly from the root context. This mirrors
  // the Python backend's `stele_context["name"]` access.
  return `runtime.steleGetPath(${context.rootContextName}, ${formatSegmentArray([target.value])})`;
}

function translateValue(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "value" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single value, e.g. (value 5).",
    );
  }
  return translate(node.items[0]!, context);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function translateField(node: ListNode, context: TranslationContext, _translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects a path and a field name.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (field (path account) cash).",
    );
  }
  const pathNode = node.items[0]!;
  const fieldNode = node.items[1]!;
  if (pathNode.kind !== "list" || pathNode.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects its first argument to be a path expression.',
      pathNode.span ?? node.span,
      "The TypeScript backend extends existing path expressions by appending one field segment.",
      "Use a form like (field (path account) cash).",
    );
  }
  // Build an extended path node and delegate to translatePath.
  const extendedPath: ListNode = {
    kind: "list",
    head: "path",
    items: [...pathNode.items, fieldNode],
    span: node.span,
  };
  return translatePath(extendedPath, context);
}

function translateComparison(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${node.head}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass two arguments, e.g. (eq (path foo) 5).",
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `runtime.${helper}(${left}, ${right})`;
}

function translateAnd(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "and" requires at least one operand.',
      node.span,
      "An (and) form must wrap one or more predicates.",
      "Pass at least one predicate, e.g. (and (gt x 0) (lt x 10)).",
    );
  }
  return node.items.map((item) => wrapForLogical(translate(item, context))).join(" && ");
}

function translateOr(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "or" requires at least one operand.',
      node.span,
      "An (or) form must wrap one or more predicates.",
      "Pass at least one predicate, e.g. (or (eq x 1) (eq x 2)).",
    );
  }
  return node.items.map((item) => wrapForLogical(translate(item, context))).join(" || ");
}

function translateNot(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "not" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single predicate, e.g. (not (eq x 1)).",
    );
  }
  return `!${wrapForLogical(translate(node.items[0]!, context))}`;
}

// ---------------------------------------------------------------------------
// Phase B: arithmetic
// ---------------------------------------------------------------------------

function translateVariadicArithmetic(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length < 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" requires at least two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass at least two operands, e.g. (${operatorName} 1 2).`,
    );
  }
  const args = node.items.map((item) => translate(item, context)).join(", ");
  return `runtime.${helper}(${args})`;
}

function translateBinaryArithmetic(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass two arguments, e.g. (${operatorName} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `runtime.${helper}(${left}, ${right})`;
}

function translateNeg(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "neg" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single number, e.g. (neg 5).",
    );
  }
  return `runtime.steleNeg(${translate(node.items[0]!, context)})`;
}

function translateAbs(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "abs" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single number, e.g. (abs (path foo)).",
    );
  }
  return `runtime.steleAbs(${translate(node.items[0]!, context)})`;
}

// ---------------------------------------------------------------------------
// Phase B: aggregates
// ---------------------------------------------------------------------------

function translateAggregateWithProjection(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length < 1 || node.items.length > 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects one collection and optionally a projection path.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} (path items)) or (${operatorName} (path items) (path price)).`,
    );
  }
  const collection = translate(node.items[0]!, context);
  const projection = node.items[1];
  if (projection === undefined) {
    return `runtime.${helper}(${collection})`;
  }
  const segments = readProjectionPath(projection, operatorName);
  return `runtime.${helper}(${collection}, ${formatSegmentArray(segments)})`;
}

function translateCount(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "count" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single collection, e.g. (count (path items)).",
    );
  }
  return `runtime.steleCount(${translate(node.items[0]!, context)})`;
}

function translateHasLength(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "has-length" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a collection and an expected length, e.g. (has-length (path items) 3).",
    );
  }
  const collection = translate(node.items[0]!, context);
  const length = translate(node.items[1]!, context);
  return `runtime.steleHasLength(${collection}, ${length})`;
}

function translateIsEmpty(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "is-empty" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a collection, e.g. (is-empty (path items)).",
    );
  }
  return `runtime.steleIsEmpty(${translate(node.items[0]!, context)})`;
}

function translateExistsIn(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "exists-in" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a value and a container, e.g. (exists-in (path id) (path ids)).",
    );
  }
  const value = translate(node.items[0]!, context);
  const container = translate(node.items[1]!, context);
  return `runtime.steleExistsIn(${value}, ${container})`;
}

// ---------------------------------------------------------------------------
// Phase B: string
// ---------------------------------------------------------------------------

function translateBinaryRuntime(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass two arguments, e.g. (${operatorName} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `runtime.${helper}(${left}, ${right})`;
}

// ---------------------------------------------------------------------------
// Phase B: control flow
// ---------------------------------------------------------------------------

function translateWhen(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "when" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a condition and body, e.g. (when (gt x 0) (lt x 10)).",
    );
  }
  const condition = wrapForLogical(translate(node.items[0]!, context));
  const body = wrapForLogical(translate(node.items[1]!, context));
  // Lazy semantics: when(cond, body) <=> (!cond) || body. Body only evaluates
  // when cond is true. Mirrors Python's `(not cond) or body`.
  return `(!${condition} || ${body})`;
}

function translateIf(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "if" expects exactly three operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a condition, then-branch, and else-branch, e.g. (if cond then else).",
    );
  }
  const condition = translate(node.items[0]!, context);
  const consequent = translate(node.items[1]!, context);
  const alternate = translate(node.items[2]!, context);
  // Native ternary preserves lazy evaluation of the two branches.
  return `(${condition} ? ${consequent} : ${alternate})`;
}

function translateImplies(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "implies" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass two booleans, e.g. (implies (eq x 1) (gt y 0)).",
    );
  }
  const left = wrapForLogical(translate(node.items[0]!, context));
  const right = wrapForLogical(translate(node.items[1]!, context));
  return `(!${left} || ${right})`;
}

function translateIff(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "iff" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass two booleans, e.g. (iff (eq x 1) (eq y 1)).",
    );
  }
  const left = wrapForLogical(translate(node.items[0]!, context));
  const right = wrapForLogical(translate(node.items[1]!, context));
  return `(${left} === ${right})`;
}

function translateNotNull(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "not-null" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single path, e.g. (not-null (path account email)).",
    );
  }
  return `runtime.steleNotNull(${translate(node.items[0]!, context)})`;
}

function translateBetween(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "between" expects exactly three operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass value, low, and high, e.g. (between x 0 10).",
    );
  }
  const value = translate(node.items[0]!, context);
  const low = translate(node.items[1]!, context);
  const high = translate(node.items[2]!, context);
  return `runtime.steleBetween(${value}, ${low}, ${high})`;
}

function translateApproxEq(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 3) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "approx-eq" expects exactly three operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass two values and a tolerance, e.g. (approx-eq a b 1e-6).",
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  const tolerance = translate(node.items[2]!, context);
  return `runtime.steleApproxEq(${left}, ${right}, ${tolerance})`;
}

// ---------------------------------------------------------------------------
// Phase C: quantifiers (forall / exists / where / none)
// ---------------------------------------------------------------------------

/**
 * Translate `(forall <bind> <coll> <pred>)` and friends.
 *
 * Binds `<bind>` into a fresh scope, translates the predicate body inside
 * that scope, and emits a runtime call of the form
 * `runtime.steleX(<coll>, (<bind>) => <pred>, "<source>")`.
 *
 * The third argument is the literal CDL source of the predicate body,
 * recovered by `astToSource`. It feeds `FailureWitness.predicate_source` so
 * `stele why` can show the actual predicate the user wrote.
 */
function translateQuantifier(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 3) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Quantifier "${operatorName}" expects exactly three operands: (binding collection predicate).`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} item (collection items) (gt (path item value) 0)).`,
    );
  }
  const binding = node.items[0]!;
  if (binding.kind !== "identifier") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Quantifier "${operatorName}" must bind an identifier.`,
      node.span,
      "The first quantifier argument names the element available inside the predicate body.",
      `Use a form like (${operatorName} item (collection items) ...).`,
    );
  }
  const bound = context.bind(binding.value);
  const collection = translate(node.items[1]!, context);
  const predicateBody = translate(node.items[2]!, bound.context);
  const predicateSource = astToSource(node.items[2]!);
  return `runtime.${helper}(${collection}, (${bound.name}: unknown) => ${wrapForLogical(predicateBody)}, ${toTsString(predicateSource)})`;
}

// ---------------------------------------------------------------------------
// Phase C: temporal helpers
// ---------------------------------------------------------------------------

function translateModified(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "modified" expects exactly one (path ...) operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (modified (path account balance)).",
    );
  }
  const segments = readModifiedPath(node.items[0]!, node);
  return `runtime.steleIsModified(${context.rootContextName}, ${formatSegmentArray(segments)})`;
}

function translateStateBefore(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "state-before" takes no operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use the bare form (state-before).",
    );
  }
  return `runtime.steleStateBefore(${context.rootContextName})`;
}

function translateStateAfter(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "state-after" takes no operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use the bare form (state-after).",
    );
  }
  return `runtime.steleStateAfter(${context.rootContextName})`;
}

function translateWithin(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "within" expects an event expression and a duration in seconds.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (within (path event timestamp) 30).",
    );
  }
  const event = translate(node.items[0]!, context);
  const duration = translate(node.items[1]!, context);
  return `runtime.steleWithin(${event}, ${duration})`;
}

function translateTemporalBinary(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `runtime.${helper}(${left}, ${right})`;
}

function readModifiedPath(node: AstNode, owner: ListNode): string[] {
  if (node.kind !== "list" || node.head !== "path" || node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "modified" expects exactly one path expression.',
      node.span ?? owner.span,
      "The TypeScript backend compares state-before and state-after by path.",
      "Use a form like (modified (path account balance)).",
    );
  }
  return node.items.map((part) => {
    if (part.kind === "identifier") {
      return part.value;
    }
    if (part.kind === "keyword") {
      return `:${part.value}`;
    }
    throw new SteleError(
      "E0603",
      "Backend Error",
      "Modified path segments must be identifiers or keywords.",
      part.span,
      `Found ${part.kind} inside a modified path.`,
      "Replace the segment with a symbol-like path part.",
    );
  });
}

// ---------------------------------------------------------------------------
// Phase C: predicate source recovery
// ---------------------------------------------------------------------------

/**
 * Render an AST node back to a CDL-shaped source string.
 *
 * Used to populate `FailureWitness.predicate_source`. The output is
 * canonicalized (single-space separators, no source comments), so it is
 * suitable for human display but not for round-trip parsing.
 */
export function astToSource(node: AstNode): string {
  if (node.kind === "number") {
    return node.raw;
  }
  if (node.kind === "string") {
    return JSON.stringify(node.value);
  }
  if (node.kind === "keyword") {
    return `:${node.value}`;
  }
  if (node.kind === "identifier") {
    return node.value;
  }
  const parts = [node.head, ...node.items.map((item) => astToSource(item))];
  return `(${parts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    "Path segments must be identifiers or keywords in the TypeScript backend.",
    node.span,
    `Found ${node.kind} in a translated path expression.`,
    "Replace the segment with a symbol-like path part.",
  );
}

function readProjectionPath(node: AstNode, operatorName: string): string[] {
  if (node.kind !== "list" || node.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" projections must use a (path ...) expression.`,
      node.span,
      "The TypeScript backend only supports path-based collection projections in v0.1.",
      "Rewrite the projection as (path field-name).",
    );
  }
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" projections require at least one path segment.`,
      node.span,
      "A projection path needs one or more identifier segments.",
      "Use a form like (path value).",
    );
  }
  return node.items.map(readPathPart);
}

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

// ---------------------------------------------------------------------------
// EP04 batch 1: shared translator helpers
// ---------------------------------------------------------------------------

function translateUnary(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects exactly one operand.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass a single value, e.g. (${operatorName} (path foo)).`,
    );
  }
  return `runtime.${helper}(${translate(node.items[0]!, context)})`;
}

function translateConcat(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length < 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "concat" expects at least one collection operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass one or more collections, e.g. (concat (collection a) (collection b)).",
    );
  }
  const args = node.items.map((item) => translate(item, context)).join(", ");
  return `runtime.steleConcat(${args})`;
}

function translateSortBy(
  node: ListNode,
  context: TranslationContext,
  translate: ExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects a collection and a (path ...) projection.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} (collection items) (path price)).`,
    );
  }
  const collection = translate(node.items[0]!, context);
  const segments = readProjectionPath(node.items[1]!, operatorName);
  return `runtime.${helper}(${collection}, ${formatSegmentArray(segments)})`;
}

function translateRound(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length < 1 || node.items.length > 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "round" expects one number and optionally a digit count.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (round x) or (round x 2).",
    );
  }
  const value = translate(node.items[0]!, context);
  if (node.items.length === 1) {
    return `runtime.steleRound(${value})`;
  }
  const digits = translate(node.items[1]!, context);
  return `runtime.steleRound(${value}, ${digits})`;
}

function translateMap(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "map" expects a collection and a (path ...) projection.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (map (collection items) (path price)).",
    );
  }
  const collection = translate(node.items[0]!, context);
  const segments = readProjectionPath(node.items[1]!, "map");
  return `runtime.steleMap(${collection}, ${formatSegmentArray(segments)})`;
}

function formatSegmentArray(segments: readonly string[]): string {
  return `[${segments.map((segment) => toTsString(segment)).join(", ")}]`;
}

function wrapForLogical(expression: string): string {
  return /^[A-Za-z0-9_.]+(\(.*\))?$/.test(expression) ? expression : `(${expression})`;
}

function toTsString(value: string): string {
  return JSON.stringify(value);
}

function allocateUniqueName(baseName: string, usedNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate) || TS_RESERVED_WORDS.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createTranslationContext(
  bindings = new Map<string, string>(),
  usedNames = new Set<string>(),
  rootContextName = "ctx",
): TranslationContext {
  return {
    bindings,
    rootContextName,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniqueName(sanitizeTsIdentifier(identifier, "item"), usedNames);
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
