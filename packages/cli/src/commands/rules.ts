import { resolve } from "node:path";
import { sanitizeIdentifier } from "@stele/core";
import {
  loadContract,
  type ArchitectureDeclaration,
  type BoundaryDeclaration,
  type ClassShapeDeclaration,
  type CodeShapeDeclaration,
  type CoreNodeDeclaration,
  type CoreNodeMetricBoundary,
  type FilePolicyDeclaration,
  type FunctionShapeDeclaration,
  type InvariantDeclaration,
  type ScenarioDeclaration,
  type TypePolicyDeclaration,
  type AstNode,
} from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";

import { compareInvariants, formatAstNode, toProjectRelativePath } from "../utils/shared-utils.js";



export type RulesOptions = {
  json?: boolean;
};

export type IndexedRule = {
  id: string;
  kind: "invariant";
  severity: string;
  description: string;
  category: string | null;
  tags: string[];
  file_path: string;
  line: number;
  column: number;
  generated_test_path: string;
  dependencies: string[];
  checker_id: string | null;
  scenario_id: string | null;
  rationale: string | null;
  applies_to: string | null;
  group_id: string | null;
};

export type IndexedScenario = {
  id: string;
  file_path: string;
  line: number;
  sandbox: string;
  executor: string;
  operations: string[];
};

export type IndexedCodeShape =
  | {
      id: string;
      kind: "boundary";
      file_path: string;
      line: number;
      lang: string;
      target: string;
      deny_imports: string[];
      deny_calls: string[];
      allow_targets: string[];
    }
  | {
      id: string;
      kind: "class-shape";
      file_path: string;
      line: number;
      lang: string;
      target: string;
      must_have_fields: Array<{ name: string; type: string | null }>;
      must_have_methods: string[];
      must_extend: string[];
    }
  | {
      id: string;
      kind: "function-shape";
      file_path: string;
      line: number;
      lang: string;
      target: string;
      must_have_calls: string[];
      must_have_decorators: string[];
      must_have_parameters: string[];
    }
  | {
      id: string;
      kind: "type-policy";
      file_path: string;
      line: number;
      lang: string;
      target: string;
      deny_types: string[];
      require_types: string[];
    }
  | {
      id: string;
      kind: "file-policy";
      file_path: string;
      line: number;
      lang: string;
      target: string;
      must_contain: string[];
      must_end_with: string[];
    };

export type IndexedArchitectureRule = {
  type: "architecture";
  architecture_id: string;
  rule: string;
  from: string;
  to: string[];
  allowed: string[];
  deny_cycles: boolean;
  file_path: string;
  line: number;
  modules: Array<{ id: string; paths: string[] }>;
};

export type IndexedCoreNode = {
  id: string;
  role: string;
  target: string;
  file_path: string;
  line: number;
  metrics: Array<{
    name: string;
    ideal: number;
    max: number;
  }>;
};

export type RuleIndex = {
  schema_version: "1";
  project_dir: string;
  entry: string;
  generated_dir: string;
  protected: string[];
  summary: {
    invariant_count: number;
    checker_count: number;
    scenario_count: number;
    code_shape_count: number;
    architecture_count: number;
    core_node_count: number;
  };
  rules: IndexedRule[];
  scenarios: IndexedScenario[];
  code_shapes: IndexedCodeShape[];
  architectures: IndexedArchitectureRule[];
  core_nodes: IndexedCoreNode[];
};

export async function runRules(projectDir: string, options: RulesOptions = {}): Promise<void> {
  const index = await buildRuleIndex(projectDir);

  process.stdout.write(options.json ? `${JSON.stringify(index, null, 2)}\n` : formatRuleIndexHuman(index));
}

export async function buildRuleIndex(projectDir: string): Promise<RuleIndex> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));

  return {
    schema_version: "1",
    project_dir: resolve(projectDir),
    entry: config.entry,
    generated_dir: config.generatedDir,
    protected: [...config.protected],
    summary: {
      invariant_count: contract.invariants.length,
      checker_count: contract.checkers.length,
      scenario_count: contract.scenarios.length,
      code_shape_count: contract.codeShapes.length,
      architecture_count: contract.architectures.length,
      core_node_count: contract.coreNodes.length,
    },
    rules: contract.invariants.slice().sort(compareInvariants).map((invariant) => indexInvariant(projectDir, config.generatedDir, invariant)),
    scenarios: contract.scenarios.slice().sort(compareInvariants).map((scenario) => indexScenario(projectDir, scenario)),
    code_shapes: contract.codeShapes.slice().sort(compareInvariants).map((shape) => indexCodeShape(projectDir, shape)),
    architectures: contract.architectures.map((arch) => indexArchitecture(projectDir, arch)),
    core_nodes: contract.coreNodes.map((node) => indexCoreNode(projectDir, node)),
  };
}

export function findIndexedRule(index: RuleIndex, id: string): IndexedRule | undefined {
  return index.rules.find((rule) => rule.id === id);
}

function indexInvariant(projectDir: string, generatedDir: string, invariant: InvariantDeclaration): IndexedRule {
  return {
    id: invariant.id,
    kind: "invariant",
    severity: invariant.severity,
    description: invariant.description,
    category: invariant.category === undefined ? null : formatAstNode(invariant.category.valueNode),
    tags: invariant.tags?.valueNodes.map(formatAstNode) ?? [],
    file_path: toProjectRelativePath(projectDir, invariant.filePath),
    line: invariant.span.line,
    column: invariant.span.column,
    generated_test_path:
      invariant.groupId === undefined
        ? `${generatedDir}/test_contract.py`
        : `${generatedDir}/test_${sanitizeIdentifier(invariant.groupId, "group")}.py`,
    dependencies: invariant.dependsOn.map((dependency) => dependency.id),
    checker_id: invariant.usesChecker?.checkerId ?? null,
    scenario_id: invariant.usesScenario?.scenarioId ?? null,
    rationale: invariant.rationale === undefined ? null : formatAstNode(invariant.rationale.valueNode),
    applies_to: invariant.appliesTo === undefined ? null : formatAstNode(invariant.appliesTo.valueNode),
    group_id: invariant.groupId ?? null,
  };
}

function indexScenario(projectDir: string, scenario: ScenarioDeclaration): IndexedScenario {
  return {
    id: scenario.id,
    file_path: toProjectRelativePath(projectDir, scenario.filePath),
    line: scenario.span.line,
    sandbox: scenario.sandbox,
    executor: scenario.executor,
    operations: scenario.steps.map((step) => (step.kind === "step" ? step.id : step.capture)),
  };
}

function indexCodeShape(projectDir: string, shape: CodeShapeDeclaration): IndexedCodeShape {
  const base = {
    id: shape.id,
    file_path: toProjectRelativePath(projectDir, shape.filePath),
    line: shape.span.line,
    lang: shape.lang,
    target: shape.target,
  };

  switch (shape.kind) {
    case "boundary":
      return indexBoundary(base, shape);
    case "class-shape":
      return indexClassShape(base, shape);
    case "function-shape":
      return indexFunctionShape(base, shape);
    case "type-policy":
      return indexTypePolicy(base, shape);
    case "file-policy":
      return indexFilePolicy(base, shape);
  }
}

function indexBoundary(
  base: Omit<Extract<IndexedCodeShape, { kind: "boundary" }>, "kind" | "deny_imports" | "deny_calls" | "allow_targets">,
  shape: BoundaryDeclaration,
): Extract<IndexedCodeShape, { kind: "boundary" }> {
  return {
    ...base,
    kind: "boundary",
    deny_imports: [...shape.denyImports],
    deny_calls: [...shape.denyCalls],
    allow_targets: [...shape.allowTargets],
  };
}

function indexClassShape(
  base: Omit<Extract<IndexedCodeShape, { kind: "class-shape" }>, "kind" | "must_have_fields" | "must_have_methods" | "must_extend">,
  shape: ClassShapeDeclaration,
): Extract<IndexedCodeShape, { kind: "class-shape" }> {
  return {
    ...base,
    kind: "class-shape",
    must_have_fields: shape.mustHaveFields.map((field) => ({ name: field.name, type: field.type ?? null })),
    must_have_methods: [...shape.mustHaveMethods],
    must_extend: [...shape.mustExtend],
  };
}

function indexFunctionShape(
  base: Omit<Extract<IndexedCodeShape, { kind: "function-shape" }>, "kind" | "must_have_calls" | "must_have_decorators" | "must_have_parameters">,
  shape: FunctionShapeDeclaration,
): Extract<IndexedCodeShape, { kind: "function-shape" }> {
  return {
    ...base,
    kind: "function-shape",
    must_have_calls: [...shape.mustHaveCalls],
    must_have_decorators: [...shape.mustHaveDecorators],
    must_have_parameters: [...shape.mustHaveParameters],
  };
}

function indexTypePolicy(
  base: Omit<Extract<IndexedCodeShape, { kind: "type-policy" }>, "kind" | "deny_types" | "require_types">,
  shape: TypePolicyDeclaration,
): Extract<IndexedCodeShape, { kind: "type-policy" }> {
  return {
    ...base,
    kind: "type-policy",
    deny_types: [...shape.denyTypes],
    require_types: [...shape.requireTypes],
  };
}

function indexFilePolicy(
  base: Omit<Extract<IndexedCodeShape, { kind: "file-policy" }>, "kind" | "must_contain" | "must_end_with">,
  shape: FilePolicyDeclaration,
): Extract<IndexedCodeShape, { kind: "file-policy" }> {
  return {
    ...base,
    kind: "file-policy",
    must_contain: [...shape.mustContain],
    must_end_with: [...shape.mustEndWith],
  };
}

function indexArchitecture(projectDir: string, arch: ArchitectureDeclaration): IndexedArchitectureRule {
  return {
    type: "architecture",
    architecture_id: arch.id,
    rule: "no-dependency",
    from: arch.modules.map((m) => m.id).join(", "),
    to: arch.allowDependencies.flatMap((d) => d.to),
    allowed: arch.allowDependencies.map((d) => `${d.from}->${d.to.join(",")}`),
    deny_cycles: arch.denyCycles,
    file_path: toProjectRelativePath(projectDir, arch.filePath),
    line: arch.span.line,
    modules: arch.modules.map((m) => ({ id: m.id, paths: m.paths })),
  };
}

function indexCoreNode(projectDir: string, node: CoreNodeDeclaration): IndexedCoreNode {
  return {
    id: node.id,
    role: node.role,
    target: node.target,
    file_path: toProjectRelativePath(projectDir, node.filePath),
    line: node.span.line,
    metrics: (node.metrics ?? []).map((m: CoreNodeMetricBoundary) => ({
      name: m.name,
      ideal: m.ideal,
      max: m.max,
    })),
  };
}

function formatRuleIndexHuman(index: RuleIndex): string {
  const lines = [
    `Stele rules: ${index.summary.invariant_count} invariants, ${index.summary.code_shape_count} code-shape rules, ${index.summary.scenario_count} scenarios, ${index.summary.architecture_count} architectures.`,
    "ID\tKind\tSeverity\tCategory\tFile",
    ...index.rules.map((rule) => [rule.id, rule.kind, rule.severity, rule.category ?? "<none>", `${rule.file_path}:${rule.line}`].join("\t")),
    ...index.code_shapes.map((shape) => [shape.id, shape.kind, "<none>", "<none>", `${shape.file_path}:${shape.line}`].join("\t")),
  ];

  return `${lines.join("\n")}\n`;
}

