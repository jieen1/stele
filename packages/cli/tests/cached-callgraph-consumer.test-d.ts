/**
 * Compile-time test for the CALLGRAPH_LIFECYCLE consumer contract.
 *
 * The Phase B evaluators (trace / type-state / effect) require a
 * `ConsumableCallGraph` (= `TypedCallGraph<"Built"> | TypedCallGraph<"Cached">`)
 * at their public option type, so an `Empty` or `Building` graph — which has
 * incomplete edges / unresolvedCalls — cannot be fed to an evaluator. This
 * file pins that the brand discriminator rejects the non-consumable states.
 * Pin removal must surface a TS2345/TS2322 error from
 *   pnpm --filter @stele/cli typecheck
 */

import {
  cacheCallGraph,
  emptyCallGraph,
  finalizeCallGraph,
  startBuilding,
  type ConsumableCallGraph,
  type TypedCallGraph,
} from "@stele/call-graph-core";
import type { CallGraph } from "@stele/call-graph-core";

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

// Stand-in for the Phase B evaluator entry point, whose option type requires
// a ConsumableCallGraph (e.g. `evaluateTypeStates({ callGraph })`).
const consume = (_graph: ConsumableCallGraph): void => {};

// Happy path — both Built and Cached are consumable by Phase B evaluators.
consume(built);
consume(cached);

// Building is NOT consumable — its edges/unresolvedCalls are incomplete.
// @ts-expect-error — Building cannot be assigned to ConsumableCallGraph
consume(building);

// Empty is NOT consumable — even further from a usable graph.
// @ts-expect-error — Empty cannot be assigned to ConsumableCallGraph
consume(empty);
