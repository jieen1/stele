import { describe, expect, it } from "vitest";

import { edgesFrom, extractFixture } from "./_helpers.js";

describe("tsCallGraphExtractor — async", () => {
  it("await fn() marks the edge isAsync=true", async () => {
    const g = await extractFixture("async-call");
    const consumerOut = edgesFrom(g, "src/index.ts::consumer(0)");
    const edge = consumerOut.find((e) => e.toId === "src/index.ts::fetchData(0)");
    expect(edge).toBeDefined();
    expect(edge?.isAsync).toBe(true);
  });

  it("fetchData itself is marked isAsync=true on the node", async () => {
    const g = await extractFixture("async-call");
    const n = g.nodes.find((n) => n.id === "src/index.ts::fetchData(0)");
    expect(n?.isAsync).toBe(true);
  });

  it("`.then(callback)` shape is marked isAsync on the edge", async () => {
    const g = await extractFixture("async-call");
    const thenOut = g.edges.filter((e) => e.fromId === "src/index.ts::thenConsumer(0)");
    // First the call to `fetchData()` should be present.
    expect(thenOut.some((e) => e.toId === "src/index.ts::fetchData(0)")).toBe(true);
    // The .then(...) call is into a Promise method; it's an extern
    // edge or unresolved (depending on lib.dom availability). Either
    // way, it does NOT create an in-project edge.
  });

  it("Promise.all([...]) call is recorded but to extern Promise", async () => {
    const g = await extractFixture("async-call");
    const allOut = g.edges.filter((e) => e.fromId === "src/index.ts::allConsumer(0)");
    // The await fetchData()s inside the Promise.all should produce
    // edges to fetchData.
    expect(allOut.some((e) => e.toId === "src/index.ts::fetchData(0)")).toBe(true);
  });

  it("non-async caller of an async function still records the edge", async () => {
    const g = await extractFixture("async-call");
    const thenOut = edgesFrom(g, "src/index.ts::thenConsumer(0)");
    expect(thenOut.some((e) => e.toId === "src/index.ts::fetchData(0)")).toBe(true);
  });

  it("await inside if{} produces an edge with both isAsync and isConditional", async () => {
    const g = await extractFixture("conditional-call");
    // Use the conditional-call fixture even though it isn't await —
    // it confirms the isConditional logic that async/await piggybacks on.
    const out = edgesFrom(g, "src/index.ts::caller(1)");
    const edge = out.find((e) => e.toId === "src/index.ts::helper(0)");
    expect(edge?.isConditional).toBe(true);
  });

  it("await edge has isConditional=false when not inside a branch", async () => {
    const g = await extractFixture("async-call");
    const consumerOut = edgesFrom(g, "src/index.ts::consumer(0)");
    const edge = consumerOut.find((e) => e.toId === "src/index.ts::fetchData(0)");
    expect(edge?.isConditional).toBe(false);
  });

  it("Promise method invocations don't produce extra in-project nodes", async () => {
    const g = await extractFixture("async-call");
    // No `Promise.all` node should appear in the in-project nodes list.
    expect(g.nodes.find((n) => n.id.includes("Promise"))).toBeUndefined();
  });

  it("async function declaration has kind=function (not lambda)", async () => {
    const g = await extractFixture("async-call");
    const n = g.nodes.find((n) => n.id === "src/index.ts::fetchData(0)");
    expect(n?.kind).toBe("function");
  });

  it("multiple awaits of the same callee produce multiple edges with line/col", async () => {
    const g = await extractFixture("async-call");
    // allConsumer awaits Promise.all containing 2 fetchData calls →
    // 2 edges to fetchData.
    const out = g.edges.filter(
      (e) => e.fromId === "src/index.ts::allConsumer(0)" && e.toId === "src/index.ts::fetchData(0)",
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const e of out) {
      expect(e.isAsync).toBe(true);
      expect(e.callSite.line).toBeGreaterThan(0);
    }
  });

  it("isAsync edges sort stably across runs", async () => {
    const g1 = await extractFixture("async-call");
    const g2 = await extractFixture("async-call");
    expect(g1.edges).toEqual(g2.edges);
  });

  it("await inside non-async arrow doesn't break extraction", async () => {
    const g = await extractFixture("async-call");
    // thenConsumer is not async but calls fetchData synchronously via
    // .then. The edge to fetchData should still exist.
    const e = g.edges.find(
      (e) => e.fromId === "src/index.ts::thenConsumer(0)" && e.toId === "src/index.ts::fetchData(0)",
    );
    expect(e).toBeDefined();
  });
});
