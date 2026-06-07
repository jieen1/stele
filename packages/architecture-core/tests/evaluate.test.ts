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
  findLayerDirectionViolations,
  findPublicEntryViolations,
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

  // @tcb-negative @stele/architecture-core
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

function makeDeclarationWithLayers(
  modules: string[],
  allowDeps: Record<string, string[]> = {},
  layers: Array<{ id: string; modules: string[] }> = [],
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
    layers: layers.map((l) => ({
      id: l.id,
      modules: l.modules,
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    allowDependencies: Object.entries(allowDeps).map(([from, to]) => ({
      from,
      to,
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    denyCycles,
  };
}

describe("findLayerDirectionViolations", () => {
  it("detects lower-layer importing from higher-layer", () => {
    // layers: [0]=high, [1]=low. Low module importing high module is violation.
    const decl = makeDeclarationWithLayers(
      ["high", "low"],
      {},
      [
        { id: "layer-high", modules: ["high"] },
        { id: "layer-low", modules: ["low"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "low", toModule: "high", fromFile: "src/low/app.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      fromModule: "low",
      toModule: "high",
      fromLayer: "layer-low",
      toLayer: "layer-high",
    });
  });

  it("allows higher-layer importing from lower-layer", () => {
    const decl = makeDeclarationWithLayers(
      ["high", "low"],
      {},
      [
        { id: "layer-high", modules: ["high"] },
        { id: "layer-low", modules: ["low"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "high", toModule: "low", fromFile: "src/high/app.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("allows same-layer imports", () => {
    const decl = makeDeclarationWithLayers(
      ["a", "b"],
      {},
      [
        { id: "layer-same", modules: ["a", "b"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "a", toModule: "b", fromFile: "src/a/app.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("skips edges permitted by allowDependencies", () => {
    const decl = makeDeclarationWithLayers(
      ["high", "low"],
      { low: ["high"] }, // explicitly allow low -> high
      [
        { id: "layer-high", modules: ["high"] },
        { id: "layer-low", modules: ["low"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "low", toModule: "high", fromFile: "src/low/app.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("skips modules not in any layer", () => {
    const decl = makeDeclarationWithLayers(
      ["a", "b", "c"],
      {},
      [
        { id: "layer-a", modules: ["a"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "b", toModule: "c", fromFile: "src/b/app.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("detects multi-layer violation across three layers", () => {
    const decl = makeDeclarationWithLayers(
      ["top", "mid", "bottom"],
      {},
      [
        { id: "layer-top", modules: ["top"] },
        { id: "layer-mid", modules: ["mid"] },
        { id: "layer-bottom", modules: ["bottom"] },
      ],
    );
    const graph = makeGraph([
      { fromModule: "bottom", toModule: "top", fromFile: "src/bottom/app.ts" },
      { fromModule: "mid", toModule: "top", fromFile: "src/mid/app.ts" },
      { fromModule: "bottom", toModule: "mid", fromFile: "src/bottom/app2.ts" },
    ]);

    const violations = findLayerDirectionViolations(decl, graph);
    expect(violations).toHaveLength(3);
  });
});

function makeDeclarationWithPublicEntries(
  modules: Array<{ id: string; publicEntries: string[] }>,
  allowDeps: Record<string, string[]> = {},
): ArchitectureDeclaration {
  return {
    kind: "architecture",
    id: "test-arch",
    lang: "typescript",
    modules: modules.map((m) => ({
      id: m.id,
      paths: [`src/${m.id}/**`],
      publicEntries: m.publicEntries,
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    layers: [],
    allowDependencies: Object.entries(allowDeps).map(([from, to]) => ({
      from,
      to,
      span: { file: "test.stele", line: 1, column: 1 },
    })),
    denyCycles: true,
  };
}

function makeGraphWithSpecifiers(
  edges: Array<{
    fromModule: string;
    toModule: string;
    fromFile: string;
    specifier: string;
    toFile?: string;
  }>,
  moduleFiles: Record<string, string[]> = {},
): ArchitectureGraph {
  return {
    architectureId: "test-arch",
    modules: moduleFiles,
    edges: edges.map((e, i) => ({
      fromModule: e.fromModule,
      toModule: e.toModule,
      fromFile: e.fromFile,
      toFile: e.toFile,
      specifier: e.specifier,
      importKind: "static-import",
      line: i + 1,
      column: 1,
    })),
    unownedFiles: [],
    ambiguousFiles: [],
    unresolvedSpecifiers: [],
  };
}

describe("findPublicEntryViolations", () => {
  it("detects import bypassing public entry", () => {
    const decl = makeDeclarationWithPublicEntries(
      [
        { id: "lib", publicEntries: ["./index"] },
        { id: "app", publicEntries: [] },
      ],
      { app: ["lib"] },
    );
    const graph = makeGraphWithSpecifiers([
      { fromModule: "app", toModule: "lib", fromFile: "src/app/main.ts", specifier: "./internal/helper", toFile: "src/lib/internal/helper.ts" },
    ]);

    const violations = findPublicEntryViolations(decl, graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      fromModule: "app",
      toModule: "lib",
      specifier: "./internal/helper",
      publicEntries: ["./index"],
    });
  });

  it("allows import through public entry", () => {
    const decl = makeDeclarationWithPublicEntries(
      [
        { id: "lib", publicEntries: ["./index", "./utils"] },
        { id: "app", publicEntries: [] },
      ],
      { app: ["lib"] },
    );
    const graph = makeGraphWithSpecifiers([
      { fromModule: "app", toModule: "lib", fromFile: "src/app/main.ts", specifier: "./index", toFile: "src/lib/index.ts" },
    ]);

    const violations = findPublicEntryViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("exempts same-module imports", () => {
    const decl = makeDeclarationWithPublicEntries(
      [
        { id: "lib", publicEntries: ["./index"] },
      ],
      {},
    );
    const graph = makeGraphWithSpecifiers([
      { fromModule: "lib", toModule: "lib", fromFile: "src/lib/a.ts", specifier: "./b", toFile: "src/lib/b.ts" },
    ]);

    const violations = findPublicEntryViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("skips modules without public entries declared", () => {
    const decl = makeDeclarationWithPublicEntries(
      [
        { id: "lib", publicEntries: [] },
        { id: "app", publicEntries: [] },
      ],
      { app: ["lib"] },
    );
    const graph = makeGraphWithSpecifiers([
      { fromModule: "app", toModule: "lib", fromFile: "src/app/main.ts", specifier: "./anything", toFile: "src/lib/anything.ts" },
    ]);

    const violations = findPublicEntryViolations(decl, graph);
    expect(violations).toHaveLength(0);
  });

  it("reports multiple violations for different specifiers", () => {
    const decl = makeDeclarationWithPublicEntries(
      [
        { id: "lib", publicEntries: ["./index"] },
        { id: "app", publicEntries: [] },
      ],
      { app: ["lib"] },
    );
    const graph = makeGraphWithSpecifiers([
      { fromModule: "app", toModule: "lib", fromFile: "src/app/a.ts", specifier: "./internal/x", toFile: "src/lib/internal/x.ts" },
      { fromModule: "app", toModule: "lib", fromFile: "src/app/b.ts", specifier: "./internal/y", toFile: "src/lib/internal/y.ts" },
    ]);

    const violations = findPublicEntryViolations(decl, graph);
    expect(violations).toHaveLength(2);
  });
});
