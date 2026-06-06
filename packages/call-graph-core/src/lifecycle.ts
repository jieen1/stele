/**
 * Phase 5.4 self-dogfooding — CALLGRAPH_LIFECYCLE phantom types.
 *
 * Phase B evaluators (trace / type-state / effect) must only consume a
 * call graph that has finished building or been hydrated from cache.
 * Feeding an in-progress (Building) graph to an evaluator is undefined
 * behaviour: edges may be missing, the `methodResolutionHash` is unset,
 * the `unresolvedCalls` list may be empty for the wrong reason.
 *
 * The phantom state tracks the graph's lifecycle position:
 *   Empty → Building → Built → Cached.
 *
 * Cached is a terminal state; Built can transition to Cached when the
 * graph is persisted via `.codegraph/` (or equivalent).
 */

import type { CallGraph } from "./types.js";

export type CallGraphState = "Empty" | "Building" | "Built" | "Cached";

export type CallGraphStateBrand<S extends CallGraphState> = {
  readonly [K in CallGraphState as `__callgraph_state_${K}`]: K extends S ? true : never;
};

/**
 * A phantom-state-tagged wrapper around the language-agnostic
 * `CallGraph` shape. The runtime payload is identical to `CallGraph`;
 * the brand exists only at the type level.
 */
export type TypedCallGraph<S extends CallGraphState = "Built"> = CallGraph &
  CallGraphStateBrand<S>;

/**
 * The only call-graph states Phase B evaluators are permitted to
 * consume: a graph that has finished building (`Built`) or been
 * hydrated from cache (`Cached`). An `Empty` or `Building` graph is
 * rejected at the type level. Every evaluator's public entry option
 * (`.callGraph`) must require this union, never plain `CallGraph`.
 */
export type ConsumableCallGraph =
  | TypedCallGraph<"Built">
  | TypedCallGraph<"Cached">;

/**
 * Begin a new build. The returned wrapper is `Empty` — no edges or
 * nodes have been added yet.
 */
export function emptyCallGraph(graph: CallGraph): TypedCallGraph<"Empty"> {
  return graph as TypedCallGraph<"Empty">;
}

/**
 * Mark the graph as `Building` — the extractor has begun walking
 * source files but the result is not yet committed.
 */
export function startBuilding(graph: TypedCallGraph<"Empty">): TypedCallGraph<"Building"> {
  return graph as unknown as TypedCallGraph<"Building">;
}

/**
 * Finalise the graph. Evaluators may only consume a `Built` (or
 * `Cached`) graph; this is the canonical promotion gate.
 */
export function finalizeCallGraph(
  graph: TypedCallGraph<"Building">,
): TypedCallGraph<"Built"> {
  return graph as unknown as TypedCallGraph<"Built">;
}

/**
 * Cache a Built graph. Cached graphs may be consumed by evaluators
 * just like Built graphs.
 */
export function cacheCallGraph(graph: TypedCallGraph<"Built">): TypedCallGraph<"Cached"> {
  return graph as unknown as TypedCallGraph<"Cached">;
}
