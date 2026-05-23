export {
  evaluateTracePolicies,
  type EvaluateTraceOptions,
  type EvaluateTraceResult,
  type EvaluateTraceStats,
} from "./evaluator.js";
export {
  enumeratePaths,
  getOrderedOutgoingEdges,
  type EnumeratedPath,
  type EnumerationResult,
  type EnumerationStats,
  type OutgoingCall,
} from "./path-enumeration.js";
export {
  checkMustTransit,
  checkDenyDirect,
  checkDenyTransit,
  checkMustBePrecededBy,
  checkMustBeFollowedBy,
} from "./constraint-checks.js";
export { annotateCrossRuleViolations } from "./cross-rule-dedup.js";
export {
  substituteFixHint,
  defaultFixHint,
  type FixHintContext,
} from "./fix-hint-substitution.js";
export {
  buildViolation,
  defaultPriority,
  type BuildViolationOptions,
} from "./violation-builder.js";
export type { TraceViolationKind } from "./types.js";
export { ALL_TRACE_VIOLATION_KINDS } from "./types.js";
