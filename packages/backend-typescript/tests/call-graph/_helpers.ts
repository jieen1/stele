import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CallGraph, CallGraphEdge } from "@stele/call-graph-core";

import { tsCallGraphExtractor } from "../../src/extractors/call-graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return resolve(__dirname, "fixtures", name);
}

export async function extractFixture(name: string): Promise<CallGraph> {
  return tsCallGraphExtractor.extract({ projectRoot: fixturePath(name) });
}

export function findNode(graph: CallGraph, predicate: (id: string) => boolean): string | undefined {
  return graph.nodes.find((n) => predicate(n.id))?.id;
}

export function edgesFrom(graph: CallGraph, fromId: string): readonly CallGraphEdge[] {
  return graph.edges.filter((e) => e.fromId === fromId);
}

export function edgesTo(graph: CallGraph, toId: string): readonly CallGraphEdge[] {
  return graph.edges.filter((e) => e.toId === toId);
}
