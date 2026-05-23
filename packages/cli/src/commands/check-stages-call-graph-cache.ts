import type { CallGraph } from "@stele/call-graph-core";
import type { PreparedCheckContext } from "../architecture/types.js";

/**
 * Shared CallGraph cache used by the trace and type-state stages within a
 * single `stele check` invocation. Keyed by `PreparedCheckContext` (a fresh
 * object per run), so entries are auto-evicted when the context is GC'd.
 *
 * Both stages compute the same CallGraph for the same project; storing it
 * once means `dependsOn: ["trace"]` ordering lets the type-state stage reuse
 * the graph the trace stage already extracted.
 */
const callGraphCache: WeakMap<PreparedCheckContext, CallGraph> = new WeakMap();

export function getCachedCallGraph(
  context: PreparedCheckContext,
): CallGraph | undefined {
  return callGraphCache.get(context);
}

export function setCachedCallGraph(
  context: PreparedCheckContext,
  callGraph: CallGraph,
): void {
  callGraphCache.set(context, callGraph);
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
