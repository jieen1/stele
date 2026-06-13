import { describe, expect, it } from "vitest";

import type { CallGraph, UnresolvedCall } from "../src/types.js";
import { assertValidCallGraph } from "../src/validate.js";

function graphWith(unresolvedCalls: unknown[]): CallGraph {
  return {
    schemaVersion: "1",
    language: "python",
    projectRoot: "/tmp/x",
    nodes: [],
    edges: [],
    unresolvedCalls: unresolvedCalls as unknown as readonly UnresolvedCall[],
    ambiguousCalls: [],
    fileHashes: {},
    methodResolutionHash: "0".repeat(64),
  } as unknown as CallGraph;
}

const VALID: UnresolvedCall = {
  fromId: "a.py::f",
  callSite: { line: 1, column: 1, endLine: 1, endColumn: 2 },
  rawText: "table[name]()",
  reason: "dynamic",
  nameHidden: true,
};

describe("assertValidCallGraph", () => {
  it("accepts a well-formed graph", () => {
    expect(() => assertValidCallGraph(graphWith([VALID]), "test")).not.toThrow();
    expect(() => assertValidCallGraph(graphWith([]), "test")).not.toThrow();
  });

  it("REJECTS an unresolved call missing nameHidden (the P0 regression)", () => {
    const { nameHidden: _drop, ...withoutNameHidden } = VALID;
    expect(() => assertValidCallGraph(graphWith([withoutNameHidden]), "python extractor")).toThrow(
      /nameHidden/,
    );
  });

  it("rejects a non-boolean nameHidden", () => {
    expect(() =>
      assertValidCallGraph(graphWith([{ ...VALID, nameHidden: "true" }]), "test"),
    ).toThrow(/nameHidden/);
  });

  it("rejects an unknown reason", () => {
    expect(() =>
      assertValidCallGraph(graphWith([{ ...VALID, reason: "made-up" }]), "test"),
    ).toThrow(/reason/);
  });

  it("rejects a non-array unresolvedCalls", () => {
    expect(() => assertValidCallGraph(graphWith(null as unknown as unknown[]), "test")).toThrow(
      /unresolvedCalls/,
    );
  });

  it("rejects a non-string fromId", () => {
    expect(() =>
      assertValidCallGraph(graphWith([{ ...VALID, fromId: 42 }]), "test"),
    ).toThrow(/fromId/);
  });
});
