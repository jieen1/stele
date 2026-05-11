/**
 * Comparison operator templates for Go backend.
 *
 * Maps CDL comparison operators to Go function calls in the runtime.
 * All operators dispatch to steleGt, steleGte, steleLt, steleLte, steleEq, steleNeq.
 */

export type ComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

const COMPARISON_MAP: Record<ComparisonOp, string> = {
  eq: "steleEq",
  neq: "steleNeq",
  gt: "steleGt",
  gte: "steleGte",
  lt: "steleLt",
  lte: "steleLte",
};

/**
 * Check if an operator is a comparison operator.
 */
export function isComparisonOp(op: string): op is ComparisonOp {
  return op in COMPARISON_MAP;
}

/**
 * Return the Go runtime function name for a comparison operator.
 */
export function goComparisonFunc(op: ComparisonOp): string {
  return COMPARISON_MAP[op];
}

/**
 * Emit a Go comparison expression.
 */
export function emitComparison(op: ComparisonOp, left: string, right: string): string {
  return `${goComparisonFunc(op)}(${left}, ${right})`;
}
