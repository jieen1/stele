export type { AstNode, AtomNode, ListNode, SourceSpan, SteleType } from "./ast/types.js";
export type {
  BaselineViolation,
  CreateViolationBaselineOptions,
  FilterViolationReportOptions,
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
export { loadContract, validateContract } from "./loader/loadContract.js";
export type {
  ContractManifest,
  ManifestProtectedFile,
  VerificationFileStatus,
  VerificationResult,
  VerifiedProtectedFile,
} from "./manifest/manifest.js";
export { verifyManifest, writeManifest } from "./manifest/manifest.js";
export type { FileEntry, HashManifest, ParsedFileLike } from "./manifest/hash-manifest.js";
export {
  buildTransitiveHash,
  deleteHashManifest,
  HASH_MANIFEST_RELATIVE_DIR,
  HASH_MANIFEST_RELATIVE_PATH,
  HASH_MANIFEST_VERSION,
  posixNormalize,
  readHashManifest,
  sha256 as hashManifestSha256,
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
  FailureWitness,
  FailureWitnessOperator,
  Violation,
  ViolationCause,
  ViolationFix,
  ViolationInput,
  ViolationLocation,
  ViolationReport,
  ViolationReportSummary,
  ViolationSeverity,
  ViolationStatus,
  ViolationSuppressionReason,
  ViolationSource,
} from "./report/types.js";
export {
  buildFailureWitness,
  buildViolationFingerprint,
  createViolation,
  createViolationReport,
  safeSerialize,
  stableStringify,
} from "./report/types.js";
export type {
  OperatorParameterOccurrence,
  OperatorParameterSpec,
  OperatorRegistry,
  OperatorSpec,
} from "./registry/operators.js";
export { CORE_OPERATOR_SPECS, createCoreOperatorRegistry, createOperatorRegistry } from "./registry/operators.js";
export { uniqueSortedStrings } from "./util/array.js";
export type {
  BoundaryDeclaration,
  CheckerDeclaration,
  CheckerUse,
  ClassShapeDeclaration,
  ClassShapeFieldRequirement,
  CodeShapeDeclaration,
  CodeShapeLang,
  Contract,
  ContractFile,
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
  TypePolicyDeclaration,
} from "./validator/structure.js";
