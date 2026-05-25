import { describe, expect, it } from "vitest";

import { edgesFrom, extractFixture } from "./_helpers.js";

describe("tsCallGraphExtractor — super() resolution", () => {
  it("super(arg) in a class extending an in-project parent resolves to the parent's ctor", async () => {
    const g = await extractFixture("super-call");
    const midCtor = "src/index.ts::Mid::<constructor>(2)";
    const baseCtor = "src/index.ts::Base::<constructor>(1)";
    const out = edgesFrom(g, midCtor);
    expect(out.some((e) => e.toId === baseCtor)).toBe(true);
  });

  it("super(...) is never reported as an unresolved call", async () => {
    const g = await extractFixture("super-call");
    for (const u of g.unresolvedCalls) {
      expect(u.rawText.startsWith("super(")).toBe(false);
    }
  });

  it("super(arg) two levels deep resolves to the nearest in-project ancestor's ctor", async () => {
    const g = await extractFixture("super-call");
    const leafCtor = "src/index.ts::Leaf::<constructor>(1)";
    const midCtor = "src/index.ts::Mid::<constructor>(2)";
    const out = edgesFrom(g, leafCtor);
    expect(out.some((e) => e.toId === midCtor)).toBe(true);
  });

  it("super(arg) in a class extending built-in Error emits no in-project edge and no unresolved entry", async () => {
    const g = await extractFixture("super-call-builtin");
    const myErrorCtor = "src/index.ts::MyError::<constructor>(2)";
    const out = edgesFrom(g, myErrorCtor);
    // No edge pointing at an in-project node should originate from MyError's ctor's super(...) call.
    // (the super call only targets a built-in; the body has no other calls)
    expect(out.length).toBe(0);
    for (const u of g.unresolvedCalls) {
      expect(u.fromId === myErrorCtor && u.rawText.startsWith("super(")).toBe(false);
    }
  });
});

describe("tsCallGraphExtractor — new X() of implicit-ctor class", () => {
  it("new X() of a same-file class with no explicit ctor is structurally resolved (no unresolved entry)", async () => {
    const g = await extractFixture("new-same-file-implicit-ctor");
    const caller = "src/index.ts::makeRegistry(0)";
    const unresolvedFromCaller = g.unresolvedCalls.filter((u) => u.fromId === caller);
    expect(unresolvedFromCaller.length).toBe(0);
  });

  it("new X() of a cross-file imported class with an explicit ctor produces a resolved edge", async () => {
    const g = await extractFixture("new-cross-file-import");
    const caller = "src/index.ts::makeWidget(0)";
    const out = edgesFrom(g, caller);
    expect(out.some((e) => e.toId === "src/widget.ts::Widget::<constructor>(1)")).toBe(true);
    const unresolvedFromCaller = g.unresolvedCalls.filter((u) => u.fromId === caller);
    expect(unresolvedFromCaller.length).toBe(0);
  });
});
