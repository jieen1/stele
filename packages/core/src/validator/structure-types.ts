import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import type { ParsedFile } from "../parser/parser.js";

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
};
