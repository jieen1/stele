import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  CycleViolation,
  DependencyViolation,
  EvaluationResult,
} from "./types.js";

/**
 * Evaluate an architecture graph against its declaration's constraints.
 * Returns all violations found.
 */
export function evaluateArchitecture(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): EvaluationResult {
  const violations = findDependencyViolations(declaration, graph);
  let cycleViolations: CycleViolation[] = [];

  if (declaration.denyCycles) {
    cycleViolations = findCycleViolations(declaration, graph);
  }

  return {
    violations,
    cycleViolations,
    ambiguousFiles: graph.ambiguousFiles,
    unresolvedSpecifiers: graph.unresolvedSpecifiers,
  };
}

/**
 * Find edges where the source module is not allowed to depend on the target module.
 */
export function findDependencyViolations(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): DependencyViolation[] {
  // Build allow-dependency lookup: fromModule -> Set of allowed target modules
  const allowMap = new Map<string, Set<string>>();
  for (const dep of declaration.allowDependencies) {
    if (!allowMap.has(dep.from)) {
      allowMap.set(dep.from, new Set());
    }
    for (const target of dep.to) {
      allowMap.get(dep.from)?.add(target);
    }
  }

  const violations: DependencyViolation[] = [];

  for (const edge of graph.edges) {
    const fromModule = edge.fromModule;
    const toModule = edge.toModule;

    // Self-dependency is always allowed
    if (fromModule === toModule) {
      continue;
    }

    const allowed = allowMap.get(fromModule);
    if (allowed === undefined || !allowed.has(toModule)) {
      const allowedTargets = allowMap.get(fromModule);
      violations.push({
        fromModule,
        toModule,
        fromFile: edge.fromFile,
        specifier: edge.specifier,
        line: edge.line,
        column: edge.column,
        allowedTargets: allowedTargets === undefined ? [] : [...allowedTargets],
      });
    }
  }

  return violations;
}

/**
 * Find cycle violations in the module-level dependency graph.
 */
export function findCycleViolations(
  _declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): CycleViolation[] {
  // Build module-level directed graph from edges, tracking edge files
  const moduleEdges = new Map<string, Set<string>>();
  const edgeFiles = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    const from = edge.fromModule;
    const to = edge.toModule;
    if (from === to) continue;

    if (!moduleEdges.has(from)) {
      moduleEdges.set(from, new Set());
    }
    moduleEdges.get(from)?.add(to);

    const key = `${from}->${to}`;
    if (!edgeFiles.has(key)) {
      edgeFiles.set(key, new Set());
    }
    edgeFiles.get(key)?.add(edge.fromFile);
  }

  const allModules = new Set(graph.edges.flatMap((e) => [e.fromModule, e.toModule]));
  const moduleList = [...allModules];

  return detectCycles(moduleList, moduleEdges, edgeFiles);
}

/**
 * Detect cycles in a directed graph using DFS.
 *
 * @param modules - list of module ids in the graph
 * @param moduleEdges - adjacency map (module -> set of dependent modules)
 * @param edgeFiles - map from "from->to" edge keys to sets of file paths
 * @returns array of cycle violations found
 */
export function detectCycles(
  modules: string[],
  moduleEdges: Map<string, Set<string>>,
  edgeFiles: Map<string, Set<string>> = new Map(),
): CycleViolation[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  for (const mod of modules) {
    color.set(mod, WHITE);
  }

  const cycles: CycleViolation[] = [];
  const path: string[] = [];
  const pathSet = new Set<string>();

  function dfs(node: string): void {
    color.set(node, GRAY);
    path.push(node);
    pathSet.add(node);

    const neighbors = moduleEdges.get(node);
    if (neighbors !== undefined) {
      for (const next of neighbors) {
        const nextColor = color.get(next);
        if (nextColor === GRAY && pathSet.has(next)) {
          // Found a cycle — extract the cycle from the path
          const cycleStart = path.indexOf(next);
          const cycleModules = path.slice(cycleStart);
          cycleModules.push(next); // close the cycle

          // Collect edge files for each hop in the cycle
          const cycleFiles: string[] = [];
          for (let i = 0; i < cycleModules.length - 1; i++) {
            const from = cycleModules[i];
            const to = cycleModules[i + 1];
            const files = edgeFiles.get(`${from}->${to}`);
            if (files !== undefined) {
              for (const f of files) {
                if (!cycleFiles.includes(f)) {
                  cycleFiles.push(f);
                }
              }
            }
          }

          cycles.push({
            modules: cycleModules,
            edgeFiles: cycleFiles,
          });
        } else if (nextColor === WHITE) {
          dfs(next);
        }
      }
    }

    path.pop();
    pathSet.delete(node);
    color.set(node, BLACK);
  }

  for (const mod of modules) {
    if (color.get(mod) === WHITE) {
      dfs(mod);
    }
  }

  return cycles;
}
