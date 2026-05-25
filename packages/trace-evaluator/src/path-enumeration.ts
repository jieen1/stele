/**
 * DFS path enumeration over a CallGraph, bounded by depth and path-count caps.
 *
 * Round 2 D-CG-2 + MC-8: default max depth is 10. When the cap is hit the
 * evaluator must emit a `path_exceeded_max_depth` notice rather than silently
 * skip — that is handled by the caller, this module just reports `truncated`.
 *
 * Closeout 5 (2026-05-25): adds **negative partial-path memoization** scoped
 * to a single `enumeratePaths` invocation. The cache stores, for each node,
 * the LARGEST remaining-budget at which that node was exhaustively proven
 * to reach no target. Any future visit with the same-or-smaller remaining
 * budget can re-use the proof and short-circuit.
 *
 * Why depth-tagged (not just per-node): the depth cap is what terminates
 * deep DFS branches before they finish. A node's clean-status can only be
 * proven up to whatever remaining budget the FIRST visit had. A second
 * visit with EQUAL OR LESS remaining budget will explore only a subset of
 * the first visit's subtree, so the proof carries over. A second visit
 * with MORE remaining budget might explore additional depth and could
 * (in principle) find a target the first visit missed; we therefore
 * conservatively skip the cache in that direction.
 *
 * The cache is sound under simple-path DFS because:
 *
 *   1. We only cache when the subtree was fully explored within the
 *      remaining budget — no cycle-skip, no depth-cap, no maxPaths cap.
 *   2. A future visit with the same-or-smaller remaining budget would
 *      explore a strict subset of what was already explored; if the
 *      first explored set had no targets, neither does any subset.
 *   3. The cache lives only inside this `enumeratePaths` call; it never
 *      leaks to other calls (which could have different `toIds`).
 */

import { stableStringCompare } from "@stele/core";
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
      return stableStringCompare(a.toId, b.toId);
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

  // Closeout 5: per-invocation negative cache, KEYED BY (nodeId, remaining
  // budget). For each node we keep the LARGEST remaining-budget at which
  // exhaustive exploration found no targets. Future visits with remaining
  // budget <= cachedRemaining can re-use the proof: their explored set is
  // a strict subset.
  //
  // The cache is freed when this function returns — no cross-invocation
  // leakage. We rely on `toIds` / `maxDepth` / `maxPaths` being constant
  // for the call.
  const cleanAtRemaining = new Map<string, number>();

  const stack: string[] = [fromId];
  const onStack = new Set<string>([fromId]);

  /**
   * Returns the largest remaining-budget at which the current top-of-stack
   * node has been exhaustively proven to reach no target during this
   * sub-call, or `null` when the walk was not exhaustive (cycle-skip,
   * depth-cap, path-cap, or a target was found). Only an exhaustive walk
   * is sound to memoize.
   */
  const dfs = (): number | null => {
    if (found.length >= maxPaths) {
      truncated = true;
      return null;
    }

    const current = stack[stack.length - 1];
    if (current === undefined) {
      return null;
    }

    // If we are deeper than allowed: record cap hit and back off. The walk
    // from this node was NOT exhaustive — do not memoize.
    if (stack.length > maxDepth) {
      depthCapHit = true;
      return null;
    }

    // If current is a target AND we are past the caller, record the path.
    // (We allow caller==target only when explicitly listed as a target — but
    // such "1-node path" is degenerate and not useful for trace constraints;
    // skip if length == 1.)
    if (stack.length >= 2 && toIds.has(current)) {
      found.push({ nodes: Object.freeze([...stack]) });
      if (found.length >= maxPaths) {
        truncated = true;
        return null;
      }
      // Reaching a target ends this path; the node IS a target — never
      // memoize a target as "clean."
      return null;
    }

    const remaining = maxDepth - stack.length;
    // Cache hit: have we already proven `current` is clean at a remaining
    // budget >= the budget we have now? If so, this sub-call yields no
    // new paths (a strict subset of what was already explored).
    const cachedRemaining = cleanAtRemaining.get(current);
    if (cachedRemaining !== undefined && cachedRemaining >= remaining) {
      return remaining;
    }

    // Expand neighbours.
    if (remaining === 0) {
      // Cannot go deeper. If we haven't yielded yet, that's a depth cap miss.
      depthCapHit = true;
      return null;
    }

    const edges = adj.out.get(current);
    if (edges === undefined) {
      // Leaf node with no outgoing edges, not a target — exhaustively walked
      // (vacuously) and proven clean at this remaining budget.
      cleanAtRemaining.set(current, remaining);
      return remaining;
    }

    let exhaustive = true;
    let foundCountBefore = found.length;

    for (const edge of edges) {
      if (onStack.has(edge.toId)) {
        // Cycle — skip to keep paths simple. Cycle-skip means the walk from
        // `current` is NOT fully exhaustive (this child was not explored,
        // and on a future visit where the child is not on stack it might
        // reach a target). Suppress memoization for `current`.
        exhaustive = false;
        continue;
      }
      stack.push(edge.toId);
      onStack.add(edge.toId);
      const childCleanRemaining = dfs();
      onStack.delete(edge.toId);
      stack.pop();

      if (found.length > foundCountBefore) {
        // This branch reached a target — `current` is not clean.
        exhaustive = false;
        foundCountBefore = found.length;
      }
      if (childCleanRemaining === null) {
        exhaustive = false;
      }

      if (found.length >= maxPaths) {
        truncated = true;
        return null;
      }
    }

    if (exhaustive) {
      // Cache the proof. Children were each either pruned by the on-stack
      // cycle check (but if so we already set exhaustive=false above) or
      // proven clean at remaining-1; therefore the entire subtree from
      // `current` within budget `remaining` reached no target.
      const prior = cleanAtRemaining.get(current);
      if (prior === undefined || prior < remaining) {
        cleanAtRemaining.set(current, remaining);
      }
      return remaining;
    }
    return null;
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
