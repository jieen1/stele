// Re-exports from split modules.
// Each sub-module handles one declaration kind or shared helpers.

export {
  buildContract,
  collectImportDeclarations,
} from "./structure-parse.js";

export {
  parseInvariantDeclaration,
  readSingleExpression as readSingleExpressionInvariant,
} from "./structure-invariant.js";

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

export {
  parseAgentDeclaration,
  parseScopeDeclaration,
  parseInterAgentContractDeclaration,
  parseConflictDeclaration,
} from "./structure-agent.js";


export {
  describeNode,
  validationError,
} from "./structure-error.js";

// -- all types live in structure-types.js --
export type {
  AgentDeclaration,
  AgentSingleValueField,
  ArchitectureDeclaration,
  ArchitectureLang,
  ArchitectureModuleDeclaration,
  ArchitectureLayerDeclaration,
  ArchitectureAllowDependencyDeclaration,
  ConflictDeclaration,
  ConflictResolutionStrategy,
  InterAgentContractDeclaration,
  RequiresClause,
  ScopeDeclaration,
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
} from "./structure-types.js";

