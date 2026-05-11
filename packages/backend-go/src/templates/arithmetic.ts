/**
 * Arithmetic operator templates for Go backend.
 *
 * Maps CDL arithmetic operators to Go function calls in the runtime.
 */

export type VariadicArithOp = "add" | "mul";
export type BinaryArithOp = "sub" | "div" | "mod" | "pow";
export type UnaryArithOp = "neg" | "abs" | "ceil" | "floor";
export type ArithmeticOp = VariadicArithOp | BinaryArithOp | UnaryArithOp | "round";

const VARIADIC_ARITH_MAP: Record<VariadicArithOp, string> = {
  add: "steleAdd",
  mul: "steleMul",
};

const BINARY_ARITH_MAP: Record<BinaryArithOp, string> = {
  sub: "steleSub",
  div: "steleDiv",
  mod: "steleMod",
  pow: "stelePow",
};

const UNARY_ARITH_MAP: Record<UnaryArithOp, string> = {
  neg: "steleNeg",
  abs: "steleAbs",
  ceil: "steleCeil",
  floor: "steleFloor",
};

/**
 * Check if an operator is a variadic arithmetic operator.
 */
export function isVariadicArithOp(op: string): op is VariadicArithOp {
  return op in VARIADIC_ARITH_MAP;
}

/**
 * Check if an operator is a binary arithmetic operator.
 */
export function isBinaryArithOp(op: string): op is BinaryArithOp {
  return op in BINARY_ARITH_MAP;
}

/**
 * Check if an operator is a unary arithmetic operator.
 */
export function isUnaryArithOp(op: string): op is UnaryArithOp {
  return op in UNARY_ARITH_MAP;
}

/**
 * Emit a Go variadic arithmetic expression (add, mul).
 */
export function emitVariadicArith(op: VariadicArithOp, operands: readonly string[]): string {
  const fn = VARIADIC_ARITH_MAP[op];
  return `${fn}(${operands.join(", ")})`;
}

/**
 * Emit a Go binary arithmetic expression (sub, div, mod, pow).
 */
export function emitBinaryArith(op: BinaryArithOp, left: string, right: string): string {
  return `${BINARY_ARITH_MAP[op]}(${left}, ${right})`;
}

/**
 * Emit a Go unary arithmetic expression (neg, abs, ceil, floor).
 */
export function emitUnaryArith(op: UnaryArithOp, value: string): string {
  return `${UNARY_ARITH_MAP[op]}(${value})`;
}

/**
 * Emit a Go round expression (takes value, optional digits).
 */
export function emitRound(value: string, digits?: string): string {
  if (digits !== undefined) {
    return `steleRound(${value}, ${digits})`;
  }
  return `steleRound(${value})`;
}
