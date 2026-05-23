import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  CycleViolation,
  DependencyViolation,
  EvaluationResult,
  LayerDirectionViolation,
  PublicEntryViolation,
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
  let layerDirectionViolations: LayerDirectionViolation[] = [];
  let publicEntryViolations: PublicEntryViolation[] = [];

  if (declaration.denyCycles) {
    cycleViolations = findCycleViolations(declaration, graph);
  }

  if (declaration.layers.length > 0) {
    layerDirectionViolations = findLayerDirectionViolations(declaration, graph);
  }

  // Check public-entry constraints for modules that declare them
  const modulesWithPublicEntries = declaration.modules.filter((m) => m.publicEntries.length > 0);
  if (modulesWithPublicEntries.length > 0) {
    publicEntryViolations = findPublicEntryViolations(declaration, graph);
  }

  return {
    violations,
    cycleViolations,
    layerDirectionViolations,
    publicEntryViolations,
    ambiguousFiles: graph.ambiguousFiles,
    unresolvedSpecifiers: graph.unresolvedSpecifiers,
  };
}

/**
 * Build a lookup from allowDependencies: fromModule -> Set of allowed target modules.
 * Shared between findDependencyViolations and findLayerDirectionViolations.
 */
function buildAllowMap(
  declaration: ArchitectureDeclaration,
): Map<string, Set<string>> {
  const allowMap = new Map<string, Set<string>>();
  for (const dep of declaration.allowDependencies) {
    if (!allowMap.has(dep.from)) {
      allowMap.set(dep.from, new Set());
    }
    for (const target of dep.to) {
      allowMap.get(dep.from)?.add(target);
    }
  }
  return allowMap;
}

/**
 * Find edges where the source module is not allowed to depend on the target module.
 */
export function findDependencyViolations(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): DependencyViolation[] {
  const allowMap = buildAllowMap(declaration);

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

/**
 * Find edges where a module in a lower layer imports from a module in a higher layer.
 * Layer order is topological: layer[0] is highest, layer[n] is lowest.
 * Higher layers may depend on lower layers, but not vice versa.
 *
 * Edges already permitted by allowDependencies are excluded — dependency direction
 * and layer direction are complementary checks. If allowDependencies explicitly permits
 * a cross-layer edge, the layer direction check should not flag it.
 */
export function findLayerDirectionViolations(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): LayerDirectionViolation[] {
  const allowMap = buildAllowMap(declaration);

  // Build module -> layer mapping (layer index: lower index = higher layer)
  const moduleToLayer = new Map<string, number>();
  for (let i = 0; i < declaration.layers.length; i++) {
    const layer = declaration.layers[i];
    if (layer === undefined) continue;
    for (const modId of layer.modules) {
      moduleToLayer.set(modId, i);
    }
  }

  const violations: LayerDirectionViolation[] = [];

  for (const edge of graph.edges) {
    const fromLayerIdx = moduleToLayer.get(edge.fromModule);
    const toLayerIdx = moduleToLayer.get(edge.toModule);

    if (fromLayerIdx === undefined || toLayerIdx === undefined) {
      continue;
    }

    // Same layer is OK. Higher layer (lower idx) importing from lower layer (higher idx) is OK.
    // Violation: lower layer (higher idx) importing from higher layer (lower idx).
    if (fromLayerIdx > toLayerIdx) {
      // Skip if this edge is already permitted by allowDependencies.
      // allowDependencies is the authoritative source for which cross-module edges are OK.
      const allowed = allowMap.get(edge.fromModule);
      if (allowed !== undefined && allowed.has(edge.toModule)) {
        continue;
      }

      const fromLayer = declaration.layers[fromLayerIdx]!;
      const toLayer = declaration.layers[toLayerIdx]!;
      violations.push({
        fromModule: edge.fromModule,
        toModule: edge.toModule,
        fromLayer: fromLayer.id,
        toLayer: toLayer.id,
        fromFile: edge.fromFile,
        specifier: edge.specifier,
        line: edge.line,
        column: edge.column,
      });
    }
  }

  return violations;
}

/**
 * Find imports that bypass a module's public entry points.
 * When a module declares publicEntries, external imports must go through those entries.
 */
export function findPublicEntryViolations(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
): PublicEntryViolation[] {
  // Build module -> publicEntries mapping
  const modulePublicEntries = new Map<string, Set<string>>();
  for (const mod of declaration.modules) {
    if (mod.publicEntries.length > 0) {
      modulePublicEntries.set(mod.id, new Set(mod.publicEntries));
    }
  }

  // Build module -> files mapping
  const moduleFiles = new Map<string, Set<string>>();
  for (const [modId, files] of Object.entries(graph.modules)) {
    moduleFiles.set(modId, new Set(files));
  }

  const violations: PublicEntryViolation[] = [];

  for (const edge of graph.edges) {
    const toModulePublicEntries = modulePublicEntries.get(edge.toModule);
    if (toModulePublicEntries === undefined) {
      // No public entries declared for target module
      continue;
    }

    // If fromModule == toModule, internal imports are exempt
    if (edge.fromModule === edge.toModule) {
      continue;
    }

    // Check if the import target is a public entry
    const specifier = edge.specifier;
    const isPublicEntry = toModulePublicEntries.has(specifier);

    if (!isPublicEntry) {
      violations.push({
        fromModule: edge.fromModule,
        toModule: edge.toModule,
        fromFile: edge.fromFile,
        toFile: edge.toFile ?? specifier,
        specifier: specifier,
        publicEntries: [...toModulePublicEntries],
        line: edge.line,
        column: edge.column,
      });
    }
  }

  return violations;
}
