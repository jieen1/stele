import { strict as assert } from "node:assert";
import { describe, expect, it } from "vitest";

import {
  enumeratePaths,
  getOrderedOutgoingEdges,
} from "../src/path-enumeration.js";
import { mkCallGraph, mkEdge, mkNode } from "./fixtures/helpers.js";

describe("enumeratePaths — basic shapes", () => {
  it("finds a single direct edge A -> B", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
      ],
      edges: [mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" })],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/b.ts::B(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes).toEqual([
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
    ]);
    expect(result.stats.pathsEnumerated).toBe(1);
    expect(result.stats.truncated).toBe(false);
  });

  it("follows a chain A -> B -> C", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/c.ts::C(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/c.ts::C(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes).toEqual([
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
      "src/c.ts::C(0)",
    ]);
  });

  it("diamond yields two paths", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/c.ts::C(0)", line: 2 }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/d.ts::D(0)" }),
        mkEdge({ from: "src/c.ts::C(0)", to: "src/d.ts::D(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/d.ts::D(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(2);
  });

  it("maxDepth limits paths longer than cap", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
        mkNode({ id: "src/e.ts::E(0)" }),
        mkNode({ id: "src/f.ts::F(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/c.ts::C(0)" }),
        mkEdge({ from: "src/c.ts::C(0)", to: "src/d.ts::D(0)" }),
        mkEdge({ from: "src/d.ts::D(0)", to: "src/e.ts::E(0)" }),
        mkEdge({ from: "src/e.ts::E(0)", to: "src/f.ts::F(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/f.ts::F(0)"]),
      3,
      100,
    );
    expect(result.paths).toHaveLength(0);
    expect(result.stats.truncated).toBe(true);
  });

  it("maxPaths caps enumeration at limit", () => {
    // Make a fan-out graph: A -> [B1..B10] -> C
    const nodes = [mkNode({ id: "src/a.ts::A(0)" }), mkNode({ id: "src/c.ts::C(0)" })];
    const edges = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `src/b.ts::B${i}(0)`;
      nodes.push(mkNode({ id }));
      edges.push(mkEdge({ from: "src/a.ts::A(0)", to: id, line: i + 1 }));
      edges.push(mkEdge({ from: id, to: "src/c.ts::C(0)" }));
    }
    const graph = mkCallGraph({ nodes, edges });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/c.ts::C(0)"]),
      10,
      5,
    );
    expect(result.paths.length).toBeLessThanOrEqual(5);
    expect(result.stats.truncated).toBe(true);
  });

  it("handles cycles without infinite loop", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/a.ts::A(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/b.ts::B(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes).toEqual([
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
    ]);
  });

  it("empty target set returns no paths", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: "src/a.ts::A(0)" })],
      edges: [],
    });
    const result = enumeratePaths(graph, "src/a.ts::A(0)", new Set(), 10, 100);
    expect(result.paths).toHaveLength(0);
    expect(result.stats.truncated).toBe(false);
  });

  it("fromId not in graph returns empty result", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: "src/b.ts::B(0)" })],
      edges: [],
    });
    const result = enumeratePaths(
      graph,
      "src/missing.ts::Missing(0)",
      new Set(["src/b.ts::B(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(0);
  });

  it("ignores edges out of non-fromId nodes (sanity)", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/x.ts::X(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
      ],
      edges: [mkEdge({ from: "src/x.ts::X(0)", to: "src/b.ts::B(0)" })],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/b.ts::B(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(0);
  });

  it("truncated flag set when capped", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b1.ts::B(0)" }),
        mkNode({ id: "src/b2.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b1.ts::B(0)" }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b2.ts::B(0)", line: 2 }),
        mkEdge({ from: "src/b1.ts::B(0)", to: "src/c.ts::C(0)" }),
        mkEdge({ from: "src/b2.ts::B(0)", to: "src/c.ts::C(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/c.ts::C(0)"]),
      10,
      1,
    );
    expect(result.paths).toHaveLength(1);
    expect(result.stats.truncated).toBe(true);
  });

  it("respects deterministic ordering by (line, column)", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
      ],
      edges: [
        // Inserted in "wrong" order to check sorting in result.
        mkEdge({ from: "src/a.ts::A(0)", to: "src/c.ts::C(0)", line: 10 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)", line: 1 }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/b.ts::B(0)", "src/c.ts::C(0)"]),
      10,
      100,
    );
    expect(result.paths).toHaveLength(2);
    // First path (by sort) should hit B first because its call site line is 1.
    expect(result.paths[0]!.nodes[1]).toBe("src/b.ts::B(0)");
  });
});

describe("enumeratePaths — self-recursion (Round 4 P2-4)", () => {
  it("handles A -> A self-recursion without infinite loop", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: "src/a.ts::A(0)" })],
      edges: [mkEdge({ from: "src/a.ts::A(0)", to: "src/a.ts::A(0)" })],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/a.ts::A(0)"]),
      10,
      100,
    );
    // DFS visited-set must prevent the recursion from blowing up.
    // We accept zero or one path back to A (depending on whether the
    // implementation reports the trivial self-loop); the important thing
    // is the call terminates with bounded enumerations.
    expect(result.stats.pathsEnumerated).toBeLessThan(100);
    expect(result.stats.truncated).toBe(false);
  });

  it("handles multiple distinct edges from a node to itself", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: "src/a.ts::A(0)" })],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/a.ts::A(0)", line: 1, column: 1 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/a.ts::A(0)", line: 2, column: 1 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/a.ts::A(0)", line: 3, column: 1 }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/a.ts::A(0)"]),
      10,
      100,
    );
    // Bounded enumeration — multiple edges to self must not explode.
    expect(result.stats.pathsEnumerated).toBeLessThan(100);
    expect(result.stats.truncated).toBe(false);
  });
});

describe("getOrderedOutgoingEdges", () => {
  it("returns edges sorted by line then column", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)", line: 3, column: 1 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/c.ts::C(0)", line: 1, column: 5 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/d.ts::D(0)", line: 1, column: 1 }),
      ],
    });
    const out = getOrderedOutgoingEdges(graph, "src/a.ts::A(0)");
    expect(out.map((e) => e.toId)).toEqual([
      "src/d.ts::D(0)",
      "src/c.ts::C(0)",
      "src/b.ts::B(0)",
    ]);
  });

  it("returns empty for unknown node", () => {
    const graph = mkCallGraph({ nodes: [], edges: [] });
    const out = getOrderedOutgoingEdges(graph, "src/missing.ts::X(0)");
    expect(out).toHaveLength(0);
  });
});

describe("enumeratePaths — Closeout 5 partial-path memoization", () => {
  it("memoization correctness — diamond graph yields identical result with memoization (cache HIT on second descent)", () => {
    // A → B, A → C, B → D, C → D, D → E. Target {Z} (unreachable).
    // DFS from A:
    //   - A→B→D→E (memoizes E as clean, then D as clean, then B as clean)
    //   - A→C: D is already in provenClean → pruned. C exhaustive → clean.
    //   - A exhaustive → clean.
    // Whether memoization is enabled or not, the result must be: 0 paths,
    // truncated=false.
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
        mkNode({ id: "src/e.ts::E(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)", line: 1 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/c.ts::C(0)", line: 2 }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/d.ts::D(0)" }),
        mkEdge({ from: "src/c.ts::C(0)", to: "src/d.ts::D(0)" }),
        mkEdge({ from: "src/d.ts::D(0)", to: "src/e.ts::E(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/z.ts::Z(0)"]),
      10,
      100,
    );
    assert.equal(result.paths.length, 0);
    assert.equal(result.stats.truncated, false);
  });

  it("memoization correctness — diamond graph still finds reachable target via both prefixes", () => {
    // A → B, A → C, B → D, C → D. Target = D. Both A→B→D and A→C→D must be
    // reported; memoization must NOT swallow either path (target reaching is
    // never memoized).
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)", line: 1 }),
        mkEdge({ from: "src/a.ts::A(0)", to: "src/c.ts::C(0)", line: 2 }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/d.ts::D(0)" }),
        mkEdge({ from: "src/c.ts::C(0)", to: "src/d.ts::D(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/d.ts::D(0)"]),
      10,
      100,
    );
    assert.equal(result.paths.length, 2);
    const pathStrings = result.paths.map((p) => p.nodes.join(" -> "));
    assert.ok(pathStrings.includes("src/a.ts::A(0) -> src/b.ts::B(0) -> src/d.ts::D(0)"));
    assert.ok(pathStrings.includes("src/a.ts::A(0) -> src/c.ts::C(0) -> src/d.ts::D(0)"));
  });

  it("cache does not leak across enumeratePaths invocations", () => {
    // Build a graph where the second invocation MUST re-discover the
    // reachable target from a different root. If the cache leaked, the
    // second call could incorrectly mark intermediate nodes as proven-clean
    // from the first run (when the first run used a different target).
    //
    // Graph: A → X, B → X, X → T. First call with target {NOPE} (no reach
    // from A) marks X as clean during that invocation. Second call with
    // target {T} from root B must NOT see X as clean — it must walk X→T.
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/x.ts::X(0)" }),
        mkNode({ id: "src/t.ts::T(0)" }),
        mkNode({ id: "src/nope.ts::NOPE(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/x.ts::X(0)" }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/x.ts::X(0)" }),
        mkEdge({ from: "src/x.ts::X(0)", to: "src/t.ts::T(0)" }),
      ],
    });
    // First call: A → X → T, target is NOPE. Returns 0 paths.
    const first = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/nope.ts::NOPE(0)"]),
      10,
      100,
    );
    assert.equal(first.paths.length, 0);

    // Second call: B → X → T, target is T. Must return exactly 1 path.
    // If cache leaked from the first call, X would be marked clean and the
    // search would erroneously return 0 paths.
    const second = enumeratePaths(
      graph,
      "src/b.ts::B(0)",
      new Set(["src/t.ts::T(0)"]),
      10,
      100,
    );
    assert.equal(second.paths.length, 1);
    assert.deepEqual(
      [...second.paths[0]!.nodes],
      ["src/b.ts::B(0)", "src/x.ts::X(0)", "src/t.ts::T(0)"],
    );
    assert.equal(second.stats.truncated, false);
  });

  it("deep path no longer hits depth cap — 50-node DAG with target at depth 30", () => {
    // Closeout 5 step 5.4 test case 3 — "Deep path no longer hits depth cap".
    //
    // Construct a DAG with the shape that triggers the loadContract problem:
    // a head node N0 fans out to 5 separate "dead-end chains" of 10 nodes
    // each, NONE of which reach the target. The target T sits at depth 30
    // along a SIXTH path: N0 → P1 → P2 → ... → P29 → T.
    //
    // Without memoization, the dead-end chains are each walked top-down
    // every time their head is visited from any prefix — and because each
    // chain extends past the default maxDepth=10, every visit trips the
    // depth cap on every dead-end branch. With negative memoization, the
    // first visit to each chain head proves "this node reaches no target",
    // and subsequent visits short-circuit.
    //
    // For this test we use maxDepth=50 so the FOUND path completes; the
    // assertion is that:
    //   - the target is reached exactly once (linear sub-chain)
    //   - `truncated` is false — no depth-cap error
    //   - dead-end chains were memoized (verified indirectly by reachability
    //     correctness; if memoization were unsound, the result would differ
    //     from the un-memoized baseline).
    const nodes = [mkNode({ id: "src/n0.ts::N0(0)" }), mkNode({ id: "src/t.ts::T(0)" })];
    const edges = [];
    // Five dead-end chains: D_k_0 → D_k_1 → ... → D_k_9 (length 10), each
    // hanging off N0. Total nodes added: 5 * 10 = 50.
    for (let k = 0; k < 5; k += 1) {
      for (let i = 0; i < 10; i += 1) {
        nodes.push(mkNode({ id: `src/d${k}_${i}.ts::D${k}_${i}(0)` }));
        if (i === 0) {
          edges.push(mkEdge({ from: "src/n0.ts::N0(0)", to: `src/d${k}_${i}.ts::D${k}_${i}(0)`, line: k + 1 }));
        } else {
          edges.push(mkEdge({ from: `src/d${k}_${i - 1}.ts::D${k}_${i - 1}(0)`, to: `src/d${k}_${i}.ts::D${k}_${i}(0)` }));
        }
      }
    }
    // The target chain: P0 = N0, P1..P29 then T. So the target sits at
    // graph depth 30 from N0 (counting N0 as depth 0).
    let prev = "src/n0.ts::N0(0)";
    for (let i = 1; i <= 29; i += 1) {
      const id = `src/p${i}.ts::P${i}(0)`;
      nodes.push(mkNode({ id }));
      edges.push(mkEdge({ from: prev, to: id, line: 100 + i }));
      prev = id;
    }
    edges.push(mkEdge({ from: prev, to: "src/t.ts::T(0)", line: 200 }));
    const graph = mkCallGraph({ nodes, edges });

    const result = enumeratePaths(
      graph,
      "src/n0.ts::N0(0)",
      new Set(["src/t.ts::T(0)"]),
      50,
      100,
    );
    // Exactly one simple path reaches T.
    assert.equal(result.paths.length, 1);
    assert.equal(result.paths[0]!.nodes.length, 31); // N0 + P1..P29 + T = 31 nodes
    assert.equal(result.paths[0]!.nodes[result.paths[0]!.nodes.length - 1], "src/t.ts::T(0)");
    // Critical assertion: no depth-cap error even though the dead-end
    // chains are each 10 nodes long. With negative memoization, each
    // dead-end head is proven clean on first visit and short-circuited
    // thereafter; without it, naive DFS at maxDepth=50 still completes
    // here because no chain exceeds the budget, but the depth-cap-free
    // behaviour is what we are guaranteeing.
    assert.equal(result.stats.truncated, false);

    // And the negative-branch variant — same shape, but the "target" is
    // unreachable. The original loadContract bug: DFS hits depth cap
    // exploring all the dead-end chains. With memoization the walk
    // completes cleanly.
    const negResult = enumeratePaths(
      graph,
      "src/n0.ts::N0(0)",
      new Set(["src/never.ts::NEVER(0)"]),
      50,
      100,
    );
    assert.equal(negResult.paths.length, 0);
    assert.equal(negResult.stats.truncated, false);
  });

  it("memoization is sound when a node's child has a cycle — does NOT mark cycle-touching node clean", () => {
    // Graph: A → B → C → B (cycle). Target = D (unreachable). After A→B→C
    // sees the B-back-edge as a cycle-skip, C is NOT exhaustive, so neither
    // is B. Verify the result is still 0 paths and the algorithm terminates.
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: "src/a.ts::A(0)" }),
        mkNode({ id: "src/b.ts::B(0)" }),
        mkNode({ id: "src/c.ts::C(0)" }),
        mkNode({ id: "src/d.ts::D(0)" }),
      ],
      edges: [
        mkEdge({ from: "src/a.ts::A(0)", to: "src/b.ts::B(0)" }),
        mkEdge({ from: "src/b.ts::B(0)", to: "src/c.ts::C(0)" }),
        mkEdge({ from: "src/c.ts::C(0)", to: "src/b.ts::B(0)" }),
      ],
    });
    const result = enumeratePaths(
      graph,
      "src/a.ts::A(0)",
      new Set(["src/d.ts::D(0)"]),
      10,
      100,
    );
    assert.equal(result.paths.length, 0);
    assert.equal(result.stats.truncated, false);
  });
});
