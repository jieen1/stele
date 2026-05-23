/**
 * DFS path enumeration over a CallGraph, bounded by depth and path-count caps.
 *
 * Round 2 D-CG-2 + MC-8: default max depth is 10. When the cap is hit the
 * evaluator must emit a `path_exceeded_max_depth` notice rather than silently
 * skip — that is handled by the caller, this module just reports `truncated`.
 */

import type { CallGraph, CallGraphEdge } from "@stele/call-graph-core";

export interface EnumeratedPath {
  /** NodeIds from caller (index 0) to target (last index). */
  readonly nodes: readonly string[];
}

export interface EnumerationStats {
  readonly pathsEnumerated: number;
  readonly truncated: boolean;
}

export interface EnumerationResult {
  readonly paths: readonly EnumeratedPath[];
  readonly stats: EnumerationStats;
}

interface AdjacencyIndex {
  /** fromId -> ordered list of edges leaving the node. */
  readonly out: ReadonlyMap<string, readonly CallGraphEdge[]>;
}

const ADJ_CACHE = new WeakMap<CallGraph, AdjacencyIndex>();

function buildAdjacency(callGraph: CallGraph): AdjacencyIndex {
  const cached = ADJ_CACHE.get(callGraph);
  if (cached !== undefined) {
    return cached;
  }
  const map = new Map<string, CallGraphEdge[]>();
  for (const edge of callGraph.edges) {
    let bucket = map.get(edge.fromId);
    if (bucket === undefined) {
      bucket = [];
      map.set(edge.fromId, bucket);
    }
    bucket.push(edge);
  }
  // Sort by call site for deterministic enumeration order.
  for (const bucket of map.values()) {
    bucket.sort((a, b) => {
      if (a.callSite.line !== b.callSite.line) {
        return a.callSite.line - b.callSite.line;
      }
      if (a.callSite.column !== b.callSite.column) {
        return a.callSite.column - b.callSite.column;
      }
      return a.toId.localeCompare(b.toId);
    });
  }
  const frozen: AdjacencyIndex = { out: map };
  ADJ_CACHE.set(callGraph, frozen);
  return frozen;
}

/**
 * Enumerate all simple paths (no node repeats) from `fromId` to any node in
 * `toIds`, bounded by:
 *  - `maxDepth`: maximum length of the path (nodes count, including endpoints).
 *  - `maxPaths`: maximum number of paths returned.
 *
 * Returns at most `maxPaths` paths. `truncated` is set when more paths exist
 * beyond the cap OR when DFS abandoned branches because of the depth cap. The
 * caller is responsible for emitting `path_exceeded_max_depth` notices.
 */
export function enumeratePaths(
  callGraph: CallGraph,
  fromId: string,
  toIds: ReadonlySet<string>,
  maxDepth: number,
  maxPaths: number,
): EnumerationResult {
  if (maxDepth < 2 || maxPaths < 1 || toIds.size === 0) {
    return { paths: [], stats: { pathsEnumerated: 0, truncated: false } };
  }

  const adj = buildAdjacency(callGraph);
  const found: EnumeratedPath[] = [];
  let truncated = false;
  let depthCapHit = false;

  const stack: string[] = [fromId];
  const onStack = new Set<string>([fromId]);

  const dfs = (): void => {
    if (found.length >= maxPaths) {
      truncated = true;
      return;
    }

    const current = stack[stack.length - 1];
    if (current === undefined) {
      return;
    }

    // If we are deeper than allowed: record cap hit and back off.
    if (stack.length > maxDepth) {
      depthCapHit = true;
      return;
    }

    // If current is a target AND we are past the caller, record the path.
    // (We allow caller==target only when explicitly listed as a target — but
    // such "1-node path" is degenerate and not useful for trace constraints;
    // skip if length == 1.)
    if (stack.length >= 2 && toIds.has(current)) {
      found.push({ nodes: Object.freeze([...stack]) });
      if (found.length >= maxPaths) {
        truncated = true;
        return;
      }
      // Continue exploring past this target: a longer path may exist that
      // visits another target node. But to keep determinism + cost bounded,
      // we DO NOT extend past a target; only one "ends here" record per
      // simple path. This matches the spec's "path from caller to target".
      return;
    }

    // Expand neighbours.
    if (stack.length === maxDepth) {
      // Cannot go deeper. If we haven't yielded yet, that's a depth cap miss.
      depthCapHit = true;
      return;
    }

    const edges = adj.out.get(current);
    if (edges === undefined) {
      return;
    }

    for (const edge of edges) {
      if (onStack.has(edge.toId)) {
        // Cycle — skip to keep paths simple.
        continue;
      }
      stack.push(edge.toId);
      onStack.add(edge.toId);
      dfs();
      onStack.delete(edge.toId);
      stack.pop();
      if (found.length >= maxPaths) {
        truncated = true;
        return;
      }
    }
  };

  dfs();

  return {
    paths: Object.freeze([...found]),
    stats: {
      pathsEnumerated: found.length,
      truncated: truncated || depthCapHit,
    },
  };
}

export interface OutgoingCall {
  readonly toId: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Get all `CallExpression` edges out of `fromId`, ordered by call-site
 * (line, column). Used by must-be-preceded-by / must-be-followed-by which
 * look at siblings within a single function body.
 */
export function getOrderedOutgoingEdges(
  callGraph: CallGraph,
  fromId: string,
): readonly OutgoingCall[] {
  const adj = buildAdjacency(callGraph);
  const edges = adj.out.get(fromId);
  if (edges === undefined) {
    return Object.freeze([]);
  }
  // adj.out is already sorted by (line, column, toId).
  return Object.freeze(
    edges.map((e) => ({
      toId: e.toId,
      line: e.callSite.line,
      column: e.callSite.column,
    })),
  );
}
