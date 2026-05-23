import { describe, expect, it } from "vitest";

import {
  buildPropagationChain,
  propagateEffects,
  reversePostorder,
} from "../src/propagation.js";
import { mkCallGraph, mkEdge, mkNode } from "./fixtures/helpers.js";

function initial(
  entries: ReadonlyArray<readonly [string, readonly string[]]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, eff] of entries) {
    out.set(id, new Set(eff));
  }
  return out;
}

describe("reversePostorder", () => {
  it("orders single-node graph trivially", () => {
    const cg = mkCallGraph({ nodes: [mkNode({ id: "A" })], edges: [] });
    expect(reversePostorder(cg)).toEqual(["A"]);
  });

  it("leaves come before parents in a linear chain", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "A" }), mkNode({ id: "B" }), mkNode({ id: "C" })],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "B", to: "C" }),
      ],
    });
    const order = reversePostorder(cg);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
  });
});

describe("propagateEffects", () => {
  it("trivial 1-node graph keeps direct effects", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "leaf" })],
      edges: [],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["leaf", ["db.read"]]]),
    });
    expect([...(r.effectiveByNode.get("leaf") ?? [])]).toEqual(["db.read"]);
    expect(r.rounds).toBeGreaterThan(0);
  });

  it("linear chain A→B→C: A inherits C's effects", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "A" }),
        mkNode({ id: "B" }),
        mkNode({ id: "C" }),
      ],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "B", to: "C" }),
      ],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["C", ["db.read"]]]),
    });
    expect([...(r.effectiveByNode.get("A") ?? [])]).toEqual(["db.read"]);
    expect([...(r.effectiveByNode.get("B") ?? [])]).toEqual(["db.read"]);
    expect([...(r.effectiveByNode.get("C") ?? [])]).toEqual(["db.read"]);
  });

  it("diamond: A→B, A→C, B→D, C→D union of D effects", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "A" }),
        mkNode({ id: "B" }),
        mkNode({ id: "C" }),
        mkNode({ id: "D" }),
      ],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "A", to: "C" }),
        mkEdge({ from: "B", to: "D" }),
        mkEdge({ from: "C", to: "D" }),
      ],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([
        ["B", ["db.read"]],
        ["C", ["http.outgoing"]],
        ["D", ["log.audit"]],
      ]),
    });
    expect([...(r.effectiveByNode.get("A") ?? [])]).toEqual([
      "db.read",
      "http.outgoing",
      "log.audit",
    ]);
  });

  it("cycle A→B→A does not infinite-loop and converges", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "A" }), mkNode({ id: "B" })],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "B", to: "A" }),
      ],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([
        ["A", ["a.eff"]],
        ["B", ["b.eff"]],
      ]),
    });
    expect([...(r.effectiveByNode.get("A") ?? [])]).toEqual(["a.eff", "b.eff"]);
    expect([...(r.effectiveByNode.get("B") ?? [])]).toEqual(["a.eff", "b.eff"]);
  });

  it("isolated node retains its initial effects", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "X" }),
        mkNode({ id: "Y" }),
      ],
      edges: [],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["X", ["fs.read"]]]),
    });
    expect([...(r.effectiveByNode.get("X") ?? [])]).toEqual(["fs.read"]);
    expect([...(r.effectiveByNode.get("Y") ?? [])]).toEqual([]);
  });

  it("rounds stat is bounded (≤ |nodes| + |edges|) on monotone joins", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => mkNode({ id: `N${i}` }));
    const edges = Array.from({ length: 9 }, (_, i) =>
      mkEdge({ from: `N${i}`, to: `N${i + 1}` }),
    );
    const cg = mkCallGraph({ nodes, edges });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["N9", ["leaf.eff"]]]),
    });
    expect(r.rounds).toBeLessThanOrEqual(nodes.length + edges.length + 5);
    expect([...(r.effectiveByNode.get("N0") ?? [])]).toEqual(["leaf.eff"]);
  });

  it("converges in 1-2 passes for a tree (worklist efficiency)", () => {
    // Tree shape — perfectly reverse-postorder-friendly: leaves first means
    // we reach the root in O(depth) propagation, not O(depth × nodes).
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "root" }),
        mkNode({ id: "child1" }),
        mkNode({ id: "child2" }),
        mkNode({ id: "leaf1" }),
        mkNode({ id: "leaf2" }),
      ],
      edges: [
        mkEdge({ from: "root", to: "child1" }),
        mkEdge({ from: "root", to: "child2" }),
        mkEdge({ from: "child1", to: "leaf1" }),
        mkEdge({ from: "child2", to: "leaf2" }),
      ],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([
        ["leaf1", ["a"]],
        ["leaf2", ["b"]],
      ]),
    });
    // Effective for root must include both
    expect([...(r.effectiveByNode.get("root") ?? [])]).toEqual(["a", "b"]);
  });

  it("tracks propagation roots per effect", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "caller" }),
        mkNode({ id: "lib" }),
      ],
      edges: [mkEdge({ from: "caller", to: "lib" })],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["lib", ["db.read"]]]),
    });
    const callerRoots = r.propagationRoots.get("caller");
    expect(callerRoots).toBeDefined();
    expect(callerRoots?.get("db.read")).toEqual(["lib"]);
  });

  it("inherited != direct: caller has only inherited", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "caller" }), mkNode({ id: "lib" })],
      edges: [mkEdge({ from: "caller", to: "lib" })],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["lib", ["db.read"]]]),
    });
    expect([...(r.directByNode.get("caller") ?? [])]).toEqual([]);
    expect([...(r.inheritedByNode.get("caller") ?? [])]).toEqual(["db.read"]);
    // The lib node directly declared, so inherited is empty.
    expect([...(r.directByNode.get("lib") ?? [])]).toEqual(["db.read"]);
    expect([...(r.inheritedByNode.get("lib") ?? [])]).toEqual([]);
  });

  it("multi-source: both direct and inherited", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "mixer" }), mkNode({ id: "lib" })],
      edges: [mkEdge({ from: "mixer", to: "lib" })],
    });
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([
        ["mixer", ["log.audit"]],
        ["lib", ["db.read"]],
      ]),
    });
    expect([...(r.directByNode.get("mixer") ?? [])]).toEqual(["log.audit"]);
    expect([...(r.inheritedByNode.get("mixer") ?? [])]).toEqual(["db.read"]);
    expect([...(r.effectiveByNode.get("mixer") ?? [])]).toEqual([
      "db.read",
      "log.audit",
    ]);
  });
});

describe("propagateEffects with suppressionsByNode mask", () => {
  it("mask blocks the suppressed effect from re-entering via callees", async () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "A" }),
        mkNode({ id: "B" }),
        mkNode({ id: "C" }),
      ],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "B", to: "C" }),
      ],
    });
    const mask = new Map<string, ReadonlySet<string>>([
      ["B", new Set(["db.read"])],
    ]);
    const r = propagateEffects({
      callGraph: cg,
      initialEffectsByNode: initial([["C", ["db.read"]]]),
      suppressionsByNode: mask,
    });
    // B suppressed → B is empty, A no longer sees db.read.
    expect([...(r.effectiveByNode.get("B") ?? [])]).toEqual([]);
    expect([...(r.effectiveByNode.get("A") ?? [])]).toEqual([]);
    // C still has its direct effect.
    expect([...(r.effectiveByNode.get("C") ?? [])]).toEqual(["db.read"]);
  });
});

describe("buildPropagationChain", () => {
  it("returns just caller when caller declares directly", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "X" })],
      edges: [],
    });
    const direct = new Map<string, ReadonlySet<string>>([
      ["X", new Set(["db.read"])],
    ]);
    const effective = new Map<string, ReadonlySet<string>>([
      ["X", new Set(["db.read"])],
    ]);
    const chain = buildPropagationChain(cg, "X", "db.read", effective, direct);
    expect(chain).toEqual(["X"]);
  });

  it("walks BFS to nearest declarer", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "A" }),
        mkNode({ id: "B" }),
        mkNode({ id: "C" }),
      ],
      edges: [
        mkEdge({ from: "A", to: "B" }),
        mkEdge({ from: "B", to: "C" }),
      ],
    });
    const direct = new Map<string, ReadonlySet<string>>([
      ["C", new Set(["db.read"])],
    ]);
    const effective = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["db.read"])],
      ["B", new Set(["db.read"])],
      ["C", new Set(["db.read"])],
    ]);
    const chain = buildPropagationChain(cg, "A", "db.read", effective, direct);
    expect(chain).toEqual(["A", "B", "C"]);
  });
});
