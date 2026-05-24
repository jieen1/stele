export type { AstNode, AtomNode, ListNode, SourceSpan, SteleType } from "./ast/types.js";
export type {
  BaselineViolation,
  CreateViolationBaselineOptions,
  FilterViolationReportOptions,
  HumanState,
  ViolationBaseline,
} from "./baseline/types.js";
export {
  createViolationBaseline,
  filterViolationReport,
} from "./baseline/types.js";
export {
  readViolationBaseline,
  tryReadViolationBaseline,
  writeViolationBaseline,
} from "./baseline/io.js";
export { SteleError } from "./errors/SteleError.js";
export type {
  ConformanceFixture,
  GeneratedFile,
  GeneratedVerificationFile,
  GeneratedVerificationResult,
  GeneratedVerificationStatus,
  GenerationConfig,
  LanguageBackend,
} from "./generator/coordinator.js";
export {
  coordinateGeneration,
  DEFAULT_GENERATED_OUTPUT_DIR,
  verifyGenerated,
} from "./generator/coordinator.js";
export { lex } from "./lexer/lexer.js";
export type { Token } from "./lexer/token.js";
export { loadContract, validateContract } from "./loader/load-contract.js";
export type {
  ContractManifest,
  ManifestProtectedFile,
  VerificationFileStatus,
  VerificationResult,
  VerifiedProtectedFile,
} from "./manifest/manifest.js";
export { verifyManifest, writeManifest } from "./manifest/manifest.js";
export type { Manifest, ManifestState, ManifestStateBrand } from "./manifest/lifecycle.js";
export { asLoaded, lockManifest, verifyLockedManifest } from "./manifest/lifecycle.js";
export type { FileEntry, HashManifest, ParsedFileLike } from "./manifest/hash-manifest.js";
export {
  buildTransitiveHash,
  deleteHashManifest,
  HASH_MANIFEST_RELATIVE_DIR,
  HASH_MANIFEST_RELATIVE_PATH,
  HASH_MANIFEST_VERSION,
  posixNormalize,
  readHashManifest,
  computeSha256 as hashManifestSha256,
  sha256OfFileOrNull,
  stripVolatileConfigFields,
  writeAtomic,
  writeHashManifest,
} from "./manifest/hash-manifest.js";
export { normalizeContract, normalizeFile } from "./normalizer/normalize.js";
export { parseFile } from "./parser/parser.js";
export type { ParsedFile } from "./parser/parser.js";
export {
  formatViolationReportHuman,
  formatViolationReportJson,
} from "./report/format.js";
export type {
  EffectViolationEvidence,
  ExplainTrace,
  FailureWitness,
  FailureWitnessOperator,
  Violation,
  ViolationCause,
  ViolationFix,
  ViolationInput,
  ViolationLocation,
  ContractNotice,
  ViolationPriority,
  ViolationReport,
  ViolationReportSummary,
  ViolationSeverity,
  ViolationStatus,
  ViolationSuppressionReason,
  ViolationSource,
} from "./report/types.js";
export {
  annotateCrossRuleViolations,
} from "./report/cross-rule.js";

export {
  buildFailureWitness,
  buildViolationFingerprint,
  createViolation,
  createViolationReport,
  safeSerialize,
  stableStringify,
} from "./report/types.js";
export {
  compareViolationsByPriority,
  priorityRank,
  severityRank,
  sortViolations,
} from "./report/sorting.js";
export type {
  OperatorParameterOccurrence,
  OperatorParameterSpec,
  OperatorRegistry,
  OperatorSpec,
} from "./registry/operators.js";
export { CORE_OPERATOR_SPECS, createCoreOperatorRegistry, createOperatorRegistry } from "./registry/operators.js";
export { DEFAULT_PROTECTED_PATTERNS } from "./config/defaults.js";
export { stableStringCompare, uniqueSortedStrings } from "./util/array.js";
export { sanitizeIdentifier } from "./util/identifier.js";
export {
  ruleId,
  contractPath,
  sha256 as sha256Branded,
  commandName,
  packageName,
  isRuleId,
  isContractPath,
  isSha256,
  isCommandName,
  isPackageName,
} from "./util/branded-types.js";
export type {
  RuleId,
  ContractPath,
  Sha256,
  CommandName,
  PackageName,
} from "./util/branded-types.js";
export {
  buildInvariantTrace,
  formatExplainTrace,
  invariantExplanation,
} from "./evaluator/explain.js";
export type {
  ArchitectureDeclaration,
  ArchitectureLang,
  ArchitectureModuleDeclaration,
  ArchitectureLayerDeclaration,
  ArchitectureAllowDependencyDeclaration,
  BoundaryDeclaration,
  BrandedIdDeclaration,
  CheckerDeclaration,
  CheckerUse,
  ClassShapeDeclaration,
  ClassShapeFieldRequirement,
  CodeShapeDeclaration,
  CodeShapeLang,
  Contract,
  ContractFile,
  CoreNodeDeclaration,
  CoreNodeMetricBoundary,
  CoreNodeMetricName,
  CoreNodeRole,
  SmartCtorDeclaration,
  FilePolicyDeclaration,
  FunctionShapeDeclaration,
  GroupDeclaration,
  ImportDeclaration,
  InvariantDeclaration,
  InvariantDependency,
  InvariantMultiValueField,
  InvariantSingleValueField,
  InvariantSingleValueFieldName,
  LoadedContractFile,
  MetadataDeclaration,
  OperatorDeclaration,
  ScenarioCall,
  ScenarioCaptureStateDeclaration,
  ScenarioDeclaration,
  ScenarioExecutor,
  ScenarioOperation,
  ScenarioSandbox,
  ScenarioStepDeclaration,
  ScenarioUse,
  TracePolicyDeclaration,
  TracePolicyExempt,
  TypePolicyDeclaration,
  TypeStateBindingDeclaration,
  TypeStateBindingParam,
  TypeStateDeclaration,
  TypeStateMapping,
  TypeStateTransition,
  EffectAnnotationDeclaration,
  EffectDeclarationsDeclaration,
  EffectName,
  EffectPolicyDeclaration,
  EffectSuppressionDeclaration,
  ExternAliasDeclaration,
} from "./validator/structure.js";

export {
  parseTracePolicyDeclaration,
  isFixHintActionable,
} from "./validator/structure.js";

export {
  parseTypeStateDeclaration,
  parseTypeStateBindingDeclaration,
} from "./validator/structure.js";

export {
  parseEffectAnnotationDeclaration,
  parseEffectDeclarationsDeclaration,
  parseEffectPolicyDeclaration,
  parseEffectSuppressionDeclaration,
} from "./validator/structure.js";

export { parseExternAliasDeclaration } from "./validator/structure.js";

