/**
 * Phase 5.4 type-state self-protection — compile-time test for
 * `CALLGRAPH_LIFECYCLE` phantom-state discipline.
 *
 * To re-verify the brand: remove a `@ts-expect-error` line, run
 * `pnpm --filter @stele/call-graph-core typecheck`, expect TS2345.
 */

import {
  cacheCallGraph,
  emptyCallGraph,
  finalizeCallGraph,
  startBuilding,
  type TypedCallGraph,
} from "../src/lifecycle.js";
import type { CallGraph } from "../src/types.js";

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

// Happy path — Empty → Building → Built → Cached.
const empty: TypedCallGraph<"Empty"> = emptyCallGraph(blank);
const building: TypedCallGraph<"Building"> = startBuilding(empty);
const built: TypedCallGraph<"Built"> = finalizeCallGraph(building);
const cached: TypedCallGraph<"Cached"> = cacheCallGraph(built);
void cached;

// 1. Cannot finalize an Empty graph — must transition through Building first.
// @ts-expect-error — Empty cannot be passed where Building is required
finalizeCallGraph(empty);

// 2. Cannot cache a still-Building graph.
// @ts-expect-error — Building cannot be passed where Built is required
cacheCallGraph(building);

// 3. A raw `CallGraph` cannot be passed where `TypedCallGraph<"Built">` is
//    required — the brand must be obtained through the transition chain.
// @ts-expect-error — CallGraph is not assignable to TypedCallGraph<"Built">
const smuggled: TypedCallGraph<"Built"> = blank;
void smuggled;
