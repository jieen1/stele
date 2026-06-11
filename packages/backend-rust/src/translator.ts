import { SteleError, stableStringCompare } from "@stele/core";
import type { AstNode, ListNode, Contract, InvariantDeclaration, ScenarioDeclaration } from "@stele/core";
import { COMPARISON_OPERATORS, renderComparison } from "./templates/comparison.js";
import {
    renderAnd,
    renderIf,
    renderImplies,
    renderIff,
    renderNot,
    renderOr,
    renderWhen,
} from "./templates/logic.js";
import { renderAggregate, renderLength, renderMap, renderQuantifier, renderSortBy } from "./templates/collection.js";
import { renderBinaryArithmetic, renderUnaryArithmetic, renderVariadicArithmetic } from "./templates/arithmetic.js";
import {
    renderModified,
    renderStateAfter,
    renderStateBefore,
    renderTemporalBinary,
    renderWithin,
} from "./templates/temporal.js";
import { renderBinaryStringOperator, renderUnaryStringOperator } from "./templates/string.js";

const INDENT = "  ";

/**
 * Translation context for Rust code generation.
 */
export type TranslationContext = {
    /** Variable bindings from quantifiers. */
    readonly bindings: ReadonlyMap<string, string>;
    /** Name of the root context variable. */
    readonly rootContextName: string;
    /** Names already allocated to avoid collisions. */
    readonly usedNames: ReadonlySet<string>;
    /** Current test name (for quantifier witness emission). */
    readonly testName: string;
    /** True when inside a closure body (e.g. quantifier predicate).
     * Closure bodies return bool, so the ? operator cannot be used. */
    readonly inClosure: boolean;
    /** Allocate a fresh binding for a CDL identifier. */
    bind(identifier: string): { name: string; context: TranslationContext };
    /** Resolve a CDL identifier to its Rust name. */
    resolve(identifier: string): string | undefined;
    /** Create a child context with a different inClosure setting. */
    withClosure(inClosure: boolean): TranslationContext;
};

/**
 * Reserved words in Rust that must not be used as identifiers.
 */
const RUST_RESERVED_WORDS = new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "none", "pub", "ref",
    "return", "self", "Self", "static", "struct", "super", "true", "trait",
    "type", "unsafe", "use", "where", "while", "abstract", "become", "box",
    "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual",
    "yield", "try", "auto", "macro_rules",
    // Context symbols we never want to collide with
    "ctx", "runtime", "result", "ok", "err", "items", "item",
    "stele_context", "stele_assert_context",
]);

/**
 * Generate a Rust integration test file for a set of invariants.
 *
 * Each invariant becomes a `#[test] fn test_<snake_case_id>()` function.
 * The file starts with `#[path]` directives to embed the runtime and conftest.
 */
export function generateRustSource(contract: Contract): string {
    const lines: string[] = [];
    const usedTestNames = new Set<string>();
    const invariants = contract.invariants.slice().sort(compareInvariants);
    const scenariosById = new Map(contract.scenarios.map((s) => [s.id, s] as const));

    // File header: embed the runtime via #[path]
    lines.push('#[path = "_stele_runtime.rs"]');
    lines.push("mod _stele_runtime;");
    lines.push("pub use _stele_runtime::*;");
    lines.push("");

    for (const invariant of invariants) {
        const testName = allocateUniqueName(
            invariantToRustFnName(invariant.id),
            usedTestNames,
        );
        usedTestNames.add(testName);
        lines.push(...renderInvariantTest(invariant, testName, scenariosById));
        lines.push("");
    }

    return lines.join("\n") + "\n";
}

/**
 * Translate a single CDL expression to Rust source code.
 */
export function translateExpression(
    node: AstNode,
    context: TranslationContext = createTranslationContext("ctx", ""),
): string {
    return translateNode(node, context);
}

/**
 * Wrap an argument for a &SteleValue parameter.
 * Simple identifiers (quantifier bindings) are already &SteleValue.
 * Everything else needs & prefix.
 */
export function wrapSteleArg(expr: string): string {
    if (/^[a-z_]+$/.test(expr) && !expr.startsWith("stele_") && expr !== "ctx") {
        return expr;
    }
    return `&${expr}`;
}

/**
 * Render an AST node back to a CDL-shaped source string for predicate_source.
 */
export function astToSource(node: AstNode): string {
    if (node.kind === "number") return node.raw;
    if (node.kind === "string") return JSON.stringify(node.value);
    if (node.kind === "keyword") return `:${node.value}`;
    if (node.kind === "identifier") return node.value;
    const parts = [node.head, ...node.items.map((item) => astToSource(item))];
    return `(${parts.join(" ")})`;
}

/**
 * Sanitize a CDL identifier to valid Rust snake_case identifier.
 */
export function sanitizeRustIdentifier(identifier: string, fallbackPrefix = "value"): string {
    // kebab-case to snake_case, then sanitize
    const cleaned = identifier
        .replace(/-/g, "_")
        .replace(/[^A-Za-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    const withFallback = cleaned.length === 0 ? fallbackPrefix : cleaned;
    if (/^[0-9]/.test(withFallback)) {
        return `${fallbackPrefix}_${withFallback}`;
    }
    return withFallback;
}

// ---------------------------------------------------------------------------
// Invariant rendering
// ---------------------------------------------------------------------------

function renderInvariantTest(
    invariant: InvariantDeclaration,
    testName: string,
    scenariosById: ReadonlyMap<string, ScenarioDeclaration>,
): string[] {
    const lines: string[] = [];
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

    lines.push("#[test]");
    lines.push(`fn test_${testName}() -> Result<(), SteleRuntimeError> {`);

    let assertionContextName = "ctx";

    if (usesScenario) {
        lines.push(`${INDENT}let registry = /* user ScenarioRegistry */;`);
        lines.push(`${INDENT}let mut ctx = stele_context();`);
        const scenarioId = invariant.usesScenario!.scenarioId;
        const scenario = scenariosById.get(scenarioId);
        if (scenario === undefined) {
            throw new SteleError(
                "E0605",
                "Backend Error",
                `Invariant "${invariant.id}" references unknown scenario "${scenarioId}".`,
                invariant.usesScenario!.span,
                "Scenario references should have been validated before backend generation.",
                "Fix the contract or re-run generation.",
            );
        }
        const stepsLiteral = renderScenarioLiteral(scenario);
        lines.push(`${INDENT}let steps: [_stele_runtime::ScenarioStep; ${scenario.steps.length}] = ${stepsLiteral};`);
        lines.push(`${INDENT}let stele_scenario_context = stele_run_scenario(&registry, &steps, &mut ctx).expect("scenario failed");`);
        lines.push(`${INDENT}let stele_assert_context = stele_merge_contexts(&ctx, &stele_scenario_context);`);
        assertionContextName = "stele_assert_context";
    } else {
        lines.push(`${INDENT}let ctx = stele_context();`);
    }

    const expressionContext = createTranslationContext(assertionContextName, testName);

    // Guard clause: (when ...)
    if (invariant.whenExpression !== undefined) {
        const guard = translateNode(invariant.whenExpression, expressionContext);
        lines.push(`${INDENT}if !(${guard}) { return Ok(()); }`);
    }

    if (usesChecker) {
        const checker = invariant.usesChecker!;
        const args = renderCheckerArgs(checker.args, expressionContext);
        lines.push(`${INDENT}let checker_result = stele_call_checker(&CHECKERS, ${rustStringLiteral(checker.checkerId)}, &[${args}], &ctx).expect("checker call failed");`);
        lines.push(`${INDENT}assert!(checker_result.ok, checker_result.message.unwrap_or_else(|| ${rustStringLiteral(`Checker failed: ${checker.checkerId}`)}));`);
        lines.push(`${INDENT}Ok(())`);
        lines.push("}");
        return lines;
    }

    const translated = translateNode(invariant.assertExpression!, expressionContext);
    // The translated expression evaluates to a plain bool (runtime comparators
    // return Result<bool> and `?` is applied inside the translation). Discarding
    // it would make every assert-invariant pass vacuously, so assert on it.
    lines.push(
        `${INDENT}assert!(${translated}, ${rustStringLiteral(
            `Invariant ${invariant.id} violated: (assert ...) evaluated to false`,
        )});`,
    );
    lines.push(`${INDENT}Ok(())`);
    lines.push("}");
    return lines;
}

function renderCheckerArgs(args: readonly AstNode[], context: TranslationContext): string {
    if (args.length === 0) return "";
    const parts: string[] = [];
    for (const arg of args) {
        if (arg.kind !== "list" || arg.items.length !== 1) continue;
        const valueNode = arg.items[0]!;
        parts.push(`${translateNode(valueNode, context)}`);
    }
    return parts.join(", ");
}

function renderScenarioLiteral(scenario: ScenarioDeclaration): string {
    const items = scenario.steps.map((step) => {
        if (step.kind === "step") {
            return `[step_type: ${rustStringLiteral(step.kind)}, function: ${rustStringLiteral(step.call.target)}, args: Vec::new()]`;
        }
        return `[step_type: ${rustStringLiteral(step.kind)}, function: ${rustStringLiteral(step.capture)}, args: Vec::new()]`;
    });
    return `[${items.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Expression translation
// ---------------------------------------------------------------------------

function translateNode(node: AstNode, context: TranslationContext): string {
    if (node.kind === "number") {
        if (Number.isInteger(node.value)) {
            return `SteleValue::Int(${node.raw})`;
        }
        return `SteleValue::Float(SteleFloat(${node.raw}))`;
    }
    if (node.kind === "string") {
        return `SteleValue::Str(String::from(${rustStringLiteral(node.value)}))`;
    }
    if (node.kind === "keyword") {
        return `SteleValue::Str(String::from(${rustStringLiteral(`:${node.value}`)}))`;
    }
    if (node.kind === "identifier") {
        const binding = context.resolve(node.value);
        if (binding !== undefined) return binding;
        switch (node.value) {
            case "true": return "true";
            case "false": return "false";
            case "null":
            case "none": return "SteleValue::Null";
            default:
                throw new SteleError(
                    "E0602",
                    "Backend Error",
                    `Unsupported bare identifier "${node.value}" in Rust backend expression.`,
                    node.span,
                    "Wrap the value in a supported operator such as path or value.",
                    "Use (path identifier) or (value 5) instead of bare identifiers.",
                );
        }
    }

    const handler = OPERATOR_HANDLERS.get(node.head);
    if (handler === undefined) {
        throw new SteleError(
            "E0601",
            "Backend Error",
            `Unsupported Rust backend operator "${node.head}".`,
            node.span,
            "The Rust backend implements all Phase A/B/C operators plus EP04.",
            "Use a supported operator or check for typos.",
        );
    }
    return handler(node, context, (child) => translateNode(child, context));
}

// ---------------------------------------------------------------------------
// Operator handlers
// ---------------------------------------------------------------------------

type ExpressionTranslator = (node: AstNode, context: TranslationContext) => string;
type OperatorHandler = (node: ListNode, context: TranslationContext, translate: ExpressionTranslator) => string;

const OPERATOR_HANDLERS: Map<string, OperatorHandler> = new Map([
    // path access
    ["path", translatePath],
    ["field", translateField],
    ["collection", translateCollection],
    ["value", translateValue],

    // comparisons
    ...Array.from(COMPARISON_OPERATORS.keys()).map((op): [string, OperatorHandler] => [
        op,
        (node, ctx, t) => translateComparison(node, ctx, t, op),
    ]),

    // logic
    ["and", translateAnd],
    ["or", translateOr],
    ["not", translateNot],

    // arithmetic
    ["add", (n, c, t) => translateVariadicArithmetic(n, c, t, "add")],
    ["mul", (n, c, t) => translateVariadicArithmetic(n, c, t, "mul")],
    ["sub", (n, c, t) => translateBinaryArithmetic(n, c, t, "sub")],
    ["div", (n, c, t) => translateBinaryArithmetic(n, c, t, "div")],
    ["neg", (n, c, t) => translateUnaryArithmetic(n, c, t, "neg")],
    ["abs", (n, c, t) => translateUnaryArithmetic(n, c, t, "abs")],
    ["mod", (n, c, t) => translateBinaryArithmetic(n, c, t, "mod")],
    ["pow", (n, c, t) => translateBinaryArithmetic(n, c, t, "pow")],
    ["round", (n, c, t) => translateUnaryArithmetic(n, c, t, "round")],
    ["ceil", (n, c, t) => translateUnaryArithmetic(n, c, t, "ceil")],
    ["floor", (n, c, t) => translateUnaryArithmetic(n, c, t, "floor")],

    // aggregates
    ["sum", (n, c, t) => translateAggregateWithProjection(n, c, t, "sum")],
    ["count", translateCount],
    ["avg", (n, c, t) => translateAggregateWithProjection(n, c, t, "avg")],
    ["min", (n, c, t) => translateAggregateWithProjection(n, c, t, "min")],
    ["max", (n, c, t) => translateAggregateWithProjection(n, c, t, "max")],
    ["distinct", (n, c, t) => translateAggregateWithProjection(n, c, t, "distinct")],
    ["unique", translateUnique],
    ["has-length", translateHasLength],
    ["is-empty", translateIsEmpty],
    ["exists-in", translateExistsIn],
    // "in" is a semantic alias for "exists-in"
    ["in", translateIn],

    // string
    ["contains", (n, c, t) => translateBinaryString(n, c, t, "contains")],
    ["starts-with", (n, c, t) => translateBinaryString(n, c, t, "starts-with")],
    ["ends-with", (n, c, t) => translateBinaryString(n, c, t, "ends-with")],
    ["matches", (n, c, t) => translateBinaryString(n, c, t, "matches")],
    ["trim", (n, c, t) => translateUnaryString(n, c, t, "trim")],
    ["lower", (n, c, t) => translateUnaryString(n, c, t, "lower")],
    ["upper", (n, c, t) => translateUnaryString(n, c, t, "upper")],
    ["split", (n, c, t) => translateBinaryString(n, c, t, "split")],
    ["join", (n, c, t) => translateBinaryString(n, c, t, "join")],
    ["json-path", (n, c, t) => translateBinaryString(n, c, t, "json-path")],

    // control
    ["when", translateWhen],
    ["if", translateIf],
    ["implies", translateImpliesOp],
    ["iff", translateIff],
    ["not-null", translateNotNull],
    ["between", translateBetween],
    ["approx-eq", translateApproxEq],
    ["decimal-eq", translateDecimalEq],

    // quantifiers
    ["forall", (n, c, t) => translateQuantifier(n, c, t, "forall")],
    ["exists", (n, c, t) => translateQuantifier(n, c, t, "exists")],
    ["where", (n, c, t) => translateQuantifier(n, c, t, "where")],
    ["none", (n, c, t) => translateQuantifier(n, c, t, "none")],
    ["filter", (n, c, t) => translateQuantifier(n, c, t, "filter")],

    // temporal
    ["modified", translateModified],
    ["state-before", translateStateBefore],
    ["state-after", translateStateAfter],
    ["within", translateWithin],
    ["before", (n, c, t) => translateTemporalBinary(n, c, t, "before")],
    ["after", (n, c, t) => translateTemporalBinary(n, c, t, "after")],

    // EP04 collection
    ["length", translateLength],
    ["concat", translateConcat],
    ["sort-by", (n, c, t) => translateSortBy(n, c, t, false)],
    ["sort-by-desc", (n, c, t) => translateSortBy(n, c, t, true)],
    ["map", translateMap],
    ["first", translateFirst],
    ["last", translateLast],
    ["type-of", translateTypeOf],
]);

// ---------------------------------------------------------------------------
// Path & collection
// ---------------------------------------------------------------------------

function translatePath(node: ListNode, context: TranslationContext): string {
    if (node.items.length === 0) {
        throw new SteleError("E0603", "Backend Error", 'Operator "path" requires at least one segment.', node.span, "A path expression needs one or more symbol segments.", "Use (path account cash).");
    }

    const [root, ...rest] = node.items;
    if (root === undefined || (root.kind !== "identifier" && root.kind !== "keyword")) {
        throw new SteleError("E0603", "Backend Error", 'Operator "path" expects symbol-like path segments.', node.span, `Found ${root?.kind ?? "nothing"}.`, "Use identifiers or keywords for path parts.");
    }

    const rootKey = root.kind === "keyword" ? `:${root.value}` : root.value;
    const binding = root.kind === "identifier" ? context.resolve(root.value) : undefined;
    const segments = rest.map(readPathPart);

    if (binding !== undefined) {
        if (segments.length === 0) return binding;
        return `stele_get_path(${binding}, &[${segments.map(rustStringLiteral).join(", ")}])${context.inClosure ? "" : "?"}`;
    }
    return `stele_get_path(&${context.rootContextName}, &[${[rootKey, ...segments].map(rustStringLiteral).join(", ")}])${context.inClosure ? "" : "?"}`;
}

function translateCollection(node: ListNode, context: TranslationContext): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects exactly one identifier.', node.span, `Found ${node.items.length}.`, "Use (collection transactions).");
    }
    const target = node.items[0]!;
    if (target.kind !== "identifier") {
        throw new SteleError("E0603", "Backend Error", 'Operator "collection" expects an identifier.', node.span, `Found ${target.kind}.`, "Use (collection items).");
    }
    return `stele_get_path(&${context.rootContextName}, &[${rustStringLiteral(target.value)}])${context.inClosure ? "" : "?"}`;
}

/**
 * Translate `(field (path root ...) field_name)` to Rust path access.
 * Extends an existing path by appending one field segment.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function translateField(node: ListNode, context: TranslationContext, _translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "field" expects a path and a field name.', node.span, `Found ${node.items.length}.`, "Use (field (path account) cash).");
    }
    const pathNode = node.items[0]!;
    const fieldNode = node.items[1]!;
    if (pathNode.kind !== "list" || pathNode.head !== "path") {
        throw new SteleError("E0603", "Backend Error", 'Operator "field" expects its first argument to be a path expression.',
            pathNode.span ?? node.span, "The Rust backend extends existing path expressions by appending one field segment.",
            "Use (field (path account) cash).");
    }
    // Build an extended path node that includes the new field segment
    const extendedPath: ListNode = { kind: "list", head: "path", items: [...pathNode.items, fieldNode], span: node.span };
    return translatePath(extendedPath, context);
}

function translateValue(node: ListNode, _context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "value" expects exactly one operand.', node.span, `Found ${node.items.length}.`, "Pass a single value, e.g. (value 5).");
    }
    return translate(node.items[0]!, _context);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function translateComparison(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects two operands.`, node.span, `Found ${node.items.length}.`, "Pass two arguments, e.g. (eq (path foo) 5).");
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderComparison(operator, left, right, context.inClosure);
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

function translateAnd(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length === 0) {
        throw new SteleError("E0603", "Backend Error", 'Operator "and" requires at least one operand.', node.span, "Pass at least one predicate.", "Use (and (gt x 0)).");
    }
    const exprs = node.items.map((item) => translate(item, context));
    return renderAnd(exprs);
}

function translateOr(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length === 0) {
        throw new SteleError("E0603", "Backend Error", 'Operator "or" requires at least one operand.', node.span, "Pass at least one predicate.", "Use (or (eq x 1) (eq x 2)).");
    }
    const exprs = node.items.map((item) => translate(item, context));
    return renderOr(exprs);
}

function translateNot(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "not" expects exactly one operand.', node.span, `Found ${node.items.length}.`, "Pass a single predicate.");
    }
    return renderNot(translate(node.items[0]!, context));
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function translateVariadicArithmetic(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length < 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" requires at least two operands.`, node.span, `Found ${node.items.length}.`, `Use (${operator} 1 2).`);
    }
    const args = node.items.map((item) => translate(item, context));
    return renderVariadicArithmetic(operator, args, context.inClosure);
}

function translateBinaryArithmetic(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects two operands.`, node.span, `Found ${node.items.length}.`, `Use (${operator} a b).`);
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderBinaryArithmetic(operator, left, right, context.inClosure);
}

function translateUnaryArithmetic(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects one operand.`, node.span, `Found ${node.items.length}.`, `Use (${operator} x).`);
    }
    return renderUnaryArithmetic(operator, translate(node.items[0]!, context), context.inClosure);
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function translateAggregateWithProjection(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length < 1 || node.items.length > 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects one collection and optionally a path.`, node.span, `Found ${node.items.length}.`, `Use (${operator} (path items)) or (${operator} (path items) (path price)).`);
    }
    const collection = translate(node.items[0]!, context);
    if (node.items[1] === undefined) {
        return renderAggregate(operator, collection, undefined, context.inClosure);
    }
    const segments = readProjectionPath(node.items[1]!, operator);
    return renderAggregate(operator, collection, segments, context.inClosure);
}

function translateCount(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "count" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (count (path items)).");
    }
    return `stele_count(${translate(node.items[0]!, context)})`;
}

function translateUnique(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length < 1 || node.items.length > 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "unique" expects a collection and optionally a path.', node.span, `Found ${node.items.length}.`, "Use (unique (path items)) or (unique (path items) (path id)).");
    }
    const collection = translate(node.items[0]!, context);
    if (node.items[1] === undefined) {
        return `stele_unique(${collection}, &[${rustStringLiteral("")}])`;
    }
    const segments = readProjectionPath(node.items[1]!, "unique");
    return `stele_unique(${collection}, &[${segments.map(rustStringLiteral).join(", ")}])`;
}

function translateHasLength(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "has-length" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (has-length (path items) 3).");
    }
    const collection = translate(node.items[0]!, context);
    const length = translate(node.items[1]!, context);
    const tryOp = context.inClosure ? "" : "?";
    return `stele_has_length(${wrapSteleArg(collection)}, ${wrapSteleArg(length)})${tryOp}`;
}

function translateIsEmpty(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "is-empty" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (is-empty (path items)).");
    }
    return `stele_is_empty(${translate(node.items[0]!, context)})`;
}

function translateExistsIn(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "exists-in" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (exists-in (path id) (path ids)).");
    }
    const value = translate(node.items[0]!, context);
    const container = translate(node.items[1]!, context);
    return `stele_exists_in(${wrapSteleArg(value)}, ${wrapSteleArg(container)})`;
}

/**
 * Translate `(in value collection)` to Rust membership check.
 * Semantic alias for exists-in.
 */
function translateIn(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "in" expects two operands: a value and a collection.', node.span, `Found ${node.items.length}.`, "Use (in (path name) (path names)).");
    }
    const value = translate(node.items[0]!, context);
    const container = translate(node.items[1]!, context);
    return `stele_exists_in(${wrapSteleArg(value)}, ${wrapSteleArg(container)})`;
}

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

function translateBinaryString(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects two operands.`, node.span, `Found ${node.items.length}.`, `Use (${operator} a b).`);
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderBinaryStringOperator(operator, left, right, context.inClosure);
}

function translateUnaryString(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects one operand.`, node.span, `Found ${node.items.length}.`, `Use (${operator} (path foo)).`);
    }
    return renderUnaryStringOperator(operator, translate(node.items[0]!, context), context.inClosure);
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

function translateWhen(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "when" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (when cond body).");
    }
    const cond = translate(node.items[0]!, context);
    const body = translate(node.items[1]!, context);
    return renderWhen(cond, body);
}

function translateIf(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 3) {
        throw new SteleError("E0603", "Backend Error", 'Operator "if" expects three operands.', node.span, `Found ${node.items.length}.`, "Use (if cond then else).");
    }
    const cond = translate(node.items[0]!, context);
    const thenBranch = translate(node.items[1]!, context);
    const elseBranch = translate(node.items[2]!, context);
    return renderIf(cond, thenBranch, elseBranch);
}

function translateImpliesOp(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "implies" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (implies a b).");
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderImplies(left, right);
}

function translateIff(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "iff" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (iff a b).");
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderIff(left, right);
}

function translateNotNull(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "not-null" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (not-null (path foo)).");
    }
    return `stele_not_null(${wrapSteleArg(translate(node.items[0]!, context))})`;
}

function translateBetween(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 3) {
        throw new SteleError("E0603", "Backend Error", 'Operator "between" expects three operands.', node.span, `Found ${node.items.length}.`, "Use (between x 0 10).");
    }
    const value = translate(node.items[0]!, context);
    const low = translate(node.items[1]!, context);
    const high = translate(node.items[2]!, context);
    const tryOp = context.inClosure ? "" : "?";
    return `stele_between(${wrapSteleArg(value)}, ${wrapSteleArg(low)}, ${wrapSteleArg(high)})${tryOp}`;
}

function translateApproxEq(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 3) {
        throw new SteleError("E0603", "Backend Error", 'Operator "approx-eq" expects three operands.', node.span, `Found ${node.items.length}.`, "Use (approx-eq a b 1e-6).");
    }
    const a = translate(node.items[0]!, context);
    const b = translate(node.items[1]!, context);
    const tol = translate(node.items[2]!, context);
    const tryOp = context.inClosure ? "" : "?";
    return `stele_approx_eq(${wrapSteleArg(a)}, ${wrapSteleArg(b)}, ${wrapSteleArg(tol)})${tryOp}`;
}

function translateDecimalEq(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "decimal-eq" expects two operands.', node.span, `Found ${node.items.length}.`, "Use (decimal-eq a b).");
    }
    const a = translate(node.items[0]!, context);
    const b = translate(node.items[1]!, context);
    const tryOp = context.inClosure ? "" : "?";
    return `stele_decimal_eq(${wrapSteleArg(a)}, ${wrapSteleArg(b)})${tryOp}`;
}

// ---------------------------------------------------------------------------
// Quantifiers
// ---------------------------------------------------------------------------

function translateQuantifier(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 3) {
        throw new SteleError("E0603", "Backend Error", `Quantifier "${operator}" expects three operands: (binding collection predicate).`, node.span, `Found ${node.items.length}.`, `Use (${operator} item (collection items) (gt (path item value) 0)).`);
    }
    const binding = node.items[0]!;
    if (binding.kind !== "identifier") {
        throw new SteleError("E0603", "Backend Error", `Quantifier "${operator}" must bind an identifier.`, node.span, "The first argument names the element available inside the predicate.", `Use (${operator} item (collection items) ...).`);
    }
    const bound = context.bind(binding.value);
    const collection = translate(node.items[1]!, context);
    // Predicate runs inside a closure |item: &SteleValue| bool, so ? cannot be used.
    const predicateContext = bound.context.withClosure(true);
    const predicate = translate(node.items[2]!, predicateContext);
    const predicateSource = astToSource(node.items[2]!);
    return renderQuantifier(operator, collection, bound.name, predicate, predicateSource, context.testName);
}

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------

function translateModified(node: ListNode, context: TranslationContext): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "modified" expects one path operand.', node.span, `Found ${node.items.length}.`, "Use (modified (path account balance)).");
    }
    const segments = readModifiedPath(node.items[0]!, node);
    return renderModified(context.rootContextName, segments);
}

function translateStateBefore(node: ListNode, context: TranslationContext): string {
    if (node.items.length !== 0) {
        throw new SteleError("E0603", "Backend Error", 'Operator "state-before" takes no operands.', node.span, `Found ${node.items.length}.`, "Use (state-before).");
    }
    return renderStateBefore(context.rootContextName);
}

function translateStateAfter(node: ListNode, context: TranslationContext): string {
    if (node.items.length !== 0) {
        throw new SteleError("E0603", "Backend Error", 'Operator "state-after" takes no operands.', node.span, `Found ${node.items.length}.`, "Use (state-after).");
    }
    return renderStateAfter(context.rootContextName);
}

function translateWithin(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "within" expects an event and a duration.', node.span, `Found ${node.items.length}.`, "Use (within (path timestamp) 30).");
    }
    const event = translate(node.items[0]!, context);
    const duration = translate(node.items[1]!, context);
    return renderWithin(event, duration, context.inClosure);
}

function translateTemporalBinary(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, operator: string): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", `Operator "${operator}" expects two operands.`, node.span, `Found ${node.items.length}.`, `Use (${operator} a b).`);
    }
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return renderTemporalBinary(operator, left, right, context.inClosure);
}

// ---------------------------------------------------------------------------
// EP04 collection helpers
// ---------------------------------------------------------------------------

function translateLength(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "length" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (length (path items)).");
    }
    return renderLength(translate(node.items[0]!, context));
}

function translateConcat(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length < 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "concat" expects at least one collection.', node.span, `Found ${node.items.length}.`, "Use (concat (path a) (path b)).");
    }
    const args = node.items.map((item) => translate(item, context));
    return `stele_concat(&[${args.map((a) => `&${a}`).join(", ")}])`;
}

function translateSortBy(node: ListNode, context: TranslationContext, translate: ExpressionTranslator, descending: boolean): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "sort-by" expects a collection and a path.', node.span, `Found ${node.items.length}.`, "Use (sort-by (path items) (path price)).");
    }
    const collection = translate(node.items[0]!, context);
    const segments = readProjectionPath(node.items[1]!, "sort-by");
    return renderSortBy(collection, descending, segments);
}

function translateMap(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 2) {
        throw new SteleError("E0603", "Backend Error", 'Operator "map" expects a collection and a path.', node.span, `Found ${node.items.length}.`, "Use (map (path items) (path price)).");
    }
    const collection = translate(node.items[0]!, context);
    const segments = readProjectionPath(node.items[1]!, "map");
    return renderMap(collection, segments);
}

function translateFirst(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "first" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (first (path items)).");
    }
    return `stele_first(${translate(node.items[0]!, context)})`;
}

function translateLast(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "last" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (last (path items)).");
    }
    return `stele_last(${translate(node.items[0]!, context)})`;
}

function translateTypeOf(node: ListNode, context: TranslationContext, translate: ExpressionTranslator): string {
    if (node.items.length !== 1) {
        throw new SteleError("E0603", "Backend Error", 'Operator "type-of" expects one operand.', node.span, `Found ${node.items.length}.`, "Use (type-of (path foo)).");
    }
    return `stele_type_of(${translate(node.items[0]!, context)})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPathPart(node: AstNode): string {
    if (node.kind === "identifier") return node.value;
    if (node.kind === "keyword") return `:${node.value}`;
    throw new SteleError(
        "E0603", "Backend Error", "Path segments must be identifiers or keywords.",
        node.span, `Found ${node.kind}.`, "Replace with a symbol-like path part.",
    );
}

function readProjectionPath(node: AstNode, operator: string): string[] {
    if (node.kind !== "list" || node.head !== "path") {
        throw new SteleError(
            "E0603", "Backend Error", `Operator "${operator}" projections must use (path ...).`,
            node.span, "Rewrite as (path field-name).", "Use a path expression for projections.",
        );
    }
    if (node.items.length === 0) {
        throw new SteleError(
            "E0603", "Backend Error", `Operator "${operator}" projections require at least one segment.`,
            node.span, "Use at least one identifier segment.", "Use (path value).",
        );
    }
    return node.items.map(readPathPart);
}

function readModifiedPath(node: AstNode, owner: ListNode): string[] {
    if (node.kind !== "list" || node.head !== "path" || node.items.length === 0) {
        throw new SteleError(
            "E0603", "Backend Error", 'Operator "modified" expects one path expression.',
            node.span ?? owner.span, "Use (modified (path account balance)).",
            "Pass a (path ...) expression.",
        );
    }
    return node.items.map((part) => {
        if (part.kind === "identifier") return part.value;
        if (part.kind === "keyword") return `:${part.value}`;
        throw new SteleError("E0603", "Backend Error", "Modified path segments must be identifiers or keywords.", part.span, `Found ${part.kind}.`, "Use a symbol-like path part.");
    });
}

function rustStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function invariantToRustFnName(id: string): string {
    return sanitizeRustIdentifier(id, "invariant").toLowerCase();
}

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
    return (
        stableStringCompare(left.filePath, right.filePath) ||
        left.span.line - right.span.line ||
        left.span.column - right.span.column ||
        stableStringCompare(left.id, right.id)
    );
}

function allocateUniqueName(base: string, used: ReadonlySet<string>): string {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate) || RUST_RESERVED_WORDS.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix++;
    }
    return candidate;
}

function createTranslationContext(
    rootContextName = "ctx",
    testName = "",
    inClosure = false,
): TranslationContext {
    return createTranslationContextWithBindings(new Map(), new Set(), rootContextName, testName, inClosure);
}

function createTranslationContextWithBindings(
    bindings: Map<string, string>,
    usedNames: Set<string>,
    rootContextName: string,
    testName: string,
    inClosure: boolean,
): TranslationContext {
    return {
        bindings,
        rootContextName,
        usedNames,
        testName,
        inClosure,
        bind(identifier: string) {
            const name = allocateUniqueName(
                sanitizeRustIdentifier(identifier, "item"),
                usedNames,
            );
            const nextBindings = new Map(bindings);
            const nextUsedNames = new Set(usedNames);
            nextBindings.set(identifier, name);
            nextUsedNames.add(name);
            return {
                name,
                context: createTranslationContextWithBindings(nextBindings, nextUsedNames, rootContextName, testName, inClosure),
            };
        },
        resolve(identifier: string) {
            return bindings.get(identifier);
        },
        withClosure(newInClosure: boolean) {
            return createTranslationContextWithBindings(
                new Map(bindings),
                new Set(usedNames),
                rootContextName,
                testName,
                newInClosure,
            );
        },
    };
}
