/**
 * Internal types for the effect evaluator. Public API lives in
 * `evaluator.ts`, `effect-set.ts`, `trait.ts`, `violation-builder.ts`,
 * and `fix-hint.ts`.
 */

/**
 * Discriminated kinds reported as `effect.<policy_id>.<kind>` (or
 * `effect.unresolved_call_blocks_evaluation` for the policy-less D-CG-5
 * fail-closed result).
 */
export type EffectViolationKind =
  | "forbidden_effect"
  | "disallowed_effect"
  | "unresolved_call_blocks_evaluation"
  | "undeclared_effect_name";

export const ALL_EFFECT_VIOLATION_KINDS: readonly EffectViolationKind[] =
  Object.freeze([
    "forbidden_effect",
    "disallowed_effect",
    "unresolved_call_blocks_evaluation",
    "undeclared_effect_name",
  ] as const);

/**
 * Shape of the propagation evidence attached to a violation. Stored inside
 * `cause.detail` as a deterministic, line-separated rendering so the existing
 * `Violation` schema is preserved.
 *
 * Round 2 E-P0-3 requires a distinction between:
 *   - `directEffectsOnNode` — effects declared directly on this node
 *     (via CDL annotation OR a source-code `@stele:effects` tag)
 *   - `inheritedEffects` — effects pulled in via callees only
 *   - `propagationRootNodes` — the leaf nodes where the offending effect
 *     was originally declared
 *   - `propagationChain` — caller → ... → declarer (deterministic order)
 */
export interface PropagationEvidence {
  readonly offendingEffect: string;
  readonly directEffectsOnNode: readonly string[];
  readonly inheritedEffects: readonly string[];
  readonly propagationRootNodes: readonly string[];
  readonly propagationChain: readonly string[];
}
