import type { CallGraph, TypedCallGraph } from "@stele/call-graph-core";
import {
  cacheCallGraph,
  emptyCallGraph,
  finalizeCallGraph,
  startBuilding,
} from "@stele/call-graph-core";
import type { PreparedCheckContext } from "../architecture/types.js";

/**
 * Shared CallGraph cache used by the trace and type-state stages within a
 * single `stele check` invocation. Keyed by `PreparedCheckContext` (a fresh
 * object per run), so entries are auto-evicted when the context is GC'd.
 *
 * Both stages compute the same CallGraph for the same project; storing it
 * once means `dependsOn: ["trace"]` ordering lets the type-state stage reuse
 * the graph the trace stage already extracted.
 *
 * Closeout 4 (self-dogfooding plan): the cache stores `TypedCallGraph<"Cached">`,
 * the lifecycle's terminal-consumable state. The wrap-as-cached transition
 * `emptyCallGraph → startBuilding → finalizeCallGraph → cacheCallGraph`
 * happens in `wrapExtractedGraph` so every evaluator gets a typed value
 * regardless of cache hit or miss.
 */
const callGraphCache: WeakMap<PreparedCheckContext, TypedCallGraph<"Cached">> = new WeakMap();

export function getCachedCallGraph(
  context: PreparedCheckContext,
): TypedCallGraph<"Cached"> | undefined {
  return callGraphCache.get(context);
}

export function setCachedCallGraph(
  context: PreparedCheckContext,
  callGraph: TypedCallGraph<"Cached">,
): void {
  callGraphCache.set(context, callGraph);
}

/**
 * Closeout 4 typed wrap: take a freshly-extracted `CallGraph`, chain it
 * through the CALLGRAPH_LIFECYCLE transitions, and return the terminal
 * `TypedCallGraph<"Cached">`. Persisting under the WeakMap is the
 * runtime side of `cacheCallGraph`; the brand carries the typestate.
 */
export function wrapExtractedGraph(
  graph: CallGraph,
): TypedCallGraph<"Cached"> {
  const empty = emptyCallGraph(graph);
  const building = startBuilding(empty);
  const built = finalizeCallGraph(building);
  return cacheCallGraph(built);
}

/**
 * Closeout 4: typed consumer for a cached call graph. Accepts only a
 * `TypedCallGraph<"Cached">` so evaluators cannot consume an Empty or
 * Building graph (which would have incomplete edges + unresolvedCalls).
 * The matching `(type-state-binding ...)` in `contract/main.stele`
 * pins param 0 to state `Cached`; the evaluator's
 * wrong_state_at_binding rule fires on a state mismatch.
 *
 * Returns the underlying `CallGraph` field so existing evaluator
 * call sites keep their access pattern.
 *
 * The `graph.valueOf()` call below is the receiver-method site the
 * TS type-state extractor inspects: it produces an inference whose
 * receiver type is `TypedCallGraph<"Cached">`, which the evaluator
 * compares against the binding's declared state.
 */
export function useCachedCallGraph(
  graph: TypedCallGraph<"Cached">,
): CallGraph {
  graph.valueOf();
  return graph as CallGraph;
}

/**
 * Test helper — clears the WeakMap entry for one context. Production code
 * should never call this; the cache auto-clears when its key context object
 * is GC'd. Exported only so unit tests can assert "second call re-extracts
 * after eviction".
 */
export function _clearCallGraphCacheForTests(context: PreparedCheckContext): void {
  callGraphCache.delete(context);
}
