import { describe, expect, it } from "vitest";

import { edgesFrom, extractFixture } from "./_helpers.js";

/**
 * Closeout 2 (2026-05-25) — `allowJs: true` + walker accepts
 * .js/.cjs/.mjs. These tests verify that the TS call-graph extractor
 * now includes JavaScript source files in nodes/edges, that call edges
 * resolve in both directions across the language boundary, and that
 * NodeId conventions are stable across language so existing trace/
 * effect contract bindings do not drift.
 */
describe("tsCallGraphExtractor — allowJs (.js/.cjs/.mjs)", () => {
  it("emits nodes for .js, .ts, and .mjs files; excludes .d.ts", async () => {
    const g = await extractFixture("js-files-included");
    const ids = g.nodes.map((n) => n.id);

    expect(ids).toContain("src/plain.js::fromJs(1)");
    expect(ids).toContain("src/plain.js::jsCaller(1)");
    expect(ids).toContain("src/module.mjs::fromMjs(1)");
    expect(ids).toContain("src/typed.ts::fromTs(1)");

    // .d.ts declarations are ambient — must never produce nodes.
    const fromDeclaration = ids.filter((id) => id.includes("types.d.ts"));
    expect(fromDeclaration).toEqual([]);
  });

  it("emits .cjs files when included via tsconfig", async () => {
    const g = await extractFixture("js-files-included");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("src/legacy.cjs::fromCjs(1)");
  });

  it("captures .js → .js call edges within the same file", async () => {
    const g = await extractFixture("js-files-included");
    const out = edgesFrom(g, "src/plain.js::jsCaller(1)");
    expect(out.some((e) => e.toId === "src/plain.js::fromJs(1)")).toBe(true);
  });

  it("resolves .ts → .js cross-language call as an in-project edge", async () => {
    const g = await extractFixture("js-ts-cross-call");
    const out = edgesFrom(g, "src/ts-side.ts::tsCallsJs(1)");
    const target = "src/js-side.js::jsHelper(1)";
    expect(out.some((e) => e.toId === target)).toBe(true);
    // Confirm it is NOT recorded as unresolved.
    const unresolvedFromTs = g.unresolvedCalls.filter(
      (u) => u.fromId === "src/ts-side.ts::tsCallsJs(1)",
    );
    expect(unresolvedFromTs).toEqual([]);
  });

  it("resolves .js → .ts cross-language call as an in-project edge", async () => {
    const g = await extractFixture("js-ts-cross-call");
    const out = edgesFrom(g, "src/js-side.js::jsCallsTs(1)");
    const target = "src/ts-side.ts::tsExport(1)";
    expect(out.some((e) => e.toId === target)).toBe(true);
    const unresolvedFromJs = g.unresolvedCalls.filter(
      (u) => u.fromId === "src/js-side.js::jsCallsTs(1)",
    );
    expect(unresolvedFromJs).toEqual([]);
  });

  it("NodeId convention is identical for the same shape in .js vs .ts", async () => {
    const tsGraph = await extractFixture("js-nodeid-stable-ts");
    const jsGraph = await extractFixture("js-nodeid-stable-js");

    const tsNode = tsGraph.nodes.find((n) => n.id === "src/lib.ts::foo(1)");
    const jsNode = jsGraph.nodes.find((n) => n.id === "src/lib.js::foo(1)");

    expect(tsNode).toBeDefined();
    expect(jsNode).toBeDefined();

    // NodeIds differ only by file extension — same `::foo(1)` suffix.
    expect(tsNode!.id.endsWith("::foo(1)")).toBe(true);
    expect(jsNode!.id.endsWith("::foo(1)")).toBe(true);

    // Both report kind=function and isExported=true.
    expect(tsNode!.kind).toBe("function");
    expect(jsNode!.kind).toBe("function");
    expect(tsNode!.isExported).toBe(true);
    expect(jsNode!.isExported).toBe(true);
  });
});
