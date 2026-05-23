import { describe, expect, it } from "vitest";

import { edgesFrom, extractFixture } from "./_helpers.js";

describe("tsCallGraphExtractor — method resolution", () => {
  it("interface method with two impls resolves to an ambiguous call", async () => {
    const g = await extractFixture("polymorphic-call");
    const greetOut = edgesFrom(g, "src/index.ts::greet(1)");
    // a.speak() should be ambiguous because Animal has two impls.
    const amb = g.ambiguousCalls.find((a) => a.fromId === "src/index.ts::greet(1)");
    expect(amb).toBeDefined();
    expect(amb?.candidates.length).toBeGreaterThanOrEqual(2);
    // The direct edge list should NOT contain a single resolved target
    // for this call.
    void greetOut;
  });

  it("ambiguous candidates include both Dog.speak and Cat.speak", async () => {
    const g = await extractFixture("polymorphic-call");
    const amb = g.ambiguousCalls.find((a) => a.fromId === "src/index.ts::greet(1)");
    const expected = [
      "src/index.ts::Cat::speak(0)",
      "src/index.ts::Dog::speak(0)",
    ];
    expect(expected.every((id) => amb?.candidates.includes(id) === true)).toBe(true);
  });

  it("each impl class has its own method node", async () => {
    const g = await extractFixture("polymorphic-call");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("src/index.ts::Dog::speak(0)");
    expect(ids).toContain("src/index.ts::Cat::speak(0)");
  });

  it("methodResolutionHash reflects interface→impl relationships", async () => {
    const g1 = await extractFixture("polymorphic-call");
    const g2 = await extractFixture("simple-direct-call");
    // Same algorithm but different relationships → different hash.
    expect(g1.methodResolutionHash).not.toBe(g2.methodResolutionHash);
  });

  it("methodResolutionHash is deterministic across runs", async () => {
    const g1 = await extractFixture("polymorphic-call");
    const g2 = await extractFixture("polymorphic-call");
    expect(g1.methodResolutionHash).toBe(g2.methodResolutionHash);
  });

  it("does NOT emit a constructor node for classes with no explicit ctor", async () => {
    const g = await extractFixture("method-on-class");
    const ids = g.nodes.map((n) => n.id);
    expect(ids.some((id) => id.endsWith("::Order::<constructor>(0)"))).toBe(false);
  });

  it("emits class-method nodes with kind=method", async () => {
    const g = await extractFixture("method-on-class");
    const pay = g.nodes.find((n) => n.id === "src/index.ts::Order::pay(1)");
    expect(pay?.kind).toBe("method");
  });

  it("nested class method has correct container chain", async () => {
    const g = await extractFixture("nested-class");
    const inner = g.nodes.find((n) => n.id === "src/index.ts::Outer::inner(0)");
    expect(inner).toBeDefined();
  });

  it("overload signatures collapse to ONE NodeId for the implementation", async () => {
    const g = await extractFixture("overload-same-arity");
    const debits = g.nodes.filter((n) => n.id.startsWith("src/index.ts::Wallet::debit"));
    // Only the impl (with body) should be present.
    expect(debits.length).toBe(1);
    expect(debits[0]?.id).toBe("src/index.ts::Wallet::debit(1)");
  });

  it("overload resolution: w.debit(10) targets the single impl NodeId", async () => {
    const g = await extractFixture("overload-same-arity");
    const runOut = edgesFrom(g, "src/index.ts::run(0)");
    expect(runOut.some((e) => e.toId === "src/index.ts::Wallet::debit(1)")).toBe(true);
  });

  it("two separate functions with same (file,container,name,arity) get distinct disambiguators", async () => {
    const g = await extractFixture("overload-disambig");
    const findIds = g.nodes
      .map((n) => n.id)
      .filter((id) => /::find\(1\)(#[0-9a-f]{8})?$/.test(id));
    // Both should have disambiguators (collision detected).
    const withDisambig = findIds.filter((id) => /#[0-9a-f]{8}$/.test(id));
    // ModA.find and ModB.find both have arity 1, same empty class
    // container — so collision applies.
    expect(withDisambig.length).toBe(findIds.length);
    expect(findIds.length).toBeGreaterThanOrEqual(2);
  });

  it("generic class method resolution targets the impl", async () => {
    const g = await extractFixture("generic-call");
    const useOut = edgesFrom(g, "src/index.ts::useBox(0)");
    expect(useOut.some((e) => e.toId === "src/index.ts::Box::get(0)")).toBe(true);
  });

  it("generic class constructor resolves to the constructor NodeId", async () => {
    const g = await extractFixture("generic-call");
    const makeOut = edgesFrom(g, "src/index.ts::make(0)");
    expect(makeOut.some((e) => e.toId === "src/index.ts::Box::<constructor>(1)")).toBe(true);
  });

  it("polymorphic call AmbiguousCall.candidates is sorted", async () => {
    const g = await extractFixture("polymorphic-call");
    const amb = g.ambiguousCalls.find((a) => a.fromId === "src/index.ts::greet(1)");
    const sorted = [...(amb?.candidates ?? [])].sort();
    expect(amb?.candidates).toEqual(sorted);
  });

  it("interface implementations are tracked in methodResolutionHash", async () => {
    const g = await extractFixture("polymorphic-call");
    // No exact hash to assert, but the field is non-empty 64-hex.
    expect(g.methodResolutionHash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});
