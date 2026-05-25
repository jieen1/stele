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
  buildWrongStateAtBindingViolation,
  defaultPriority,
  type BuildDisallowedOpOptions,
  type BuildInferenceFailedOptions,
  type BuildWrongStateAtBindingOptions,
} from "./violation-builder.js";

export {
  defaultDisallowedOpFixHint,
  defaultInferenceFailedFixHint,
  defaultWrongStateAtBindingFixHint,
  proposeExitText,
} from "./fix-hint.js";

export {
  ALL_TYPE_STATE_VIOLATION_KINDS,
  type InferenceSource,
  type TypeStateViolationKind,
} from "./types.js";
