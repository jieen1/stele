import type { CallGraph } from "@stele/call-graph-core";
import { compilePattern, parseNodeId } from "@stele/call-graph-core";
import type { Contract } from "@stele/core";
import { expandTargetPattern } from "../code-shape/evaluate.js";
import { parseTarget } from "../code-shape/code-shape-common.js";
import { isTypeScriptFilePath } from "../code-shape/typescript-analyzer.js";
import { parseCoreNodeTarget } from "../complexity/types.js";
import { buildModuleMap } from "../architecture/module-map.js";

/**
 * Shared expansion core: maps each contract declaration to the set of source
 * files (and symbols) it binds. This is the single primitive that both
 * `stele coverage` and the future `stele check --changed` reverse index
 * consume. Pure given its inputs — no git, no process, no clock.
 */

export type Mechanism =
  | "boundary"
  | "type-policy"
  | "file-policy"
  | "function-shape"
  | "class-shape"
  | "trace-policy"
  | "effect-policy"
  | "type-state"
  | "architecture"
  | "core-node"
  | "branded-id";

export interface ExpandedDeclaration {
  readonly mechanism: Mechanism;
  readonly declarationId: string;
  readonly files: ReadonlySet<string>;
  readonly symbols: ReadonlySet<string>;
  /**
   * False when a symbol-mechanism (trace/effect/type-state) selector resolved
   * to zero real call-graph nodes — the zero-binding honesty gate. Such a
   * declaration contributes NO file coverage.
   */
  readonly bound: boolean;
  /** Files that are architecturally in-root but unowned by any module. */
  readonly architecturallyUnowned?: ReadonlySet<string>;
}

export interface ExpandFailure {
  readonly declarationId: string;
  readonly reason: string;
}

export interface ExpandOptions {
  readonly contract: Contract;
  readonly projectDir: string;
  /** TS call graph; absent when no extractor for the project language. */
  readonly callGraph?: CallGraph;
  /** Universe files (architecture module assignment runs against these). */
  readonly universeFiles: readonly string[];
}

export interface ExpandResult {
  readonly declarations: ReadonlyMap<string, ExpandedDeclaration>;
  readonly failures: readonly ExpandFailure[];
  readonly externTargets: readonly string[];
  /** True when a TS call graph was available for symbol mechanisms. */
  readonly symbolSupport: boolean;
}

function langFilter(lang: "typescript" | "python"): (file: string) => boolean {
  return lang === "typescript" ? isTypeScriptFilePath : (file: string) => file.endsWith(".py");
}

/**
 * Map call-graph nodes matching ANY of `patterns` to their file paths. Returns
 * both the matched node count (for the binding gate) and the file set. Extern
 * matches contribute no file (their NodeId has no filePath) and are collected
 * separately.
 */
function matchNodesToFiles(
  callGraph: CallGraph,
  patterns: readonly string[],
): { files: Set<string>; nodeCount: number; externCount: number } {
  const compiled = patterns.map((p) => compilePattern(p));
  const files = new Set<string>();
  let nodeCount = 0;
  let externCount = 0;
  for (const node of callGraph.nodes) {
    if (!compiled.some((c) => c.matches(node.id))) continue;
    nodeCount += 1;
    const parsed = parseNodeId(node.id);
    if (parsed?.filePath !== undefined) {
      files.add(parsed.filePath);
    } else {
      externCount += 1;
    }
  }
  return { files, nodeCount, externCount };
}

/**
 * Count in-scope caller→target call sites: edges whose source matches a scope
 * pattern and whose destination matches a target pattern. Mirrors the trace
 * stage's `callSitesExamined` gate conservatively (edge-level, not path-level).
 */
function countCallSites(
  callGraph: CallGraph,
  targetPatterns: readonly string[],
  scopePatterns: readonly string[],
): number {
  if (scopePatterns.length === 0) {
    // Whole-graph scope: any caller is in scope.
    const tgt = targetPatterns.map((p) => compilePattern(p));
    let count = 0;
    for (const edge of callGraph.edges) {
      if (tgt.some((c) => c.matches(edge.toId))) count += 1;
    }
    return count;
  }
  const tgt = targetPatterns.map((p) => compilePattern(p));
  const scp = scopePatterns.map((p) => compilePattern(p));
  let count = 0;
  for (const edge of callGraph.edges) {
    if (scp.some((c) => c.matches(edge.fromId)) && tgt.some((c) => c.matches(edge.toId))) {
      count += 1;
    }
  }
  return count;
}

export async function expandContractToFiles(options: ExpandOptions): Promise<ExpandResult> {
  const { contract, projectDir, callGraph, universeFiles } = options;
  const declarations = new Map<string, ExpandedDeclaration>();
  const failures: ExpandFailure[] = [];
  const externTargets = new Set<string>();

  // --- code-shape family (boundary / class-shape / function-shape / type-policy / file-policy) ---
  for (const decl of contract.codeShapes) {
    try {
      const parsed = parseTarget(decl.target);
      const expanded = await expandTargetPattern(projectDir, parsed.pathPattern);
      const files = new Set(expanded.filter(langFilter(decl.lang)));
      const symbols = new Set<string>();
      if (parsed.selectorName !== undefined) symbols.add(parsed.selectorName);
      declarations.set(decl.id, {
        mechanism: decl.kind,
        declarationId: decl.id,
        files,
        symbols,
        bound: true,
      });
    } catch (error) {
      failures.push({ declarationId: decl.id, reason: errMsg(error) });
    }
  }

  // --- core-node ---
  for (const decl of contract.coreNodes) {
    const parsed = parseCoreNodeTarget(decl.target);
    if (parsed === undefined) {
      failures.push({ declarationId: decl.id, reason: `core-node target "${decl.target}" did not parse as file::Class` });
      continue;
    }
    declarations.set(decl.id, {
      mechanism: "core-node",
      declarationId: decl.id,
      files: new Set([parsed.filePath]),
      symbols: new Set([parsed.className]),
      bound: true,
    });
  }

  // --- branded-id (literal file::symbol) ---
  for (const decl of contract.brandedIds) {
    const sep = decl.target.indexOf("::");
    if (sep === -1) {
      failures.push({ declarationId: decl.id, reason: `branded-id target "${decl.target}" is not file::symbol` });
      continue;
    }
    const filePath = decl.target.slice(0, sep).replaceAll("\\", "/");
    const symbol = decl.target.slice(sep + 2);
    declarations.set(decl.id, {
      mechanism: "branded-id",
      declarationId: decl.id,
      files: new Set([filePath]),
      symbols: new Set([symbol]),
      bound: true,
    });
  }

  // --- architecture (module map over the universe) ---
  for (const decl of contract.architectures) {
    const map = buildModuleMap([...universeFiles], decl.modules);
    const files = new Set(map.fileToModule.keys());
    declarations.set(decl.id, {
      mechanism: "architecture",
      declarationId: decl.id,
      files,
      symbols: new Set<string>(),
      bound: true,
      architecturallyUnowned: new Set(map.unownedFiles),
    });
  }

  // --- symbol mechanisms: trace / effect / type-state ---
  const symbolSupport = callGraph !== undefined;

  for (const decl of contract.tracePolicies) {
    if (callGraph === undefined) {
      declarations.set(decl.id, unboundSymbolDecl("trace-policy", decl.id));
      continue;
    }
    const targets = decl.target;
    const scope = decl.scope;
    const tgt = matchNodesToFiles(callGraph, targets);
    const scopeMatch = scope.length === 0 ? { nodeCount: callGraph.nodes.length } : matchNodesToFiles(callGraph, scope);
    const callSites = countCallSites(callGraph, targets, scope);
    const bound = tgt.nodeCount > 0 && scopeMatch.nodeCount > 0 && callSites > 0;
    collectExtern(targets, externTargets);
    // Coverage attributed to the in-scope caller files (what the policy guards).
    const scopeFiles = scope.length === 0 ? new Set<string>() : matchNodesToFiles(callGraph, scope).files;
    declarations.set(decl.id, {
      mechanism: "trace-policy",
      declarationId: decl.id,
      files: bound ? scopeFiles : new Set<string>(),
      symbols: new Set<string>(),
      bound,
    });
  }

  for (const decl of contract.effectPolicies) {
    if (callGraph === undefined) {
      declarations.set(decl.id, unboundSymbolDecl("effect-policy", decl.id));
      continue;
    }
    const targetScope = decl.targetScope;
    const match = matchNodesToFiles(callGraph, targetScope);
    collectExtern(targetScope, externTargets);
    const bound = match.nodeCount > 0;
    declarations.set(decl.id, {
      mechanism: "effect-policy",
      declarationId: decl.id,
      files: bound ? match.files : new Set<string>(),
      symbols: new Set<string>(),
      bound,
    });
  }

  for (const decl of contract.typeStates) {
    if (callGraph === undefined) {
      declarations.set(decl.id, unboundSymbolDecl("type-state", decl.id));
      continue;
    }
    const targets = [decl.target];
    const match = matchNodesToFiles(callGraph, targets);
    collectExtern(targets, externTargets);
    const bound = match.nodeCount > 0;
    declarations.set(decl.id, {
      mechanism: "type-state",
      declarationId: decl.id,
      files: bound ? match.files : new Set<string>(),
      symbols: new Set<string>(),
      bound,
    });
  }

  return {
    declarations,
    failures,
    externTargets: [...externTargets].sort(),
    symbolSupport,
  };
}

function unboundSymbolDecl(mechanism: Mechanism, id: string): ExpandedDeclaration {
  return {
    mechanism,
    declarationId: id,
    files: new Set<string>(),
    symbols: new Set<string>(),
    bound: false,
  };
}

function collectExtern(patterns: readonly string[], out: Set<string>): void {
  for (const p of patterns) {
    if (p.startsWith("extern:") || isExternShorthand(p)) {
      out.add(p);
    }
  }
}

function isExternShorthand(pattern: string): boolean {
  // `stripe.*` sugar — a leading bare identifier followed by `.` and no `::`
  // or `/`. Conservative: only treat as extern when there is no path glob.
  if (pattern.includes("::") || pattern.includes("/")) return false;
  const dot = pattern.indexOf(".");
  return dot > 0;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
