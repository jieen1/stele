import { describe, expect, it } from "vitest";

import {
  computeDisambiguator,
  formatNodeId,
  parseNodeId,
} from "../src/node-id.js";

describe("parseNodeId", () => {
  it("parses TS-style class method NodeId", () => {
    const r = parseNodeId("src/order.ts::Order::pay(1)");
    expect(r).not.toBeNull();
    expect(r?.filePath).toBe("src/order.ts");
    expect(r?.container).toEqual(["Order"]);
    expect(r?.symbolName).toBe("pay");
    expect(r?.arity).toBe(1);
    expect(r?.isExtern).toBe(false);
    expect(r?.disambiguator).toBeUndefined();
  });

  it("parses an extern NodeId", () => {
    const r = parseNodeId("extern:stripe::Charges::create(2)");
    expect(r).not.toBeNull();
    expect(r?.isExtern).toBe(true);
    expect(r?.externLogicalName).toBe("stripe");
    expect(r?.filePath).toBeUndefined();
    expect(r?.container).toEqual(["Charges"]);
    expect(r?.symbolName).toBe("create");
    expect(r?.arity).toBe(2);
  });

  it("parses a NodeId with disambiguator", () => {
    const r = parseNodeId("src/order.ts::Order::pay(1)#a3f5b7c2");
    expect(r).not.toBeNull();
    expect(r?.disambiguator).toBe("a3f5b7c2");
  });

  it("parses a free-function NodeId (empty container)", () => {
    const r = parseNodeId("src/util.ts::formatDate(1)");
    expect(r).not.toBeNull();
    expect(r?.container).toEqual([]);
    expect(r?.symbolName).toBe("formatDate");
    expect(r?.arity).toBe(1);
  });

  it("parses a lambda NodeId", () => {
    const r = parseNodeId("src/handler.ts::lambda@42:7(0)");
    expect(r).not.toBeNull();
    expect(r?.symbolName).toBe("lambda@42:7");
    expect(r?.arity).toBe(0);
    expect(r?.container).toEqual([]);
  });

  it("parses nested container chains", () => {
    const r = parseNodeId("src/a.ts::OuterClass::InnerClass::method(2)");
    expect(r).not.toBeNull();
    expect(r?.container).toEqual(["OuterClass", "InnerClass"]);
    expect(r?.symbolName).toBe("method");
    expect(r?.arity).toBe(2);
  });

  it("returns null for malformed input", () => {
    expect(parseNodeId("")).toBeNull();
    expect(parseNodeId("no-double-colon")).toBeNull();
    expect(parseNodeId("::orphan(0)")).toBeNull();
    expect(parseNodeId("src/x.ts::foo")).toBeNull();
    expect(parseNodeId("src/x.ts::foo()garbage")).toBeNull();
  });

  it("returns null for invalid disambiguator format", () => {
    // 7 hex chars — too short.
    expect(parseNodeId("src/x.ts::f(0)#a3f5b7c")).toBeNull();
    // Uppercase hex — must be lowercase.
    expect(parseNodeId("src/x.ts::f(0)#A3F5B7C2")).toBeNull();
  });

  it("returns null for negative or non-integer arity", () => {
    expect(parseNodeId("src/x.ts::f(-1)")).toBeNull();
    expect(parseNodeId("src/x.ts::f(1.5)")).toBeNull();
    expect(parseNodeId("src/x.ts::f(abc)")).toBeNull();
  });

  it("parses arity zero", () => {
    const r = parseNodeId("src/x.ts::Service::init(0)");
    expect(r).not.toBeNull();
    expect(r?.arity).toBe(0);
  });

  it("does NOT count implicit receivers in arity (trust extractor)", () => {
    // We don't strip — we trust the extractor formatted correctly.
    // `Order::pay(1)` always means "1 business parameter".
    const r = parseNodeId("src/order.py::Order::pay(1)");
    expect(r?.arity).toBe(1);
    const r2 = parseNodeId("src/order.go::Order::Pay(1)");
    expect(r2?.arity).toBe(1);
  });
});

describe("formatNodeId", () => {
  it("formats a simple method NodeId", () => {
    const s = formatNodeId({
      filePath: "src/order.ts",
      container: ["Order"],
      symbolName: "pay",
      arity: 1,
    });
    expect(s).toBe("src/order.ts::Order::pay(1)");
  });

  it("formats a free function NodeId", () => {
    const s = formatNodeId({
      filePath: "src/util.ts",
      symbolName: "formatDate",
      arity: 1,
    });
    expect(s).toBe("src/util.ts::formatDate(1)");
  });

  it("formats an extern NodeId", () => {
    const s = formatNodeId({
      externLogicalName: "stripe",
      container: ["Charges"],
      symbolName: "create",
      arity: 2,
    });
    expect(s).toBe("extern:stripe::Charges::create(2)");
  });

  it("includes disambiguator when provided", () => {
    const s = formatNodeId({
      filePath: "src/wallet.java",
      container: ["Wallet"],
      symbolName: "debit",
      arity: 1,
      disambiguator: "a3f5b7c2",
    });
    expect(s).toBe("src/wallet.java::Wallet::debit(1)#a3f5b7c2");
  });

  it("throws when both filePath and externLogicalName are provided", () => {
    expect(() =>
      formatNodeId({
        filePath: "src/x.ts",
        externLogicalName: "stripe",
        symbolName: "f",
        arity: 0,
      }),
    ).toThrow();
  });

  it("throws when neither filePath nor externLogicalName is provided", () => {
    expect(() => formatNodeId({ symbolName: "f", arity: 0 })).toThrow();
  });

  it("throws on invalid disambiguator", () => {
    expect(() =>
      formatNodeId({
        filePath: "src/x.ts",
        symbolName: "f",
        arity: 0,
        disambiguator: "BADD",
      }),
    ).toThrow();
  });
});

describe("round-trip parse/format", () => {
  it("preserves a simple method NodeId", () => {
    const id = "src/order.ts::Order::pay(1)";
    const p = parseNodeId(id);
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(
      formatNodeId({
        filePath: p.filePath,
        externLogicalName: p.externLogicalName,
        container: p.container,
        symbolName: p.symbolName,
        arity: p.arity,
        disambiguator: p.disambiguator,
      }),
    ).toBe(id);
  });

  it("preserves an extern NodeId with disambiguator", () => {
    const id = "extern:stripe::Charges::create(2)#deadbeef";
    const p = parseNodeId(id);
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(
      formatNodeId({
        filePath: p.filePath,
        externLogicalName: p.externLogicalName,
        container: p.container,
        symbolName: p.symbolName,
        arity: p.arity,
        disambiguator: p.disambiguator,
      }),
    ).toBe(id);
  });

  it("preserves nested container chain", () => {
    const id = "src/a.ts::OuterClass::InnerClass::method(2)";
    const p = parseNodeId(id);
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(
      formatNodeId({
        filePath: p.filePath,
        container: p.container,
        symbolName: p.symbolName,
        arity: p.arity,
      }),
    ).toBe(id);
  });
});

describe("computeDisambiguator", () => {
  it("returns exactly 8 hex characters", () => {
    const d = computeDisambiguator("BigDecimal");
    expect(d).toMatch(/^[0-9a-f]{8}$/);
    expect(d.length).toBe(8);
  });

  it("is deterministic", () => {
    expect(computeDisambiguator("BigDecimal, String")).toBe(
      computeDisambiguator("BigDecimal, String"),
    );
  });

  it("collapses whitespace runs", () => {
    expect(computeDisambiguator("BigDecimal, String")).toBe(
      computeDisambiguator("BigDecimal,  String"),
    );
    expect(computeDisambiguator("BigDecimal, String")).toBe(
      computeDisambiguator("BigDecimal,\tString"),
    );
  });

  it("strips leading/trailing whitespace", () => {
    expect(computeDisambiguator("BigDecimal")).toBe(
      computeDisambiguator("  BigDecimal  "),
    );
  });

  it("distinguishes meaningfully different signatures", () => {
    expect(computeDisambiguator("BigDecimal")).not.toBe(
      computeDisambiguator("MoneyAmount"),
    );
  });
});
