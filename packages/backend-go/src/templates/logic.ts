/**
 * Logic operator templates for Go backend.
 *
 * Maps CDL logic operators to Go boolean expressions.
 * `and` -> &&, `or` -> ||, `not` -> !
 * These are emitted inline (not as function calls) because Go has native
 * boolean operators that are idiomatic and efficient.
 */

export type LogicOp = "and" | "or" | "not";

/**
 * Emit a Go `and` expression. Wraps each sub-expression in parens if needed.
 */
export function emitAnd(expressions: readonly string[]): string {
  return expressions.map(wrapBool).join(" && ");
}

/**
 * Emit a Go `or` expression. Wraps each sub-expression in parens if needed.
 */
export function emitOr(expressions: readonly string[]): string {
  return expressions.map(wrapBool).join(" || ");
}

/**
 * Emit a Go `not` expression. Wraps the sub-expression in parens.
 */
export function emitNot(expression: string): string {
  return `!${wrapBool(expression)}`;
}

/**
 * Emit a Go `implies` expression: !A || B
 */
export function emitImplies(left: string, right: string): string {
  return `!${wrapBool(left)} || ${wrapBool(right)}`;
}

/**
 * Emit a Go `iff` expression: A == B (both booleans)
 */
export function emitIff(left: string, right: string): string {
  return `${wrapBool(left)} == ${wrapBool(right)}`;
}

/**
 * Emit a Go `when` expression (lazy semantics): !cond || body
 */
export function emitWhen(condition: string, body: string): string {
  return `!${wrapBool(condition)} || ${wrapBool(body)}`;
}

/**
 * Wrap an expression in parens if it is not a simple identifier or function call.
 * Go requires parens around complex expressions in boolean contexts.
 */
function wrapBool(expr: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?$/.test(expr)) {
    return expr;
  }
  return `(${expr})`;
}
