import { describe, expect, it } from "vitest";
import type { AstNode, AtomNode, InvariantDeclaration, ListNode, SourceSpan } from "@stele/core";
import { translateContract } from "../src/lint/translate.js";

const SPAN: SourceSpan = { file: "test.stele", line: 1, column: 1 };

function ident(value: string): AtomNode {
  return { kind: "identifier", value, span: SPAN };
}
function str(value: string): AtomNode {
  return { kind: "string", value, span: SPAN };
}
function num(raw: string): AtomNode {
  return { kind: "number", value: Number(raw), raw, span: SPAN };
}
function list(head: string, ...items: AstNode[]): ListNode {
  return { kind: "list", head, items, span: SPAN };
}
function path(...segments: string[]): ListNode {
  return list("path", ...segments.map(ident));
}

function inv(id: string, assertExpression: AstNode): InvariantDeclaration {
  return {
    kind: "invariant",
    filePath: "test.stele",
    node: list("invariant"),
    span: SPAN,
    id,
    severity: "high",
    description: "d",
    assertExpression,
    dependsOn: [],
  };
}

describe("translateContract (pure, no z3)", () => {
  it("T7.1 resolves a numeric path to Real (the sound wide domain) even with only integer literals", () => {
    const result = translateContract([inv("X", list("gt", path("x"), num("5")))]);
    expect(result.translated).toEqual([
      {
        id: "X",
        ok: true,
        term: {
          kind: "cmp",
          op: "gt",
          a: { kind: "pathVar", key: "x", sort: "Real" },
          b: { kind: "intLit", value: 5n },
        },
      },
    ]);
    expect([...result.pathSorts]).toEqual([["x", "Real"]]);
  });

  it("T7.2 shares one variable for the same path across invariants", () => {
    const result = translateContract([
      inv("A", list("gt", path("order", "total"), num("0"))),
      inv("B", list("lt", path("order", "total"), num("100"))),
    ]);
    expect(result.translated.every((t) => t.ok)).toBe(true);
    const keys = new Set<string>();
    for (const t of result.translated) {
      if (t.ok && t.term.kind === "cmp" && t.term.a.kind === "pathVar") keys.add(t.term.a.key);
    }
    expect([...keys]).toEqual(["order/total"]);
    expect([...result.pathSorts]).toEqual([["order/total", "Real"]]);
  });

  it("T7.3 infers Real from a non-integral literal", () => {
    const result = translateContract([inv("R", list("lt", path("r"), num("2.5")))]);
    expect([...result.pathSorts]).toEqual([["r", "Real"]]);
    const t = result.translated[0]!;
    expect(t.ok && t.term.kind === "cmp" && t.term.b).toEqual({ kind: "realLit", raw: "2.5" });
  });

  it("T7.4 infers String from an equality with a string literal", () => {
    const result = translateContract([inv("S", list("eq", path("s"), str("a")))]);
    expect([...result.pathSorts]).toEqual([["s", "String"]]);
    const t = result.translated[0]!;
    expect(t.ok && t.term.kind === "eq" && t.term.b).toEqual({ kind: "strLit", value: "a" });
  });

  it("T7.5 marks `matches` untranslatable", () => {
    const result = translateContract([inv("M", list("matches", path("s"), str("re")))]);
    expect(result.translated).toEqual([{ id: "M", ok: false, reason: "unsupported-operator: matches" }]);
  });

  it("T7.6 keeps `between` translatable (and of two cmp)", () => {
    const result = translateContract([inv("B", list("between", path("x"), num("0"), num("10")))]);
    const t = result.translated[0]!;
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.term.kind).toBe("and");
      if (t.term.kind === "and") {
        expect(t.term.args.map((a) => a.kind)).toEqual(["cmp", "cmp"]);
        expect(t.term.args.map((a) => (a.kind === "cmp" ? a.op : null))).toEqual(["gte", "lte"]);
      }
    }
    expect([...result.pathSorts]).toEqual([["x", "Real"]]);
  });

  it("T7.7 marks an inconsistent-sort invariant untranslatable", () => {
    const result = translateContract([
      inv("Z", list("and", list("gt", path("z"), num("5")), list("eq", path("z"), str("a")))),
    ]);
    expect(result.translated).toEqual([{ id: "Z", ok: false, reason: "inconsistent-sort: z" }]);
  });

  it("T7.8 preserves nested structure for implies and when", () => {
    const impliesResult = translateContract([
      inv("I", list("implies", list("gt", path("x"), num("0")), list("lt", path("x"), num("100")))),
    ]);
    const ti = impliesResult.translated[0]!;
    expect(ti.ok && ti.term.kind).toBe("implies");
    if (ti.ok && ti.term.kind === "implies") {
      expect(ti.term.a.kind).toBe("cmp");
      expect(ti.term.b.kind).toBe("cmp");
    }
    expect([...impliesResult.pathSorts]).toEqual([["x", "Real"]]);

    const whenResult = translateContract([
      inv("W", list("when", list("gt", path("x"), num("0")), list("lt", path("x"), num("5")))),
    ]);
    const tw = whenResult.translated[0]!;
    expect(tw.ok && tw.term.kind).toBe("implies");
  });

  it("T7.9 keeps `mul` translatable (nonlinearity handled at the driver)", () => {
    const result = translateContract([inv("P", list("gt", list("mul", path("a"), path("b")), num("0")))]);
    const t = result.translated[0]!;
    expect(t.ok).toBe(true);
    if (t.ok && t.term.kind === "cmp") {
      expect(t.term.a.kind).toBe("arith");
      if (t.term.a.kind === "arith") expect(t.term.a.op).toBe("mul");
    }
    expect([...result.pathSorts].sort()).toEqual([
      ["a", "Real"],
      ["b", "Real"],
    ]);
  });
});
