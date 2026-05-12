/**
 * String operator templates for Go backend.
 *
 * Maps CDL string operators to Go function calls in the runtime.
 */

export type StringOp =
  | "contains"
  | "starts-with"
  | "ends-with"
  | "matches"
  | "trim"
  | "lower"
  | "upper"
  | "split"
  | "join"
  | "json-path";

const STRING_MAP: Record<StringOp, string> = {
  contains: "steleContains",
  "starts-with": "steleStartsWith",
  "ends-with": "steleEndsWith",
  matches: "steleMatches",
  trim: "steleTrim",
  lower: "steleLower",
  upper: "steleUpper",
  split: "steleSplit",
  join: "steleJoin",
  "json-path": "steleJsonPath",
};

/**
 * Check if an operator is a string operator.
 */
export function isStringOp(op: string): op is StringOp {
  return op in STRING_MAP;
}

/**
 * Return the Go runtime function name for a string operator.
 */
export function goStringFunc(op: StringOp): string {
  return STRING_MAP[op];
}

/**
 * Emit a Go string binary expression (contains, starts-with, ends-with, matches, split, join).
 */
export function emitStringBinary(op: StringOp, left: string, right: string): string {
  return `${goStringFunc(op)}(${left}, ${right})`;
}

/**
 * Emit a Go string unary expression (trim, lower, upper).
 */
export function emitStringUnary(op: StringOp, value: string): string {
  return `${goStringFunc(op)}(${value})`;
}
