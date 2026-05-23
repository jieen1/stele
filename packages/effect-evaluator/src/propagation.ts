/**
 * Effect set propagation over a call graph. Implements the Round 2 MC-7
 * worklist + reverse-postorder algorithm:
 *
 *   1. Compute reverse-postorder over the call graph (leaves first).
 *   2. Initialise each node's effect set from `initialEffectsByNode`.
 *   3. For each node in reverse-postorder, recompute its set as
 *      `initial(n) ∪ union(set(c) for c in callees(n))`. If the new set
 *      differs from the previous value, push all callers of `n` back onto
 *      the worklist for re-evaluation.
 *   4. Stop when the worklist drains. Cycles are handled by the seen-set
 *      check: a node is re-enqueued only when its effect set actually
 *      changes, so we cannot loop forever (sets only grow).
 *
 * The naive O(n²) double-loop is rejected per Round 2 MC-7 — worklist
 * converges in ≤ |edges| + |nodes| iterations for monotone joins.
 *
 * `unresolvedNodes` (those carrying an `UnresolvedCall` per the CallGraph)
 * are NOT propagated specially here — the evaluator caller decides whether
 * to treat their effect set as "all declared effects" (Round 2 D-CG-5
 * fail-closed) or as their computed value (lenient).
 */

import type { CallGraph, CallGraphEdge } from "@stele/call-graph-core";

import { unionEffects } from "./effect-set.js";

export interface PropagationInput {
  readonly callGraph: CallGraph;
  /** Initial direct effects per node (CDL annotation + source-code annotation). */
  readonly initialEffectsByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Per-node suppression mask. The effect set for a node is computed as
   * `(initial ∪ union(callees)) − mask`. Suppressions therefore (a) drop
   * the effect from the node's own effective set, (b) prevent the effect
   * from propagating up to callers of the suppressed node — exactly the
   * "breaks the propagation chain" semantic from 04-effect-system.md §five.
   */
  readonly suppressionsByNode?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface PropagationResult {
  /** Final effective effect set for every node in the call graph. */
  readonly effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /** Direct effects only — copy of input, retained for violation evidence. */
  readonly directByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /** Inherited-only effects per node (= effective − direct). */
  readonly inheritedByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /** Total worklist iterations (used by stats). */
  readonly rounds: number;
  /**
   * For each node, the set of declarer NodeIds — nodes in its reachable
   * callee tree that directly declared the effect. Indexed by effect name
   * because a violation hint needs to point at the declarer per effect.
   */
  readonly propagationRoots: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

/**
 * Reverse-postorder traversal of the call graph. Leaves appear first so the
 * worklist can propagate their effects upward in (typically) a single pass.
 *
 * Tarjan-style: dfs, push when finishing. Result is reversed so leaves come
 * first. Disconnected components are handled by iterating over all nodes as
 * potential roots. Cycles are tolerated — the standard "color" pattern
 * suffices because we only need a deterministic order, not strict
 * topological correctness (which doesn't exist for cyclic graphs).
 */
export function reversePostorder(callGraph: CallGraph): readonly string[] {
  const adj = buildOutgoingAdjacency(callGraph);
  const order: string[] = [];
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 gray, 2 black
  for (const n of callGraph.nodes) {
    color.set(n.id, 0);
  }

  // Iterative DFS to avoid stack overflow on large graphs.
  for (const root of callGraph.nodes) {
    if (color.get(root.id) !== 0) {
      continue;
    }
    const stack: Array<{ id: string; childIdx: number }> = [{ id: root.id, childIdx: 0 }];
    color.set(root.id, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        break;
      }
      const children = adj.get(top.id);
      if (children === undefined || top.childIdx >= children.length) {
        // Finished this node.
        color.set(top.id, 2);
        order.push(top.id);
        stack.pop();
        continue;
      }
      const child = children[top.childIdx];
      top.childIdx += 1;
      if (child === undefined) {
        continue;
      }
      const c = color.get(child);
      if (c === 0) {
        color.set(child, 1);
        stack.push({ id: child, childIdx: 0 });
      }
      // gray (cycle) or black (already finished): skip
    }
  }

  // `order` is now post-order: leaves first if we treat callee edges as
  // "children". That is exactly the reverse-postorder we want for upward
  // propagation. (No need to reverse.)
  return Object.freeze(order);
}

function buildOutgoingAdjacency(
  callGraph: CallGraph,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const n of callGraph.nodes) {
    out.set(n.id, []);
  }
  // Sort edges by (fromId, toId, line, col) for deterministic traversal.
  const sorted = [...callGraph.edges].sort(edgeCmp);
  for (const e of sorted) {
    const bucket = out.get(e.fromId);
    if (bucket === undefined) {
      out.set(e.fromId, [e.toId]);
    } else {
      // Dedup adjacency — multiple call sites to same callee count once
      // for traversal; the worklist only cares about the unique callee set.
      if (!bucket.includes(e.toId)) {
        bucket.push(e.toId);
      }
    }
  }
  return out;
}

function buildIncomingAdjacency(
  callGraph: CallGraph,
): ReadonlyMap<string, readonly string[]> {
  const inc = new Map<string, string[]>();
  for (const n of callGraph.nodes) {
    inc.set(n.id, []);
  }
  const sorted = [...callGraph.edges].sort(edgeCmp);
  for (const e of sorted) {
    let bucket = inc.get(e.toId);
    if (bucket === undefined) {
      bucket = [];
      inc.set(e.toId, bucket);
    }
    if (!bucket.includes(e.fromId)) {
      bucket.push(e.fromId);
    }
  }
  return inc;
}

function edgeCmp(a: CallGraphEdge, b: CallGraphEdge): number {
  const f = a.fromId.localeCompare(b.fromId);
  if (f !== 0) {
    return f;
  }
  const t = a.toId.localeCompare(b.toId);
  if (t !== 0) {
    return t;
  }
  if (a.callSite.line !== b.callSite.line) {
    return a.callSite.line - b.callSite.line;
  }
  return a.callSite.column - b.callSite.column;
}

/**
 * Run the worklist propagation. Returns a fully populated
 * `effectiveByNode` map covering every node in the call graph (including
 * leaves and isolated nodes).
 */
export function propagateEffects(input: PropagationInput): PropagationResult {
  const { callGraph, initialEffectsByNode, suppressionsByNode } = input;

  // Direct (initial) effects per node — frozen view of the input.
  const directByNode = new Map<string, ReadonlySet<string>>();
  for (const n of callGraph.nodes) {
    const init = initialEffectsByNode.get(n.id);
    directByNode.set(n.id, init ?? new Set<string>());
  }

  const outgoing = buildOutgoingAdjacency(callGraph);
  const incoming = buildIncomingAdjacency(callGraph);

  // Effective mask per node (suppressed effects never appear in the set).
  const maskOf = (id: string): ReadonlySet<string> | undefined =>
    suppressionsByNode?.get(id);

  // Initialise effective with direct, then apply the per-node suppression
  // mask immediately so the propagation worklist already sees the trimmed
  // set (the suppressed effects never enter the node's bag, hence never
  // propagate to callers — the "break the chain" semantic).
  const effective = new Map<string, Set<string>>();
  for (const n of callGraph.nodes) {
    const init = initialEffectsByNode.get(n.id);
    const bag = new Set<string>();
    if (init !== undefined) {
      const mask = maskOf(n.id);
      for (const e of init) {
        if (mask !== undefined && mask.has(e)) {
          continue;
        }
        bag.add(e);
      }
    }
    effective.set(n.id, bag);
  }

  // Propagation roots per node — `effect -> set of declarer nodeIds in the
  // reachable callee tree`. We track this alongside the effect set so the
  // violation builder can render the propagation chain.
  const roots = new Map<string, Map<string, Set<string>>>();
  for (const n of callGraph.nodes) {
    const perEffect = new Map<string, Set<string>>();
    const direct = directByNode.get(n.id);
    if (direct !== undefined) {
      for (const e of direct) {
        // Direct effect declarer is the node itself.
        perEffect.set(e, new Set<string>([n.id]));
      }
    }
    roots.set(n.id, perEffect);
  }

  const order = reversePostorder(callGraph);
  // Worklist initial seed: leaves first per reverse-postorder.
  const worklist: string[] = [...order];
  const inQueue = new Set<string>(order);

  let rounds = 0;
  while (worklist.length > 0) {
    const id = worklist.shift();
    if (id === undefined) {
      break;
    }
    inQueue.delete(id);
    rounds += 1;

    const previous = effective.get(id);
    if (previous === undefined) {
      continue;
    }
    const callees = outgoing.get(id) ?? [];

    let changed = false;
    let rootsChanged = false;
    const rootsForId = roots.get(id);

    const mask = maskOf(id);
    for (const callee of callees) {
      const calleeSet = effective.get(callee);
      if (calleeSet === undefined || calleeSet.size === 0) {
        continue;
      }
      for (const e of calleeSet) {
        if (mask !== undefined && mask.has(e)) {
          // Suppression on `id` blocks the inherited effect — neither the
          // effective set nor the root-tracking should record it.
          continue;
        }
        if (!previous.has(e)) {
          previous.add(e);
          changed = true;
        }
        if (rootsForId !== undefined) {
          const calleeRoots = roots.get(callee)?.get(e);
          if (calleeRoots !== undefined) {
            let bucket = rootsForId.get(e);
            if (bucket === undefined) {
              bucket = new Set<string>();
              rootsForId.set(e, bucket);
              rootsChanged = true;
            }
            for (const r of calleeRoots) {
              if (!bucket.has(r)) {
                bucket.add(r);
                rootsChanged = true;
              }
            }
          }
        }
      }
    }

    if (changed || rootsChanged) {
      // Re-enqueue callers — they may pick up our new effects.
      const callers = incoming.get(id) ?? [];
      for (const caller of callers) {
        if (!inQueue.has(caller)) {
          worklist.push(caller);
          inQueue.add(caller);
        }
      }
    }
  }

  // Freeze + build inherited view.
  const effectiveFrozen = new Map<string, ReadonlySet<string>>();
  const inheritedByNode = new Map<string, ReadonlySet<string>>();
  for (const [id, set] of effective.entries()) {
    const frozen = new Set<string>(
      [...set].sort((a, b) => a.localeCompare(b)),
    );
    effectiveFrozen.set(id, frozen);

    const direct = directByNode.get(id) ?? new Set<string>();
    const inherited = new Set<string>();
    for (const e of frozen) {
      if (!direct.has(e)) {
        inherited.add(e);
      }
    }
    inheritedByNode.set(
      id,
      new Set<string>([...inherited].sort((a, b) => a.localeCompare(b))),
    );
  }

  // Freeze roots map.
  const rootsFrozen = new Map<string, ReadonlyMap<string, readonly string[]>>();
  for (const [id, perEffect] of roots.entries()) {
    const frozenPerEffect = new Map<string, readonly string[]>();
    for (const [e, bucket] of perEffect.entries()) {
      const arr = [...bucket].sort((a, b) => a.localeCompare(b));
      frozenPerEffect.set(e, Object.freeze(arr));
    }
    rootsFrozen.set(id, frozenPerEffect);
  }

  // Promote: ensure `unionEffects` is callable by external users.
  void unionEffects;

  return {
    effectiveByNode: effectiveFrozen,
    directByNode,
    inheritedByNode,
    rounds,
    propagationRoots: rootsFrozen,
  };
}

/**
 * Build a deterministic propagation chain (caller → ... → declarer) for an
 * `(offendingEffect, caller)` pair. Walks callees breadth-first, preferring
 * the shortest chain. Used by the violation builder to render evidence.
 */
export function buildPropagationChain(
  callGraph: CallGraph,
  callerId: string,
  offendingEffect: string,
  effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>,
  directByNode: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  // If caller itself directly declares → trivial chain.
  const callerDirect = directByNode.get(callerId);
  if (callerDirect !== undefined && callerDirect.has(offendingEffect)) {
    return Object.freeze([callerId]);
  }
  const outgoing = buildOutgoingAdjacency(callGraph);
  // BFS for shortest chain to any node directly declaring the effect.
  const visited = new Set<string>([callerId]);
  const queue: Array<{ id: string; path: readonly string[] }> = [
    { id: callerId, path: [callerId] },
  ];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    const callees = outgoing.get(item.id) ?? [];
    for (const c of callees) {
      if (visited.has(c)) {
        continue;
      }
      visited.add(c);
      const childEffective = effectiveByNode.get(c);
      if (childEffective === undefined || !childEffective.has(offendingEffect)) {
        continue;
      }
      const newPath = [...item.path, c];
      const childDirect = directByNode.get(c);
      if (childDirect !== undefined && childDirect.has(offendingEffect)) {
        return Object.freeze(newPath);
      }
      queue.push({ id: c, path: newPath });
    }
  }
  // Fallback: no declarer reached (shouldn't happen for a real violation,
  // but the evaluator must not crash). Return caller only.
  return Object.freeze([callerId]);
}
