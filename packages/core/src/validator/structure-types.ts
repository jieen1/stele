import type { AstNode, ListNode, SourceSpan, ParsedFile } from "../ast/types.js";
import type { TracePolicyDeclaration } from "./structure-trace-policy.js";
import type {
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
} from "./structure-type-state.js";
import type {
  EffectAnnotationDeclaration,
  EffectDeclarationsDeclaration,
  EffectPolicyDeclaration,
  EffectSuppressionDeclaration,
} from "./structure-effect.js";

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
  "architecture",
  "core-node",
  "branded-id",
  "smart-ctor",
  "trace-policy",
  "type-state",
  "type-state-binding",
  "effect-declarations",
  "effect-annotation",
  "effect-policy",
  "effect-suppression",
  "extern-alias",
]);

export type { TracePolicyDeclaration, TracePolicyExempt } from "./structure-trace-policy.js";
export type {
  TypeStateBindingDeclaration,
  TypeStateBindingParam,
  TypeStateDeclaration,
  TypeStateMapping,
  TypeStateTransition,
} from "./structure-type-state.js";

export type {
  EffectAnnotationDeclaration,
  EffectDeclarationsDeclaration,
  EffectName,
  EffectPolicyDeclaration,
  EffectSuppressionDeclaration,
} from "./structure-effect.js";

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

// Round 14 P1: code-shape declarations support typescript in addition
// to python. The CLI's code-shape evaluator dispatches on this field
// when picking the per-language analyzer.
export type CodeShapeLang = "python" | "typescript";

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
  /**
   * Closeout 3a (2026-05-25): explicit member enumeration for free-function
   * aggregate targets. When the class-shape target resolves to a module-level
   * function (not a class), `aggregateMembers` lists the exact sibling
   * function/variable names that belong to the aggregate. The evaluator's
   * required-method / required-field check is then scoped to this enumeration
   * — no implicit "all siblings" matching (M6 fix). For class targets the
   * field is ignored; for factory-mode targets the return type's members are
   * used and this field has no effect.
   */
  aggregateMembers: string[];
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

export type TypePolicyFieldRequirement = {
  fieldName: string;
  typeName: string;
  span: SourceSpan;
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
  requireFieldTypes: TypePolicyFieldRequirement[];
  ownerNameSuffixes: string[];
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

// -- Architecture declarations --

// Round 14 P2: architecture supports python in addition to typescript.
export type ArchitectureLang = "typescript" | "python";

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

// -- Branded-id and smart-ctor declarations (type-driven self-protection) --

export type BrandedIdDeclaration = {
  kind: "branded-id";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  target: string;
  baseType: string;
  pattern?: string;
  entityScope?: string;
};

export type SmartCtorDeclaration = {
  kind: "smart-ctor";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  constructorName: string;
  denyRaw: boolean;
  target?: string;
};

// -- Extern-alias declarations (cross-language symbol bridging, Round 3 P0-6) --

/**
 * `(extern-alias <logical-name> (typescript "<pkg>") (python "<pkg>") ...)`
 *
 * Logical names appear in trace / type-state / effect patterns as
 * `extern:<logical-name>::...`. The runtime `ExternAliasRegistry` resolves
 * the logical name to the per-language package id before pattern matching
 * the call graph.
 */
export type ExternAliasDeclaration = {
  kind: "extern-alias";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  /** Logical (cross-language) name — the `id` slot for uniqueness checks. */
  id: string;
  description?: string;
  typescript?: string;
  python?: string;
  go?: string;
  java?: string;
  rust?: string;
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
  architectures: ArchitectureDeclaration[];
  coreNodes: CoreNodeDeclaration[];
  brandedIds: BrandedIdDeclaration[];
  smartCtors: SmartCtorDeclaration[];
  tracePolicies: readonly TracePolicyDeclaration[];
  typeStates: readonly TypeStateDeclaration[];
  typeStateBindings: readonly TypeStateBindingDeclaration[];
  effectDeclarations: readonly EffectDeclarationsDeclaration[];
  effectAnnotations: readonly EffectAnnotationDeclaration[];
  effectPolicies: readonly EffectPolicyDeclaration[];
  effectSuppressions: readonly EffectSuppressionDeclaration[];
  externAliases: readonly ExternAliasDeclaration[];
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
  architectures: ArchitectureDeclaration[];
  coreNodes: CoreNodeDeclaration[];
  brandedIds: BrandedIdDeclaration[];
  smartCtors: SmartCtorDeclaration[];
  tracePolicies: readonly TracePolicyDeclaration[];
  typeStates: readonly TypeStateDeclaration[];
  typeStateBindings: readonly TypeStateBindingDeclaration[];
  effectDeclarations: readonly EffectDeclarationsDeclaration[];
  effectAnnotations: readonly EffectAnnotationDeclaration[];
  effectPolicies: readonly EffectPolicyDeclaration[];
  effectSuppressions: readonly EffectSuppressionDeclaration[];
  externAliases: readonly ExternAliasDeclaration[];
};
