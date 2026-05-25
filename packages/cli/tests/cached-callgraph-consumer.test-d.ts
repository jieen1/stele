/**
 * Closeout 4 — compile-time test for the CALLGRAPH_LIFECYCLE typed
 * consumer (`useCachedCallGraph`) that lives in the CLI package.
 *
 * The call-graph-core package owns the lifecycle transitions and has its
 * own `.test-d.ts` for the transitions themselves; this file pins
 * compile-time enforcement of the typed consumer's brand requirement
 * (param 0 must be `TypedCallGraph<"Cached">`). Pin removal must surface
 * a TS2345 argument-not-assignable error from
 *   pnpm --filter @stele/cli typecheck
 */

import {
  cacheCallGraph,
  emptyCallGraph,
  finalizeCallGraph,
  startBuilding,
  type TypedCallGraph,
} from "@stele/call-graph-core";
import type { CallGraph } from "@stele/call-graph-core";
import { useCachedCallGraph } from "../src/commands/check-stages-call-graph-cache.js";

const blank: CallGraph = {
  schemaVersion: "1",
  language: "typescript",
  generatedAt: "1970-01-01T00:00:00Z",
  projectRoot: "/tmp/fixture",
  nodes: [],
  edges: [],
  unresolvedCalls: [],
  ambiguousCalls: [],
  methodResolutionHash: "0".repeat(64),
  fileHashes: {},
};

const empty: TypedCallGraph<"Empty"> = emptyCallGraph(blank);
const building: TypedCallGraph<"Building"> = startBuilding(empty);
const built: TypedCallGraph<"Built"> = finalizeCallGraph(building);
const cached: TypedCallGraph<"Cached"> = cacheCallGraph(built);

// Happy path — useCachedCallGraph accepts the Cached brand.
void useCachedCallGraph(cached);

// Closeout 4: useCachedCallGraph requires `Cached`. Passing `Built`
// (one transition short) MUST fail — the brand is the runtime gate
// that the lifecycle reached the cached terminal state.
// @ts-expect-error — Built cannot be passed where useCachedCallGraph requires Cached
useCachedCallGraph(built);

// Closeout 4: same for `Building` — even further from the terminal state.
// @ts-expect-error — Building cannot be passed where useCachedCallGraph requires Cached
useCachedCallGraph(building);
