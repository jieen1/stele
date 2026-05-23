export {
  evaluateTypeStates,
  type EvaluateTypeStateOptions,
  type EvaluateTypeStateResult,
  type EvaluateTypeStateStats,
} from "./evaluator.js";

export type {
  InferTypeStatesOptions,
  InferTypeStatesResult,
  InferredStateAtCallSite,
  TypeStateInferenceExtractor,
} from "./trait.js";

export {
  isTerminal,
  methodIsAllowedOp,
  methodIsTransition,
  methodTransitionsTo,
  reachableStates,
  unreachableStates,
} from "./state-machine.js";

export {
  buildDisallowedOpViolation,
  buildInferenceFailedViolation,
  defaultPriority,
  type BuildDisallowedOpOptions,
  type BuildInferenceFailedOptions,
} from "./violation-builder.js";

export {
  defaultDisallowedOpFixHint,
  defaultInferenceFailedFixHint,
  proposeExitText,
} from "./fix-hint.js";

export {
  ALL_TYPE_STATE_VIOLATION_KINDS,
  type InferenceSource,
  type TypeStateViolationKind,
} from "./types.js";
