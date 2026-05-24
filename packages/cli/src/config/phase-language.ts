import type { PhaseSupportedLanguage, SteleConfig } from "./defaults.js";

/**
 * Phase identifiers for per-phase language dispatch. Kebab-case
 * matches the corresponding CDL mechanism names (`(type-state …)`,
 * `(class-shape …)`) so that a user reading either side of the
 * boundary sees the same vocabulary.
 */
export type PhaseName =
  | "trace"
  | "type-state"
  | "effect"
  | "code-shape"
  | "architecture";

/**
 * Resolve the target language for a given phase. Returns the
 * per-phase override when set, else the config-wide targetLanguage.
 *
 * Phase 0 (self-dogfooding plan): this is the single point of
 * dispatch for Phase B (trace / type-state / effect), the
 * architecture stage, and the code-shape stage. Each consumer
 * passes its own `PhaseName` literal so the lookup is
 * type-checked at the call site.
 */
export function pickPhaseLanguage(
  config: SteleConfig,
  phase: PhaseName,
): PhaseSupportedLanguage {
  const override = config.phaseLanguages?.[phase];
  if (override !== undefined) return override;
  return config.targetLanguage as PhaseSupportedLanguage;
}
