import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  buildInvariantTrace,
  formatExplainTrace,
  invariantExplanation,
  loadContract,
  sanitizeIdentifier,
  type ArchitectureDeclaration,
  type Contract,
  type InvariantDeclaration,
  type SourceSpan,
} from "@stele/core";
import {
  applySuppressions,
  buildPropagationChain,
  propagateEffects,
  type EffectAnnotationExtractor,
} from "@stele/effect-evaluator";
import { tsCallGraphExtractor } from "@stele/backend-typescript";
import {
  compilePattern,
  type CallGraph,
  type CallGraphEdge,
  type CallGraphNode,
  type CompiledPattern,
} from "@stele/call-graph-core";
import { loadConfig } from "../config/loadConfig.js";
import { profilePathExists, loadProfile } from "../design-profile/load.js";
import { buildRuleIndex, findIndexedRule } from "./rules.js";
import { formatAstNode, toProjectRelativePath } from "../utils/shared-utils.js";
import {
  formatDesignOriginLines,
  buildDesignOriginJson,
  resolveDesignOrigin,
} from "./design-origin.js";

export type ExplainOptions = {
  json?: boolean;
};

export async function runExplain(projectDir: string, invariantId: string, options: ExplainOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));

  // Check for architecture:<arch-id> syntax
  if (invariantId.startsWith("architecture:")) {
    const archId = invariantId.slice("architecture:".length);
    const architecture = contract.architectures.find((candidate) => candidate.id === archId);

    if (architecture === undefined) {
      throw new Error(`Architecture "${archId}" was not found in the loaded contract.`);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildArchitectureExplainJson(architecture, projectDir), null, 2)}\n`);
      return;
    }

    process.stdout.write(formatArchitectureExplain(architecture, projectDir));
    return;
  }

  const invariant = contract.invariants.find((candidate) => candidate.id === invariantId);

  if (invariant === undefined) {
    throw new Error(`Invariant "${invariantId}" was not found in the loaded contract.`);
  }

  const source = await getInvariantSource(invariant);
  const explanation = invariantExplanation(invariant);
  const designOrigin = resolveDesignOrigin(projectDir, invariant.id);

  if (options.json) {
    const index = await buildRuleIndex(projectDir);
    const rule = findIndexedRule(index, invariant.id);

    const jsonBody: Record<string, unknown> = { rule, source, explanation };
    if (designOrigin !== null) {
      jsonBody.design_origin = buildDesignOriginJson(designOrigin);
    }
    process.stdout.write(`${JSON.stringify(jsonBody, null, 2)}\n`);
    return;
  }

  const generatedTestPath =
    invariant.groupId === undefined
      ? posix.join(config.generatedDir, "test_contract.py")
      : posix.join(config.generatedDir, `test_${sanitizeIdentifier(invariant.groupId, "group")}.py`);

  const trace = buildInvariantTrace(invariant, null);

  const lines = [
    `ID: ${invariant.id}`,
    `File Path: ${toProjectRelativePath(projectDir, invariant.filePath)}`,
    `Generated Test Path: ${generatedTestPath}`,
    `Dependencies: ${invariant.dependsOn.length === 0 ? "<none>" : invariant.dependsOn.map((dependency) => dependency.id).join(", ")}`,
    `Rationale: ${invariant.rationale === undefined ? "<none>" : formatAstNode(invariant.rationale.valueNode)}`,
    `Checker ID: ${invariant.usesChecker?.checkerId ?? "<none>"}`,
    `Explanation: ${explanation ?? "<none>"}`,
    "",
    "## Expression Trace",
    ...formatExplainTrace(trace),
    "",
    "## Source",
    source,
  ];

  if (designOrigin !== null) {
    lines.push("", "## Design Origin", ...formatDesignOriginLines(designOrigin));
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function getInvariantSource(invariant: InvariantDeclaration): Promise<string> {
  const fileContents = await readFile(invariant.filePath, "utf8");
  return extractSourceFromSpan(fileContents, invariant.span) ?? formatAstNode(invariant.node);
}

function extractSourceFromSpan(source: string, span: SourceSpan): string | undefined {
  const start = offsetForSpan(source, span);
  let cursor = start;

  while (cursor < source.length && /\s/.test(source[cursor]!)) {
    cursor += 1;
  }

  if (source[cursor] !== "(") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let inComment = false;
  let escaping = false;

  for (let index = cursor; index < source.length; index += 1) {
    const character = source[index]!;

    if (inComment) {
      if (character === "\n") {
        inComment = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (character === "\\") {
        escaping = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === ";") {
      inComment = true;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(cursor, index + 1);
      }
    }
  }

  return undefined;
}

function offsetForSpan(source: string, span: SourceSpan): number {
  const lineOffsets = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineOffsets.push(index + 1);
    }
  }

  const lineOffset = lineOffsets[span.line - 1];

  if (lineOffset === undefined) {
    throw new Error(`Could not resolve source span line ${span.line} in ${span.file}.`);
  }

  return lineOffset + Math.max(span.column - 1, 0);
}

// ----------------------------------------------------------------
// Architecture explain
// ----------------------------------------------------------------

function formatArchitectureExplain(arch: ArchitectureDeclaration, projectDir: string): string {
  const lines = [
    `Architecture: ${arch.id}`,
    `Language: ${arch.lang}`,
    `Description: ${arch.description ?? "<none>"}`,
    `Deny cycles: ${arch.denyCycles}`,
    `Fix: ${arch.fix ?? "<none>"}`,
    "",
    "## Modules",
    ...arch.modules.map((mod) => `- ${mod.id}: ${mod.paths.join(", ")}`),
    "",
    "## Allowed dependencies",
  ];

  if (arch.allowDependencies.length === 0) {
    lines.push("- <none>");
  } else {
    for (const dep of arch.allowDependencies) {
      lines.push(`- ${dep.from} -> ${dep.to.join(", ")}`);
    }
  }

  if (arch.layers.length > 0) {
    lines.push("", "## Layers", ...arch.layers.map((layer) => `- ${layer.id}: ${layer.modules.join(", ")}`));
  }

  const origin = resolveDesignOrigin(projectDir, arch.id);
  if (origin !== null) {
    lines.push("", "## Design Origin", ...formatDesignOriginLines(origin));
  }

  return `${lines.join("\n")}\n`;
}

function buildArchitectureExplainJson(arch: ArchitectureDeclaration, projectDir: string): Record<string, unknown> {
  const origin = resolveDesignOrigin(projectDir, arch.id);
  const body: Record<string, unknown> = {
    schema_version: "1",
    tool: "@stele/cli",
    command: "explain",
    type: "architecture",
    architecture_id: arch.id,
    language: arch.lang,
    description: arch.description ?? null,
    deny_cycles: arch.denyCycles,
    fix: arch.fix ?? null,
    tsconfig: arch.tsconfig ?? null,
    file_path: toProjectRelativePath(projectDir, arch.filePath),
    line: arch.span.line,
    modules: arch.modules.map((mod) => ({ id: mod.id, paths: mod.paths, public_entries: mod.publicEntries })),
    layers: arch.layers.map((layer) => ({ id: layer.id, modules: layer.modules })),
    allow_dependencies: arch.allowDependencies.map((dep) => ({ from: dep.from, to: dep.to })),
  };
  if (origin !== null) {
    body.design_origin = buildDesignOriginJson(origin);
  }
  return body;
}

// ----------------------------------------------------------------
// Effect inspection — `stele explain effect <node-id>`
// ----------------------------------------------------------------
//
// Round 2 reviewer E P-2-3 + Round 2 synthesis E-P2-3: when a violation
// report collapses the propagation chain at the depth cap, agents need a
// way to drill into a node's full chain. This subcommand is the answer.
//
// We deliberately re-run propagation here (instead of consuming the last
// check report) because the agent may want to inspect a node that did NOT
// trigger a policy violation but whose effects matter for design review.

export type ExplainEffectOptions = {
  json?: boolean;
  noCache?: boolean;
};

export interface ExplainEffectResult {
  exitCode: number;
  output: string;
}

export interface ExplainEffectDeps {
  readonly extractCallGraph?: (options: {
    projectRoot: string;
    tsconfigPath: string | undefined;
    cacheDir: string | undefined;
  }) => Promise<CallGraph>;
  readonly extractor?: EffectAnnotationExtractor;
}

export async function runExplainEffect(
  projectDir: string,
  nodeId: string,
  options: ExplainEffectOptions = {},
  deps: ExplainEffectDeps = {},
): Promise<ExplainEffectResult> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));

  const language = config.targetLanguage;
  if (language !== "typescript") {
    const diagnostic =
      `stele explain effect supports targetLanguage="typescript" only; project targets "${language}".\n` +
      `Phase B.1 covers TypeScript; other languages land in later milestones.\n`;
    if (options.json === true) {
      return {
        exitCode: 2,
        output: `${JSON.stringify(
          { schema_version: "1", error: "unsupported_language", language },
          null,
          2,
        )}\n`,
      };
    }
    return { exitCode: 2, output: diagnostic };
  }

  const tsconfigPath = resolveTsconfigPath(projectDir);

  const extractCallGraph =
    deps.extractCallGraph ??
    (async (extractOptions): Promise<CallGraph> =>
      tsCallGraphExtractor.extract({
        projectRoot: extractOptions.projectRoot,
        tsconfigPath: extractOptions.tsconfigPath,
        cacheDir: extractOptions.cacheDir,
      }));

  const cacheDir =
    options.noCache === true ? undefined : resolve(projectDir, "contract/.cache");
  let callGraph: CallGraph;
  try {
    callGraph = await extractCallGraph({
      projectRoot: projectDir,
      tsconfigPath,
      cacheDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = `Call graph extraction failed: ${message}\n`;
    if (options.json === true) {
      return {
        exitCode: 2,
        output: `${JSON.stringify(
          { schema_version: "1", error: "extraction_failed", message },
          null,
          2,
        )}\n`,
      };
    }
    return { exitCode: 2, output: diagnostic };
  }

  const node = callGraph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    const suggestions = suggestNearbyNodes(callGraph, nodeId);
    if (options.json === true) {
      return {
        exitCode: 2,
        output: `${JSON.stringify(
          {
            schema_version: "1",
            error: "node_not_found",
            node_id: nodeId,
            suggestions,
          },
          null,
          2,
        )}\n`,
      };
    }
    const lines = [
      `Node "${nodeId}" was not found in the project's call graph.`,
      "Run `stele check` to refresh, or re-extract with `--no-cache`.",
    ];
    if (suggestions.length > 0) {
      lines.push("", "Did you mean:");
      for (const id of suggestions) {
        lines.push(`  - ${id}`);
      }
    }
    return { exitCode: 2, output: `${lines.join("\n")}\n` };
  }

  const inspection = inspectEffectNode(contract, callGraph, node);

  if (options.json === true) {
    return {
      exitCode: 0,
      output: `${JSON.stringify(buildEffectExplainJson(inspection), null, 2)}\n`,
    };
  }

  return { exitCode: 0, output: formatEffectExplainHuman(inspection) };
}

interface PolicyInScope {
  readonly id: string;
  readonly kind: "forbid" | "allow-only";
  readonly effects: readonly string[];
  readonly severity: "error" | "warning";
  readonly violationCount: number;
}

interface SuppressionInScope {
  readonly target: string;
  readonly suppresses: readonly string[];
  readonly reason: string;
  readonly severity: "warning" | "error";
}

interface PropagationChainStep {
  readonly nodeId: string;
  readonly line: number;
  readonly column: number;
  readonly tags: readonly string[];
}

interface EffectInspection {
  readonly node: CallGraphNode;
  readonly directEffects: readonly string[];
  readonly effectiveEffects: readonly string[];
  readonly inheritedEffects: readonly string[];
  readonly propagationChains: ReadonlyMap<string, readonly PropagationChainStep[]>;
  readonly policies: readonly PolicyInScope[];
  readonly suppressions: readonly SuppressionInScope[];
  readonly noPolicies: boolean;
}

function inspectEffectNode(
  contract: Contract,
  callGraph: CallGraph,
  node: CallGraphNode,
): EffectInspection {
  // Mirror evaluator's setup so direct/effective sets match what `stele
  // check` would report. We intentionally skip the strict-mode D-CG-5
  // widening because explain is read-only inspection — surfacing the raw
  // propagation result is more useful than the fail-closed view.
  const declaredEffects = flattenDeclaredEffects(contract);
  // Source-code annotations are already merged onto CallGraphNode.effects
  // by the extractor; the explainer reads them off the nodes directly
  // inside `buildInitialEffects`. We pass an empty map for the per-language
  // override channel rather than re-running the annotation extractor
  // (avoid the extra async pass — inspection is read-only).
  const annotationsByNode = new Map<string, readonly string[]>();
  const initialEffectsByNode = buildInitialEffects(contract, callGraph, annotationsByNode);

  const callGraphNodeIds = new Set<string>();
  for (const n of callGraph.nodes) {
    callGraphNodeIds.add(n.id);
  }
  const suppressionResult = applySuppressions({
    initialEffectsByNode,
    suppressions: contract.effectSuppressions,
    declaredEffects,
    callGraphNodeIds,
  });

  const propagation = propagateEffects({
    callGraph,
    initialEffectsByNode: suppressionResult.initialEffectsByNode,
    suppressionsByNode: suppressionResult.suppressionsByNode,
  });

  const direct = propagation.directByNode.get(node.id) ?? new Set<string>();
  const effective = propagation.effectiveByNode.get(node.id) ?? new Set<string>();
  const inherited = propagation.inheritedByNode.get(node.id) ?? new Set<string>();

  const propagationChains = new Map<string, readonly PropagationChainStep[]>();
  for (const effect of inherited) {
    const chain = buildPropagationChain(
      callGraph,
      node.id,
      effect,
      propagation.effectiveByNode,
      propagation.directByNode,
    );
    propagationChains.set(effect, buildChainSteps(callGraph, chain, effect, propagation.directByNode));
  }
  for (const effect of direct) {
    if (!propagationChains.has(effect)) {
      propagationChains.set(effect, [
        {
          nodeId: node.id,
          line: node.span.line,
          column: node.span.column,
          tags: directTags(node),
        },
      ]);
    }
  }

  const policies = collectPoliciesInScope(contract, callGraph, node, effective);
  const suppressions = collectSuppressions(contract, node.id);

  return {
    node,
    directEffects: sortedArray(direct),
    effectiveEffects: sortedArray(effective),
    inheritedEffects: sortedArray(inherited),
    propagationChains,
    policies,
    suppressions,
    noPolicies: contract.effectPolicies.length === 0,
  };
}

function flattenDeclaredEffects(contract: Contract): ReadonlySet<string> {
  const names = new Set<string>();
  for (const block of contract.effectDeclarations) {
    for (const e of block.effects) {
      names.add(e.name);
    }
  }
  return names;
}

function buildInitialEffects(
  contract: Contract,
  callGraph: CallGraph,
  annotationsByNode: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const annotationPatterns = contract.effectAnnotations.map((annotation) => ({
    annotation,
    patterns: annotation.target.map((t) => compilePattern(t)),
  }));

  const out = new Map<string, ReadonlySet<string>>();
  for (const node of callGraph.nodes) {
    const initial = new Set<string>();
    for (const { annotation, patterns } of annotationPatterns) {
      if (matchesAny(node.id, patterns)) {
        for (const e of annotation.annotates) {
          initial.add(e);
        }
      }
    }
    const annot = annotationsByNode.get(node.id);
    if (annot !== undefined) {
      for (const e of annot) {
        initial.add(e);
      }
    }
    if (node.effects !== undefined) {
      for (const e of node.effects) {
        initial.add(e);
      }
    }
    out.set(node.id, initial);
  }
  return out;
}

function matchesAny(nodeId: string, patterns: readonly CompiledPattern[]): boolean {
  for (const p of patterns) {
    if (p.matches(nodeId)) {
      return true;
    }
  }
  return false;
}

function buildChainSteps(
  callGraph: CallGraph,
  chain: readonly string[],
  effect: string,
  directByNode: ReadonlyMap<string, ReadonlySet<string>>,
): readonly PropagationChainStep[] {
  const nodeIndex = new Map<string, CallGraphNode>();
  for (const n of callGraph.nodes) {
    nodeIndex.set(n.id, n);
  }
  const edgeIndex = buildEdgeIndex(callGraph);

  const steps: PropagationChainStep[] = [];
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i] as string;
    const node = nodeIndex.get(id);
    if (node === undefined) {
      continue;
    }
    let line = node.span.line;
    let column = node.span.column;
    const tags: string[] = [];
    if (i === 0) {
      // First step is the inspected node itself — use its definition span.
      if (directByNode.get(id)?.has(effect) === true) {
        tags.push(`declares: ${effect}`);
      }
    } else {
      // Subsequent steps: line/col is the CALL SITE inside the previous
      // node, not the callee's definition. This matches the spec's
      // "@line:col" format showing where the indirection happens.
      const prev = chain[i - 1] as string;
      const edge = edgeIndex.get(`${prev} ${id}`);
      if (edge !== undefined) {
        line = edge.callSite.line;
        column = edge.callSite.column;
        if (edge.isAsync) {
          tags.push("async");
        }
        if (edge.isLoop) {
          tags.push("loop");
        }
        if (edge.isConditional) {
          tags.push("conditional");
        }
      }
      if (directByNode.get(id)?.has(effect) === true) {
        tags.push(`declares: ${effect}`);
      }
    }
    steps.push({ nodeId: id, line, column, tags });
  }
  return Object.freeze(steps);
}

function buildEdgeIndex(callGraph: CallGraph): ReadonlyMap<string, CallGraphEdge> {
  const out = new Map<string, CallGraphEdge>();
  for (const edge of callGraph.edges) {
    const key = `${edge.fromId} ${edge.toId}`;
    // First edge wins — deterministic by the order the extractor emits.
    if (!out.has(key)) {
      out.set(key, edge);
    }
  }
  return out;
}

function directTags(node: CallGraphNode): string[] {
  if (node.isAsync) {
    return ["async"];
  }
  return [];
}

function collectPoliciesInScope(
  contract: Contract,
  callGraph: CallGraph,
  node: CallGraphNode,
  effective: ReadonlySet<string>,
): readonly PolicyInScope[] {
  const out: PolicyInScope[] = [];
  for (const policy of contract.effectPolicies) {
    const patterns = policy.targetScope.map((t) => compilePattern(t));
    if (!matchesAny(node.id, patterns)) {
      continue;
    }
    if (policy.forbid !== undefined) {
      const offending: string[] = [];
      for (const e of effective) {
        if (policyEffectMatches(policy.forbid, e)) {
          offending.push(e);
        }
      }
      out.push({
        id: policy.id,
        kind: "forbid",
        effects: [...policy.forbid],
        severity: policy.severity,
        violationCount: offending.length,
      });
    }
    if (policy.allowOnly !== undefined) {
      const disallowed: string[] = [];
      for (const e of effective) {
        if (!policyEffectMatches(policy.allowOnly, e)) {
          disallowed.push(e);
        }
      }
      out.push({
        id: policy.id,
        kind: "allow-only",
        effects: [...policy.allowOnly],
        severity: policy.severity,
        violationCount: disallowed.length,
      });
    }
  }
  void callGraph;
  return Object.freeze(out);
}

function policyEffectMatches(policyEffects: readonly string[], effect: string): boolean {
  for (const e of policyEffects) {
    if (e === effect) {
      return true;
    }
    if (e.includes("*")) {
      // Compile a simple glob: convert `*` to `.*` and anchor.
      const regex = new RegExp(`^${e.split("*").map(escapeForRegex).join(".*")}$`);
      if (regex.test(effect)) {
        return true;
      }
    }
  }
  return false;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function collectSuppressions(
  contract: Contract,
  nodeId: string,
): readonly SuppressionInScope[] {
  const out: SuppressionInScope[] = [];
  for (const s of contract.effectSuppressions) {
    if (s.target === nodeId) {
      out.push({
        target: s.target,
        suppresses: [...s.suppresses],
        reason: s.reason,
        severity: s.severity,
      });
    }
  }
  return Object.freeze(out);
}

function sortedArray(set: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...set].sort((a, b) => a.localeCompare(b)));
}

function suggestNearbyNodes(callGraph: CallGraph, nodeId: string): readonly string[] {
  // Lightweight suggestion: nodes whose id shares the same file prefix or
  // function-name suffix. Returns at most 5 matches, deterministic order.
  const target = nodeId.toLowerCase();
  const targetFile = target.split("::")[0] ?? "";
  const targetSymbol = target.split("::").slice(-1)[0] ?? "";
  const scored: Array<{ id: string; score: number }> = [];
  for (const n of callGraph.nodes) {
    const lower = n.id.toLowerCase();
    let score = 0;
    if (lower.startsWith(targetFile) && targetFile.length > 0) {
      score += 2;
    }
    if (targetSymbol.length > 0 && lower.includes(targetSymbol.replace(/\(.*\)/, ""))) {
      score += 1;
    }
    if (score > 0) {
      scored.push({ id: n.id, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, 5).map((s) => s.id);
}

function resolveTsconfigPath(projectDir: string): string | undefined {
  let tsconfigPath: string | undefined = resolve(projectDir, "tsconfig.json");
  if (profilePathExists(projectDir)) {
    try {
      const profile = loadProfile(projectDir);
      if (profile.project?.tsconfig !== undefined) {
        tsconfigPath = resolve(projectDir, profile.project.tsconfig);
      }
    } catch {
      // Defer to the design stage for profile-load errors.
    }
  }
  if (tsconfigPath !== undefined && !existsSync(tsconfigPath)) {
    return undefined;
  }
  return tsconfigPath;
}

function formatEffectExplainHuman(inspection: EffectInspection): string {
  const { node } = inspection;
  const lines: string[] = [
    "Effect inspection for node:",
    `  NodeId:    ${node.id}`,
    `  Defined:   ${node.filePath}:${node.span.line}:${node.span.column}`,
    `  Kind:      ${node.kind}`,
    `  Signature: ${node.signature}`,
    "",
    "Direct effects on this node:",
  ];
  if (inspection.directEffects.length === 0) {
    if (inspection.effectiveEffects.length === 0) {
      lines.push("  (none)");
    } else {
      lines.push("  (none — all effects below are inherited)");
    }
  } else {
    for (const e of inspection.directEffects) {
      lines.push(`  - ${e}`);
    }
  }

  lines.push("", "Effective effects (after propagation):");
  if (inspection.effectiveEffects.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of inspection.effectiveEffects) {
      const tag = inspection.directEffects.includes(e) ? "[direct]" : "[inherited]";
      lines.push(`  - ${e.padEnd(18)} ${tag}`);
    }
  }

  lines.push("", "Propagation chains:");
  if (inspection.propagationChains.size === 0) {
    lines.push("  (none — node has no effects)");
  } else {
    const effects = [...inspection.propagationChains.keys()].sort((a, b) => a.localeCompare(b));
    for (const effect of effects) {
      const steps = inspection.propagationChains.get(effect) ?? [];
      lines.push(`  ${effect}:`);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as PropagationChainStep;
        const indent = "    " + "  ".repeat(i);
        const arrow = i === 0 ? "" : "→ ";
        const location = i === 0 ? "" : `@${step.line}:${step.column} `;
        const symbol = symbolFromNodeId(step.nodeId);
        const tagSuffix = step.tags.length === 0 ? "" : ` [${step.tags.join(", ")}]`;
        lines.push(`${indent}${arrow}${location}${symbol}${tagSuffix}`);
      }
    }
  }

  lines.push("", "Applicable policies (in scope):");
  if (inspection.noPolicies) {
    lines.push("  (no effect-policy declared in contract)");
  } else if (inspection.policies.length === 0) {
    lines.push("  (none — node is outside every effect-policy target-scope)");
  } else {
    for (const p of inspection.policies) {
      const verb = p.kind === "forbid" ? "forbids" : "restricts to";
      const verbSuffix =
        p.violationCount === 0
          ? "0 violations"
          : `${p.violationCount} violation${p.violationCount === 1 ? "" : "s"} would fire`;
      lines.push(
        `  - ${p.id} [${p.severity}]: ${verb} ${p.effects.join(", ")} → ${verbSuffix}`,
      );
    }
  }

  lines.push("", "Suppressions affecting this node:");
  if (inspection.suppressions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of inspection.suppressions) {
      lines.push(
        `  - suppresses ${s.suppresses.join(", ")} (severity=${s.severity})`,
        `    reason: ${s.reason}`,
      );
    }
  }

  lines.push("", "Re-extract data with `--no-cache` if a code change isn't reflected.");
  return `${lines.join("\n")}\n`;
}

function symbolFromNodeId(nodeId: string): string {
  // NodeId format: "<file>::<container>::<symbol>(arity)". Take the tail
  // after the last "::" so the rendered chain stays compact.
  const parts = nodeId.split("::");
  return parts[parts.length - 1] ?? nodeId;
}

function buildEffectExplainJson(inspection: EffectInspection): Record<string, unknown> {
  const { node } = inspection;
  const chains: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const [effect, steps] of inspection.propagationChains.entries()) {
    chains[effect] = steps.map((s) => ({
      node_id: s.nodeId,
      line: s.line,
      column: s.column,
      tags: s.tags,
    }));
  }
  return {
    schema_version: "1",
    tool: "@stele/cli",
    command: "explain effect",
    node: {
      id: node.id,
      file_path: node.filePath,
      span: {
        line: node.span.line,
        column: node.span.column,
      },
      kind: node.kind,
      signature: node.signature,
      is_async: node.isAsync,
      is_exported: node.isExported,
    },
    direct_effects: inspection.directEffects,
    effective_effects: inspection.effectiveEffects,
    inherited_effects: inspection.inheritedEffects,
    propagation_chains: chains,
    policies_in_scope: inspection.policies.map((p) => ({
      id: p.id,
      kind: p.kind,
      severity: p.severity,
      effects: p.effects,
      violation_count: p.violationCount,
    })),
    suppressions: inspection.suppressions.map((s) => ({
      target: s.target,
      suppresses: s.suppresses,
      reason: s.reason,
      severity: s.severity,
    })),
    no_policies_declared: inspection.noPolicies,
  };
}

