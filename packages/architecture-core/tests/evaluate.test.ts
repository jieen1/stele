import { describe, expect, it } from "vitest";
import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  DependencyViolation,
  CycleViolation,
} from "../src/types.js";
import {
  evaluateArchitecture,
  findDependencyViolations,
  findCycleViolations,
  detectCycles,
} from "../src/evaluate.js";

function makeDeclaration(
  modules: string[],
  allowDeps: Record<string, string[]> = {},
  denyCycles = true,
): ArchitectureDeclaration {
  return {
    kind: "architecture",
    id: "test-arch",
    lang: "typescript",
    modules: modules.map((id) => ({
      id,
      paths: [`src/${id}/**`],
      publicEntries: [],
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    layers: [],
    allowDependencies: Object.entries(allowDeps).map(([from, to]) => ({
      from,
      to,
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    denyCycles,
  };
}

function makeGraph(
  edges: Array<{ fromModule: string; toModule: string; fromFile: string }>,
): ArchitectureGraph {
  return {
    architectureId: "test-arch",
    modules: {},
    edges: edges.map((e, i) => ({
      ...e,
      specifier: "./test",
      importKind: "static-import",
      line: i + 1,
      column: 1,
    })),
    unownedFiles: [],
    ambiguousFiles: [],
    unresolvedSpecifiers: [],
  };
}

describe("findDependencyViolations", () => {
  it("allows edges that match allow-dependency rules", () => {
    const decl = makeDeclaration(
      ["api", "domain", "infra"],
      { api: ["domain"], domain: ["infra"] },
    );
    const graph = makeGraph([
      { fromModule: "api", toModule: "domain", fromFile: "src/api/app.ts" },
      { fromModule: "domain", toModule: "infra", fromFile: "src/domain/model.ts" },
    ]);

    const violations = findDependencyViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("detects disallowed dependency edges", () => {
    const decl = makeDeclaration(
      ["api", "domain", "infra"],
      { api: ["domain"], domain: ["infra"] },
    );
    const graph = makeGraph([
      { fromModule: "infra", toModule: "api", fromFile: "src/infra/db.ts" },
    ]);

    const violations = findDependencyViolations(decl, graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      fromModule: "infra",
      toModule: "api",
      fromFile: "src/infra/db.ts",
    });
    expect(violations[0].allowedTargets).toEqual([]);
  });

  it("ignores self-dependency edges", () => {
    const decl = makeDeclaration(["api", "domain"], {});
    const graph = makeGraph([
      { fromModule: "api", toModule: "api", fromFile: "src/api/app.ts" },
    ]);

    const violations = findDependencyViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("reports no violations when no allow-dependency rules exist and there are no cross-module edges", () => {
    const decl = makeDeclaration(["api"], {});
    const graph = makeGraph([
      { fromModule: "api", toModule: "api", fromFile: "src/api/app.ts" },
    ]);

    const violations = findDependencyViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });
});

describe("findCycleViolations", () => {
  it("detects a simple two-module cycle", () => {
    const decl = makeDeclaration(["a", "b"], { a: ["b"], b: ["a"] }, true);
    const graph = makeGraph([
      { fromModule: "a", toModule: "b", fromFile: "src/a/index.ts" },
      { fromModule: "b", toModule: "a", fromFile: "src/b/index.ts" },
    ]);

    const violations = findCycleViolations(decl, graph);
    expect(violations).toHaveLength(1);
    expect(violations[0].modules.length).toBeGreaterThanOrEqual(3);
    expect(violations[0].edgeFiles).toContain("src/a/index.ts");
  });

  it("detects a three-module cycle", () => {
    const decl = makeDeclaration(["a", "b", "c"], {}, true);
    const graph = makeGraph([
      { fromModule: "a", toModule: "b", fromFile: "src/a/x.ts" },
      { fromModule: "b", toModule: "c", fromFile: "src/b/y.ts" },
      { fromModule: "c", toModule: "a", fromFile: "src/c/z.ts" },
    ]);

    const violations = findCycleViolations(decl, graph);
    expect(violations).toHaveLength(1);
    const cycle = violations[0];
    expect(cycle.modules.length).toBeGreaterThanOrEqual(4);
    const fileSet = new Set(cycle.edgeFiles);
    expect(fileSet).toContain("src/a/x.ts");
    expect(fileSet).toContain("src/b/y.ts");
    expect(fileSet).toContain("src/c/z.ts");
  });

  it("returns no violations when there are no cycles", () => {
    const decl = makeDeclaration(["a", "b", "c"], { a: ["b"], b: ["c"] }, true);
    const graph = makeGraph([
      { fromModule: "a", toModule: "b", fromFile: "src/a/index.ts" },
      { fromModule: "b", toModule: "c", fromFile: "src/b/index.ts" },
    ]);

    const violations = findCycleViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });
});

describe("detectCycles", () => {
  it("detects cycle from adjacency map", () => {
    const edges = new Map<string, Set<string>>();
    edges.set("a", new Set(["b"]));
    edges.set("b", new Set(["a"]));
    const edgeFiles = new Map<string, Set<string>>();
    edgeFiles.set("a->b", new Set(["src/a.ts"]));
    edgeFiles.set("b->a", new Set(["src/b.ts"]));

    const cycles = detectCycles(["a", "b"], edges, edgeFiles);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].edgeFiles).toContain("src/a.ts");
  });

  it("returns empty for acyclic graph", () => {
    const edges = new Map<string, Set<string>>();
    edges.set("a", new Set(["b"]));
    edges.set("b", new Set(["c"]));

    const cycles = detectCycles(["a", "b", "c"], edges);
    expect(cycles).toHaveLength(0);
  });
});

describe("evaluateArchitecture", () => {
  it("combines dependency violations and cycle violations", () => {
    const decl = makeDeclaration(
      ["api", "domain", "infra"],
      { api: ["domain"] },
      true,
    );
    const graph = makeGraph([
      // Disallowed edge: infra -> api
      { fromModule: "infra", toModule: "api", fromFile: "src/infra/db.ts" },
      // Cycle: api -> domain -> infra -> api (via missing infra->api edge)
      { fromModule: "api", toModule: "domain", fromFile: "src/api/app.ts" },
      { fromModule: "domain", toModule: "infra", fromFile: "src/domain/model.ts" },
      { fromModule: "infra", toModule: "api", fromFile: "src/infra/db.ts" },
    ]);

    const result = evaluateArchitecture(decl, graph);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.cycleViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("skips cycle detection when denyCycles is false", () => {
    const decl = makeDeclaration(["a", "b"], { a: ["b"], b: ["a"] }, false);
    const graph = makeGraph([
      { fromModule: "a", toModule: "b", fromFile: "src/a/index.ts" },
      { fromModule: "b", toModule: "a", fromFile: "src/b/index.ts" },
    ]);

    const result = evaluateArchitecture(decl, graph);
    expect(result.cycleViolations).toHaveLength(0);
  });
});
