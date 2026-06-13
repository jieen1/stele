// Re-exports from split modules.
// Each sub-module handles one declaration kind or shared helpers.

export {
  buildContract,
  collectImportDeclarations,
} from "./structure-parse.js";

export {
  parseInvariantDeclaration,
} from "./structure-invariant.js";

export {
  readSingleExpression as readSingleExpressionInvariant,
} from "./structure-shared.js";

export {
  parseScenarioDeclaration,
  parseScenarioSandbox,
  parseScenarioExecutor,
  parseScenarioStep,
  parseScenarioCaptureState,
  parseScenarioCall,
} from "./structure-scenario.js";

export {
  parseCodeShapeDeclaration,
  parseBoundaryDeclaration,
  parseClassShapeDeclaration,
  parseFunctionShapeDeclaration,
  parseTypePolicyDeclaration,
  parseFilePolicyDeclaration,
  parseClassShapeFieldRequirement,
  readCodeShapeStringList,
  readCodeShapeNameList,
} from "./structure-code-shape.js";

export { parseBrandedIdDeclaration } from "./structure-type-driven.js";

export {
  parseTracePolicyDeclaration,
  isFixHintActionable,
} from "./structure-trace-policy.js";

export {
  parseTypeStateDeclaration,
  parseTypeStateBindingDeclaration,
} from "./structure-type-state.js";

export {
  parseEffectAnnotationDeclaration,
  parseEffectDeclarationsDeclaration,
  parseEffectPolicyDeclaration,
  parseEffectSuppressionDeclaration,
} from "./structure-effect.js";

export {
  parseExternAliasDeclaration,
} from "./structure-extern-alias.js";


export {
  describeNode,
  validationError,
} from "./structure-error.js";

// -- all types live in structure-types.js --
export type {
  ArchitectureDeclaration,
  ArchitectureLang,
  ArchitectureModuleDeclaration,
  ArchitectureLayerDeclaration,
  ArchitectureAllowDependencyDeclaration,
  LoadedContractFile,
  MetadataDeclaration,
  ImportDeclaration,
  OperatorDeclaration,
  CheckerDeclaration,
  CheckerUse,
  ScenarioUse,
  InvariantDependency,
  InvariantSingleValueFieldName,
  InvariantSingleValueField,
  InvariantMultiValueField,
  InvariantDeclaration,
  GroupDeclaration,
  ScenarioSandbox,
  ScenarioExecutor,
  ScenarioCall,
  ScenarioStepDeclaration,
  ScenarioCaptureStateDeclaration,
  ScenarioOperation,
  ScenarioDeclaration,
  CodeShapeLang,
  BoundaryDeclaration,
  ClassShapeFieldRequirement,
  ClassShapeDeclaration,
  FunctionShapeDeclaration,
  TypePolicyDeclaration,
  FilePolicyDeclaration,
  CodeShapeDeclaration,
  ContractFile,
  Contract,
  CoreNodeDeclaration,
  CoreNodeMetricBoundary,
  CoreNodeMetricName,
  CoreNodeRole,
  BrandedIdDeclaration,
  TracePolicyDeclaration,
  TracePolicyExempt,
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
} from "./structure-types.js";

