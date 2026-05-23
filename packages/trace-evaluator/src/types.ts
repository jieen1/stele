/**
 * Internal types for the trace evaluator. Public API lives in `evaluator.ts`,
 * `path-enumeration.ts`, `cross-rule-dedup.ts`, `fix-hint-substitution.ts`, and
 * `violation-builder.ts`.
 */

/** Discriminated kinds reported as `trace.<id>.<kind>`. */
export type TraceViolationKind =
  | "missing_transit"
  | "missing_predecessor"
  | "missing_successor"
  | "direct_call_denied"
  | "forbidden_transit"
  | "path_exceeded_max_depth";

export const ALL_TRACE_VIOLATION_KINDS: readonly TraceViolationKind[] =
  Object.freeze([
    "missing_transit",
    "missing_predecessor",
    "missing_successor",
    "direct_call_denied",
    "forbidden_transit",
    "path_exceeded_max_depth",
  ] as const);
