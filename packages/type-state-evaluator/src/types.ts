/**
 * Internal types for the type-state evaluator. Public API lives in
 * `evaluator.ts`, `state-machine.ts`, `trait.ts`, `violation-builder.ts`,
 * and `fix-hint.ts`.
 */

/** Discriminated kinds reported as `typestate.<id>.<kind>`. */
export type TypeStateViolationKind =
  | "disallowed_op"
  | "inference_failed"
  | "wrong_state_at_binding";

export const ALL_TYPE_STATE_VIOLATION_KINDS: readonly TypeStateViolationKind[] =
  Object.freeze([
    "disallowed_op",
    "inference_failed",
    "wrong_state_at_binding",
  ] as const);

/**
 * Shape of the `inference_source` payload attached to a violation when state
 * inference produced a definite state. Stored inside `cause.detail` as a
 * deterministic, line-separated rendering so the existing `Violation` schema
 * is preserved (Round 2 E-P1-1: every violation must surface where the state
 * came from).
 */
export interface InferenceSource {
  readonly origin?: { readonly path: string; readonly line: number; readonly column: number };
  readonly reason?: string;
  readonly flowSteps: readonly string[];
}
