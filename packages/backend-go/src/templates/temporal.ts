/**
 * Temporal operator templates for Go backend.
 *
 * Maps CDL temporal operators to Go function calls in the runtime.
 */

export type TemporalOp = "modified" | "state-before" | "state-after" | "within" | "before" | "after";

const TEMPORAL_MAP: Record<TemporalOp, string> = {
  modified: "steleIsModified",
  "state-before": "steleStateBefore",
  "state-after": "steleStateAfter",
  within: "steleWithin",
  before: "steleBefore",
  after: "steleAfter",
};

/**
 * Check if an operator is a temporal operator.
 */
export function isTemporalOp(op: string): op is TemporalOp {
  return op in TEMPORAL_MAP;
}

/**
 * Return the Go runtime function name for a temporal operator.
 */
export function goTemporalFunc(op: TemporalOp): string {
  return TEMPORAL_MAP[op];
}

/**
 * Emit a Go temporal binary expression (before, after, within).
 */
export function emitTemporalBinary(op: "before" | "after" | "within", left: string, right: string): string {
  return `${goTemporalFunc(op)}(${left}, ${right})`;
}

/**
 * Emit a Go state-before expression.
 */
export function emitStateBefore(ctxName: string): string {
  return `steleStateBefore(${ctxName})`;
}

/**
 * Emit a Go state-after expression.
 */
export function emitStateAfter(ctxName: string): string {
  return `steleStateAfter(${ctxName})`;
}

/**
 * Emit a Go modified expression (takes context and path segments).
 */
export function emitModified(ctxName: string, pathSegments: readonly string[]): string {
  const segs = formatGoStringSlice(pathSegments);
  return `steleIsModified(${ctxName}, ${segs})`;
}

function formatGoStringSlice(segments: readonly string[]): string {
  return `[]string{${segments.map(goStringLiteral).join(", ")}}`;
}

function goStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
