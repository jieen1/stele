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
