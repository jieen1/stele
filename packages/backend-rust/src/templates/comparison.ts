import type { AstNode, ListNode } from "@stele/core";

/**
 * Wrap an argument for a &SteleValue parameter.
 * Simple identifiers (quantifier bindings like "item") are already &SteleValue.
 * Everything else needs & prefix.
 */
function wrapArg(expr: string): string {
    if (/^[a-z_]+$/.test(expr) && !expr.startsWith("stele_") && expr !== "ctx") {
        return expr;
    }
    return `&${expr}`;
}

/**
 * Map of CDL comparison operator names to their Rust runtime function calls.
 */
export const COMPARISON_OPERATORS: ReadonlyMap<string, string> = Object.freeze(
    new Map([
        ["eq", "stele_eq"],
        ["neq", "stele_neq"],
        ["gt", "stele_gt"],
        ["gte", "stele_gte"],
        ["lt", "stele_lt"],
        ["lte", "stele_lte"],
    ]),
);

/**
 * Generate a Rust comparison call: `stele_eq(&a, &b)?`
 * The `?` propagates the Result<bool, SteleRuntimeError> up to the test harness.
 * When inClosure is true, the `?` is omitted (closure bodies return bool).
 * Arguments are wrapped with & since runtime functions take &SteleValue.
 */
export function renderComparison(
    operator: string,
    left: string,
    right: string,
    inClosure = false,
): string {
    const fn = COMPARISON_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown comparison operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${wrapArg(left)}, ${wrapArg(right)})${tryOp}`;
}

/**
 * Check if a CDL operator is a comparison operator.
 */
export function isComparisonOperator(node: AstNode): boolean {
    return node.kind === "list" && COMPARISON_OPERATORS.has(node.head);
}
