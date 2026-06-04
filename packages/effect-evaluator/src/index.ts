export {
  evaluateEffects,
  type EvaluateEffectOptions,
  type EvaluateEffectResult,
  type EvaluateEffectStats,
  type EffectPolicyCoverage,
} from "./evaluator.js";

export type {
  EffectAnnotationExtractor,
  ExtractEffectAnnotationsOptions,
  ExtractEffectAnnotationsResult,
} from "./trait.js";

export {
  compileEffectPattern,
  differenceEffects,
  expandEffectPatterns,
  intersectEffects,
  isEffectGlob,
  isSubset,
  renderEffectSet,
  sortedSet,
  unionEffects,
} from "./effect-set.js";

export {
  buildPropagationChain,
  propagateEffects,
  reversePostorder,
  type PropagationInput,
  type PropagationResult,
} from "./propagation.js";

export {
  checkAllowOnly,
  checkForbid,
  resolveScopeNodes,
  type CheckAllowOnlyOptions,
  type CheckForbidOptions,
  type PolicyMatch,
} from "./policy-check.js";

export {
  applySuppressions,
  type ApplySuppressionsInput,
  type ApplySuppressionsResult,
} from "./suppression.js";

export {
  buildDisallowedEffectViolation,
  buildForbiddenEffectViolation,
  buildUnresolvedCallViolation,
  defaultPriority,
  type BuildDisallowedEffectOptions,
  type BuildForbiddenEffectOptions,
  type BuildUnresolvedCallOptions,
} from "./violation-builder.js";

export {
  defaultDisallowedEffectFixHint,
  defaultForbiddenEffectFixHint,
  defaultUnresolvedCallFixHint,
  proposeExitText,
} from "./fix-hint.js";

export {
  ALL_EFFECT_VIOLATION_KINDS,
  type EffectViolationKind,
  type PropagationEvidence,
} from "./types.js";
