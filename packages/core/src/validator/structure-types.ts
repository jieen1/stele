import type { AstNode, ListNode, SourceSpan, ParsedFile } from "../ast/types.js";

export const TOP_LEVEL_DECLARATIONS = new Set([
  "metadata",
  "import",
  "operator",
  "checker",
  "group",
  "invariant",
  "scenario",
  "boundary",
  "class-shape",
  "function-shape",
  "type-policy",
  "file-policy",
  "agent",
  "scope",
  "inter-agent-contract",
  "conflict",
  "architecture",
  "core-node",
]);

export const ALLOWED_INVARIANT_FIELDS = new Set([
  "severity",
  "description",
  "assert",
  "uses-checker",
  "uses-scenario",
  "category",
  "tags",
  "when",
  "tolerance",
  "depends-on",
  "rationale",
  "since",
  "applies-to",
  "explain",
]);

export type LoadedContractFile = {
  path: string;
  parsed: ParsedFile;
};

export type MetadataDeclaration = {
  kind: "metadata";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  fields: AstNode[];
};

export type ImportDeclaration = {
  kind: "import";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  value: string;
  resolvedPath: string;
};

export type OperatorDeclaration = {
  kind: "operator";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
};

export type CheckerDeclaration = {
  kind: "checker";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
};

export type CheckerUse = {
  checkerId: string;
  span: SourceSpan;
  args: AstNode[];
  node: ListNode;
};

export type ScenarioUse = {
  scenarioId: string;
  span: SourceSpan;
  node: ListNode;
};

export type InvariantDependency = {
  id: string;
  span: SourceSpan;
};

export type InvariantSingleValueFieldName = "category" | "tolerance" | "rationale" | "since" | "applies-to" | "explain";

export type InvariantSingleValueField = {
  kind: "field";
  name: InvariantSingleValueFieldName;
  node: ListNode;
  span: SourceSpan;
  valueNode: AstNode;
};

/**
 * Generic single-value field that allows names beyond the invariant-specific set.
 * Used for agent declarations, inter-agent contracts, and other non-invariant contexts.
 */
export type AgentSingleValueField = {
  kind: "field";
  name: string;
  node: ListNode;
  span: SourceSpan;
  valueNode: AstNode;
};

export type InvariantMultiValueField = {
  kind: "field";
  name: "tags";
  node: ListNode;
  span: SourceSpan;
  valueNodes: AstNode[];
};

export type InvariantDeclaration = {
  kind: "invariant";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  groupId?: string;
  severity: string;
  description: string;
  assertExpression?: AstNode;
  usesChecker?: CheckerUse;
  usesScenario?: ScenarioUse;
  whenExpression?: AstNode;
  dependsOn: InvariantDependency[];
  category?: InvariantSingleValueField;
  tags?: InvariantMultiValueField;
  tolerance?: InvariantSingleValueField;
  rationale?: InvariantSingleValueField;
  since?: InvariantSingleValueField;
  appliesTo?: InvariantSingleValueField;
  explain?: InvariantSingleValueField;
};

export type GroupDeclaration = {
  kind: "group";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  description?: string;
  invariants: InvariantDeclaration[];
};

export type ScenarioSandbox = "transactional";

export type ScenarioExecutor = "python-import";

export type ScenarioCall = {
  node: ListNode;
  span: SourceSpan;
  target: string;
  body?: AstNode;
};

export type ScenarioStepDeclaration = {
  kind: "step";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  call: ScenarioCall;
  capture?: string;
};

export type ScenarioCaptureStateDeclaration = {
  kind: "capture-state";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  capture: string;
  call: ScenarioCall;
};

export type ScenarioOperation = ScenarioStepDeclaration | ScenarioCaptureStateDeclaration;

export type ScenarioDeclaration = {
  kind: "scenario";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  sandbox: ScenarioSandbox;
  executor: ScenarioExecutor;
  steps: ScenarioOperation[];
};

export type CodeShapeLang = "python";

export type BoundaryDeclaration = {
  kind: "boundary";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  denyImports: string[];
  denyCalls: string[];
  allowTargets: string[];
};

export type ClassShapeFieldRequirement = {
  name: string;
  type?: string;
  span: SourceSpan;
};

export type ClassShapeDeclaration = {
  kind: "class-shape";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustHaveFields: ClassShapeFieldRequirement[];
  mustHaveMethods: string[];
  mustExtend: string[];
};

export type FunctionShapeDeclaration = {
  kind: "function-shape";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustHaveCalls: string[];
  mustHaveDecorators: string[];
  mustHaveParameters: string[];
};

export type TypePolicyDeclaration = {
  kind: "type-policy";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  denyTypes: string[];
  requireTypes: string[];
};

export type FilePolicyDeclaration = {
  kind: "file-policy";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustContain: string[];
  mustEndWith: string[];
};

export type CodeShapeDeclaration =
  | BoundaryDeclaration
  | ClassShapeDeclaration
  | FunctionShapeDeclaration
  | TypePolicyDeclaration
  | FilePolicyDeclaration;

// -- Agent policy declarations --

/**
 * Agent identity declaration. Declares an agent's name, description, allowed paths, and denied paths.
 */
export type AgentDeclaration = {
  kind: "agent";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  description?: AgentSingleValueField;
  allowedPaths: string[];
  deniedPaths: string[];
};

/**
 * Scope declaration. Assigns path ownership to an agent.
 */
export type ScopeDeclaration = {
  kind: "scope";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  agentId: string;
  paths: string[];
};

/**
 * Inter-agent contract. Cross-agent rules about approvals and dependencies.
 */
export type InterAgentContractDeclaration = {
  kind: "inter-agent-contract";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  agents: string[];
  requires: RequiresClause[];
  description?: AgentSingleValueField;
};

/**
 * A single requirement within an inter-agent contract.
 * Example: (requires "reviewer" (path "src/**") approved-by "reviewer")
 */
export type RequiresClause = {
  agentId: string;
  pathPattern: string;
  approvedBy: string;
  span: SourceSpan;
};

/**
 * Conflict resolution strategy.
 */
export type ConflictResolutionStrategy = "last-writer-wins" | "manual-review" | "merge-strategy" | "contract-gated";

/**
 * Conflict declaration. Defines how to resolve conflicts when multiple agents edit the same path.
 */
export type ConflictDeclaration = {
  kind: "conflict";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  path: string;
  agents: string[];
  resolution: ConflictResolutionStrategy;
  fallback?: ConflictResolutionStrategy;
};

/**
 * All agent-related declarations.
 */
export type AgentDeclarationKind = AgentDeclaration | ScopeDeclaration | InterAgentContractDeclaration | ConflictDeclaration;

// -- Architecture declarations --

export type ArchitectureLang = "typescript";

export type ArchitectureModuleDeclaration = {
  id: string;
  paths: string[];
  publicEntries: string[];
  span: SourceSpan;
};

export type ArchitectureLayerDeclaration = {
  id: string;
  modules: string[];
  span: SourceSpan;
};

export type ArchitectureAllowDependencyDeclaration = {
  from: string;
  to: string[];
  span: SourceSpan;
};

export type ArchitectureDeclaration = {
  kind: "architecture";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: ArchitectureLang;
  tsconfig?: string;
  description?: string;
  modules: ArchitectureModuleDeclaration[];
  layers: ArchitectureLayerDeclaration[];
  allowDependencies: ArchitectureAllowDependencyDeclaration[];
  denyCycles: boolean;
  fix?: string;
};

// -- Core-node declarations --

export type CoreNodeRole = "business-core-service";

export type CoreNodeMetricName = "sloc" | "public-method-count" | "max-cyclomatic" | "missing-target";

export type CoreNodeMetricBoundary = {
  name: CoreNodeMetricName;
  ideal: number;
  max: number;
};

export type CoreNodeDeclaration = {
  kind: "core-node";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: "typescript";
  role: CoreNodeRole;
  target: string;
  description?: string;
  rationale?: string;
  metrics: CoreNodeMetricBoundary[];
};

export type ContractFile = {
  path: string;
  parsed: ParsedFile;
  metadata?: MetadataDeclaration;
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  scenarios: ScenarioDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
  codeShapes: CodeShapeDeclaration[];
  agents: AgentDeclaration[];
  scopes: ScopeDeclaration[];
  interAgentContracts: InterAgentContractDeclaration[];
  conflicts: ConflictDeclaration[];
  architectures: ArchitectureDeclaration[];
  coreNodes: CoreNodeDeclaration[];
};

export type ContractWarning = {
  type: "path-overlap";
  agentId: string;
  overlaps: string[];
};

export type Contract = {
  rootPath: string;
  files: ContractFile[];
  metadata: MetadataDeclaration[];
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  scenarios: ScenarioDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
  codeShapes: CodeShapeDeclaration[];
  agents: AgentDeclaration[];
  scopes: ScopeDeclaration[];
  interAgentContracts: InterAgentContractDeclaration[];
  conflicts: ConflictDeclaration[];
  architectures: ArchitectureDeclaration[];
  coreNodes: CoreNodeDeclaration[];
  warnings: ContractWarning[];
};
