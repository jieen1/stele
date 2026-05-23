import { describe, expect, it } from "vitest";

import {
  compileEffectPattern,
  differenceEffects,
  expandEffectPatterns,
  intersectEffects,
  isEffectGlob,
  isSubset,
  renderEffectSet,
  sortedSet,
  unionEffects,
} from "../src/effect-set.js";

describe("unionEffects", () => {
  it("returns empty set when both inputs empty", () => {
    const u = unionEffects([], []);
    expect([...u]).toEqual([]);
  });

  it("returns single element set", () => {
    const u = unionEffects(["db.read"], []);
    expect([...u]).toEqual(["db.read"]);
  });

  it("merges + sorts deterministically (lexicographic)", () => {
    const u = unionEffects(["http.outgoing", "db.read"], ["log.audit", "db.write"]);
    expect([...u]).toEqual(["db.read", "db.write", "http.outgoing", "log.audit"]);
  });

  it("deduplicates overlapping members", () => {
    const u = unionEffects(["db.read", "db.write"], ["db.read"]);
    expect([...u]).toEqual(["db.read", "db.write"]);
  });
});

describe("differenceEffects", () => {
  it("subtracts right from left", () => {
    const d = differenceEffects(["db.read", "db.write"], ["db.read"]);
    expect([...d]).toEqual(["db.write"]);
  });

  it("empty result when subset", () => {
    const d = differenceEffects(["db.read"], ["db.read", "db.write"]);
    expect([...d]).toEqual([]);
  });

  it("returns left unchanged when right is empty", () => {
    const d = differenceEffects(["http.outgoing"], []);
    expect([...d]).toEqual(["http.outgoing"]);
  });
});

describe("intersectEffects", () => {
  it("returns common members", () => {
    const i = intersectEffects(["db.read", "db.write"], ["db.write", "http.outgoing"]);
    expect([...i]).toEqual(["db.write"]);
  });

  it("returns empty for disjoint sets", () => {
    expect([...intersectEffects(["a"], ["b"])]).toEqual([]);
  });
});

describe("isSubset", () => {
  it("returns true for proper subset", () => {
    expect(isSubset(["db.read"], ["db.read", "db.write"])).toBe(true);
  });

  it("returns true for equal sets", () => {
    expect(isSubset(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("returns false when subset has extra member", () => {
    expect(isSubset(["a", "b", "c"], ["a", "b"])).toBe(false);
  });

  it("returns true for empty subset", () => {
    expect(isSubset([], ["a"])).toBe(true);
  });
});

describe("isEffectGlob", () => {
  it("detects asterisk", () => {
    expect(isEffectGlob("payment.*")).toBe(true);
    expect(isEffectGlob("*")).toBe(true);
  });

  it("plain dot-notation is not a glob", () => {
    expect(isEffectGlob("db.read")).toBe(false);
  });
});

describe("compileEffectPattern", () => {
  it("exact match for non-glob", () => {
    const p = compileEffectPattern("db.read");
    expect(p("db.read")).toBe(true);
    expect(p("db.write")).toBe(false);
  });

  it("payment.* matches subtree (single + multi segment)", () => {
    const p = compileEffectPattern("payment.*");
    expect(p("payment.charge")).toBe(true);
    expect(p("payment.refund")).toBe(true);
    // Does not cross to a sibling subtree.
    expect(p("billing.charge")).toBe(false);
  });

  it("universal `*` matches everything", () => {
    const p = compileEffectPattern("*");
    expect(p("db.read")).toBe(true);
    expect(p("anything.at.all")).toBe(true);
  });
});

describe("expandEffectPatterns", () => {
  const declared = new Set([
    "db.read",
    "db.write",
    "http.outgoing",
    "payment.charge",
    "payment.refund",
  ]);

  it("expands a glob to all matching declared effects", () => {
    const e = expandEffectPatterns(["payment.*"], declared);
    expect([...e]).toEqual(["payment.charge", "payment.refund"]);
  });

  it("keeps exact non-glob name even if not declared (defensive)", () => {
    const e = expandEffectPatterns(["unknown.effect"], declared);
    expect([...e]).toEqual(["unknown.effect"]);
  });

  it("merges multiple patterns deterministically", () => {
    const e = expandEffectPatterns(["db.*", "http.outgoing"], declared);
    expect([...e]).toEqual(["db.read", "db.write", "http.outgoing"]);
  });

  it("universal `*` expands to all declared effects", () => {
    const e = expandEffectPatterns(["*"], declared);
    expect([...e].sort()).toEqual([
      "db.read",
      "db.write",
      "http.outgoing",
      "payment.charge",
      "payment.refund",
    ]);
  });
});

describe("sortedSet + renderEffectSet", () => {
  it("sortedSet returns sorted unique values", () => {
    const s = sortedSet(["http.outgoing", "db.read", "db.read", "a.b"]);
    expect([...s]).toEqual(["a.b", "db.read", "http.outgoing"]);
  });

  it("renderEffectSet emits comma-separated bracketed list", () => {
    expect(renderEffectSet(["b", "a"])).toBe("[a, b]");
    expect(renderEffectSet([])).toBe("[]");
  });
});

describe("determinism across runs", () => {
  it("union order is stable for shuffled inputs", () => {
    const a = unionEffects(["c", "a", "b"], ["a", "z"]);
    const b = unionEffects(["z", "b"], ["c", "a"]);
    expect([...a]).toEqual([...b]);
  });
});
