import type { ArchitectureGraph, DependencyEdge } from "@stele/architecture-core";

export type CycleInfo = {
  modules: string[];
  edgeFiles: string[];
};

/**
 * Detect dependency cycles in the architecture graph.
 *
 * Uses DFS-based cycle detection on the module-level dependency graph.
 * Returns all found cycles with the modules involved and the edge files
 * that form the cycle.
 */
export function detectModuleCycles(graph: ArchitectureGraph): CycleInfo[] {
  const moduleAdjacency = buildModuleAdjacency(graph.edges);

  // Collect all module IDs
  const allModules = new Set<string>();
  for (const [from] of moduleAdjacency.entries()) {
    allModules.add(from);
    const neighbors = moduleAdjacency.get(from);
    if (neighbors !== undefined) {
      for (const to of neighbors.keys()) {
        allModules.add(to);
      }
    }
  }

  const cycles: CycleInfo[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  for (const module of allModules) {
    if (!visited.has(module)) {
      dfsCycle(module, moduleAdjacency, allModules, visited, inStack, stack, cycles);
    }
  }

  return cycles;
}

/**
 * DFS-based cycle detection.
 */
function dfsCycle(
  current: string,
  adjacency: Map<string, Map<string, string[]>>,
  allModules: Set<string>,
  visited: Set<string>,
  inStack: Set<string>,
  stack: string[],
  cycles: CycleInfo[],
): void {
  if (inStack.has(current)) {
    // Found a cycle — extract it from the stack
    const cycleStart = stack.indexOf(current);
    const cycleModules = stack.slice(cycleStart);
    cycleModules.push(current);

    // Collect edge files for the cycle
    const edgeFiles: string[] = [];
    for (let i = 0; i < cycleModules.length - 1; i++) {
      const from = cycleModules[i];
      const to = cycleModules[i + 1];
      const fromAdj = adjacency.get(from);
      const filesForEdge = fromAdj?.get(to);
      if (filesForEdge !== undefined) {
        edgeFiles.push(...filesForEdge);
      }
    }

    cycles.push({ modules: cycleModules, edgeFiles });
    return;
  }

  if (visited.has(current)) {
    return;
  }

  visited.add(current);
  inStack.add(current);
  stack.push(current);

  const neighbors = adjacency.get(current);
  if (neighbors !== undefined) {
    for (const neighbor of neighbors.keys()) {
      dfsCycle(neighbor, adjacency, allModules, visited, inStack, stack, cycles);
    }
  }

  stack.pop();
  inStack.delete(current);
}

/**
 * Build module-level adjacency map from file-level edges.
 * Returns Map<fromModule, Map<toModule, string[]>> where the inner map
 * maps target modules to the file paths that create those edges.
 */
function buildModuleAdjacency(edges: DependencyEdge[]): Map<string, Map<string, string[]>> {
  const adjacency = new Map<string, Map<string, string[]>>();

  for (const edge of edges) {
    const fromModule = edge.fromModule;
    const toModule = edge.toModule;

    // Skip same-module edges and edges where module ID could not be determined
    if (fromModule === "" || toModule === "" || fromModule === toModule) {
      continue;
    }

    let fromAdj = adjacency.get(fromModule);
    if (fromAdj === undefined) {
      fromAdj = new Map();
      adjacency.set(fromModule, fromAdj);
    }

    let existingFiles = fromAdj.get(toModule);
    if (existingFiles === undefined) {
      existingFiles = [edge.fromFile];
      fromAdj.set(toModule, existingFiles);
    } else {
      existingFiles.push(edge.fromFile);
    }
  }

  return adjacency;
}
