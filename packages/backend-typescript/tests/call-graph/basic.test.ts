import { describe, expect, it } from "vitest";

import { edgesFrom, edgesTo, extractFixture, fixturePath } from "./_helpers.js";

describe("tsCallGraphExtractor — basic", () => {
  it("produces schemaVersion 1 and typescript language", async () => {
    const g = await extractFixture("simple-direct-call");
    expect(g.schemaVersion).toBe("1");
    expect(g.language).toBe("typescript");
  });

  it("sets projectRoot to the fixture absolute path", async () => {
    const g = await extractFixture("simple-direct-call");
    expect(g.projectRoot).toBe(fixturePath("simple-direct-call"));
  });

  it("emits a node for each top-level function declaration", async () => {
    const g = await extractFixture("simple-direct-call");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("src/index.ts::callee(1)");
    expect(ids).toContain("src/index.ts::caller(0)");
  });

  it("connects caller → callee with a direct edge", async () => {
    const g = await extractFixture("simple-direct-call");
    const out = edgesFrom(g, "src/index.ts::caller(0)");
    expect(out.length).toBe(1);
    expect(out[0]?.toId).toBe("src/index.ts::callee(1)");
  });

  it("captures the chain A → B → C as two edges", async () => {
    const g = await extractFixture("chain-three-functions");
    const aOut = edgesFrom(g, "src/index.ts::a(0)");
    const bOut = edgesFrom(g, "src/index.ts::b(0)");
    expect(aOut[0]?.toId).toBe("src/index.ts::b(0)");
    expect(bOut[0]?.toId).toBe("src/index.ts::c(0)");
    expect(g.edges.length).toBe(2);
  });

  it("captures mutual recursion as two reciprocal edges", async () => {
    const g = await extractFixture("mutual-recursion");
    const evenOut = edgesFrom(g, "src/index.ts::isEven(1)");
    const oddOut = edgesFrom(g, "src/index.ts::isOdd(1)");
    expect(evenOut.some((e) => e.toId === "src/index.ts::isOdd(1)")).toBe(true);
    expect(oddOut.some((e) => e.toId === "src/index.ts::isEven(1)")).toBe(true);
  });

  it("emits no edges from never-called functions", async () => {
    const g = await extractFixture("simple-direct-call");
    expect(edgesTo(g, "src/index.ts::caller(0)").length).toBe(0);
  });

  it("counts arity excluding implicit this and matching declared params", async () => {
    const g = await extractFixture("method-on-class");
    expect(g.nodes.find((n) => n.id === "src/index.ts::Order::pay(1)")).toBeDefined();
    expect(g.nodes.find((n) => n.id === "src/index.ts::Order::log(1)")).toBeDefined();
  });

  it("captures method call obj.pay()", async () => {
    const g = await extractFixture("method-on-class");
    const runOut = edgesFrom(g, "src/index.ts::run(0)");
    expect(runOut.some((e) => e.toId === "src/index.ts::Order::pay(1)")).toBe(true);
  });

  it("captures internal this.method() calls", async () => {
    const g = await extractFixture("method-on-class");
    const payOut = edgesFrom(g, "src/index.ts::Order::pay(1)");
    expect(payOut.some((e) => e.toId === "src/index.ts::Order::log(1)")).toBe(true);
  });

  it("marks exported declarations isExported=true", async () => {
    const g = await extractFixture("simple-direct-call");
    const callee = g.nodes.find((n) => n.id === "src/index.ts::callee(1)");
    expect(callee?.isExported).toBe(true);
  });

  it("marks default-exported functions isExported=true", async () => {
    const g = await extractFixture("default-export-arrow");
    const entry = g.nodes.find((n) => n.id === "src/index.ts::entry(0)");
    expect(entry?.isExported).toBe(true);
  });

  it("emits stable, sorted nodes across runs", async () => {
    const g1 = await extractFixture("chain-three-functions");
    const g2 = await extractFixture("chain-three-functions");
    expect(g1.nodes.map((n) => n.id)).toEqual(g2.nodes.map((n) => n.id));
    expect(g1.edges).toEqual(g2.edges);
  });

  it("populates fileHashes for visited files", async () => {
    const g = await extractFixture("chain-three-functions");
    expect(Object.keys(g.fileHashes)).toContain("src/index.ts");
    expect(g.fileHashes["src/index.ts"]).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("emits a methodResolutionHash even when there are no impls", async () => {
    const g = await extractFixture("simple-direct-call");
    expect(g.methodResolutionHash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("records the definition span line/column", async () => {
    const g = await extractFixture("simple-direct-call");
    const callee = g.nodes.find((n) => n.id === "src/index.ts::callee(1)");
    expect(callee?.span.line).toBe(1);
    expect(callee?.span.column).toBeGreaterThan(0);
    expect(callee?.span.endLine).toBeGreaterThanOrEqual(callee!.span.line);
  });

  it("kind=function for free fns, method for class methods, constructor for new()", async () => {
    const g = await extractFixture("constructor-call");
    const ctor = g.nodes.find((n) => n.id === "src/index.ts::Widget::<constructor>(1)");
    const fn = g.nodes.find((n) => n.id === "src/index.ts::make(0)");
    expect(ctor?.kind).toBe("constructor");
    expect(fn?.kind).toBe("function");
  });

  it("treats `new X()` as a call edge to the constructor", async () => {
    const g = await extractFixture("constructor-call");
    const makeOut = edgesFrom(g, "src/index.ts::make(0)");
    expect(makeOut.some((e) => e.toId === "src/index.ts::Widget::<constructor>(1)")).toBe(true);
  });

  it("captures multiple new() calls in one function", async () => {
    const g = await extractFixture("new-expression");
    const out = edgesFrom(g, "src/index.ts::makeThings(0)");
    const ctorId = "src/index.ts::Thing::<constructor>(1)";
    expect(out.filter((e) => e.toId === ctorId).length).toBe(2);
  });

  it("captures `isAsync=true` on async function declarations", async () => {
    const g = await extractFixture("async-call");
    const fd = g.nodes.find((n) => n.id === "src/index.ts::fetchData(0)");
    expect(fd?.isAsync).toBe(true);
  });

  it("lambda bound to a variable uses the variable name", async () => {
    const g = await extractFixture("lambda-call");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("src/index.ts::doubled(1)");
  });

  it("inner arrow function bound to const uses the local name", async () => {
    const g = await extractFixture("lambda-call");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("src/index.ts::local(1)");
  });

  it("withArrow → local edge is captured", async () => {
    const g = await extractFixture("lambda-call");
    const out = edgesFrom(g, "src/index.ts::withArrow(0)");
    expect(out.some((e) => e.toId === "src/index.ts::local(1)")).toBe(true);
  });

  it("conditional edge has isConditional=true, isLoop=false", async () => {
    const g = await extractFixture("conditional-call");
    const out = edgesFrom(g, "src/index.ts::caller(1)");
    const edge = out.find((e) => e.toId === "src/index.ts::helper(0)");
    expect(edge?.isConditional).toBe(true);
    expect(edge?.isLoop).toBe(false);
  });

  it("loop edge has isLoop=true, isConditional=false", async () => {
    const g = await extractFixture("loop-call");
    const out = edgesFrom(g, "src/index.ts::caller(0)");
    const edge = out.find((e) => e.toId === "src/index.ts::tick(0)");
    expect(edge?.isLoop).toBe(true);
    expect(edge?.isConditional).toBe(false);
  });

  it("edge callSite line/column point inside the caller body", async () => {
    const g = await extractFixture("simple-direct-call");
    const out = edgesFrom(g, "src/index.ts::caller(0)");
    const edge = out[0];
    expect(edge?.callSite.line).toBeGreaterThan(4);
    expect(edge?.callSite.column).toBeGreaterThan(0);
  });

  it("nested-class method captures internal this.helper() call", async () => {
    const g = await extractFixture("nested-class");
    const innerOut = edgesFrom(g, "src/index.ts::Outer::inner(0)");
    expect(innerOut.some((e) => e.toId === "src/index.ts::Outer::helper(0)")).toBe(true);
  });
});
