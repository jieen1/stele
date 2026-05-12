import { describe, it, expect } from "vitest";
import {
  translateExpression,
  sanitizeGoIdentifier,
  astToSource,
  generateGoTestSource,
  STELE_ALLOWED_IMPORTS,
  type TranslationContext,
} from "../src/translator.js";
import type { AstNode, ListNode, SourceSpan } from "@stele/core";

// ---------------------------------------------------------------------------
// Helper: create AST nodes for testing
// ---------------------------------------------------------------------------

const span: SourceSpan = { file: "test.cdl", line: 1, column: 0 };

function atom(kind: "number" | "string" | "keyword" | "identifier", value: string | number, raw?: string): AstNode {
  if (kind === "number") {
    return { kind: "number", value: value as number, raw: raw ?? String(value), span };
  }
  if (kind === "string") {
    return { kind: "string", value: value as string, span };
  }
  if (kind === "keyword") {
    return { kind: "keyword", value: value as string, span };
  }
  return { kind: "identifier", value: value as string, span };
}

function list(head: string, items: AstNode[]): ListNode {
  return { kind: "list", head, items, span };
}

function path(...segments: string[]): ListNode {
  return list("path", segments.map((s) => atom("identifier", s)));
}

function collection(name: string): ListNode {
  return list("collection", [atom("identifier", name)]);
}

// ---------------------------------------------------------------------------
// sanitizeGoIdentifier tests
// ---------------------------------------------------------------------------

describe("sanitizeGoIdentifier", () => {
  it("keeps simple alphanumeric identifiers", () => {
    expect(sanitizeGoIdentifier("accountBalance")).toBe("accountBalance");
  });

  it("replaces hyphens with underscores", () => {
    expect(sanitizeGoIdentifier("balance-history")).toBe("balance_history");
  });

  it("collapses multiple underscores", () => {
    expect(sanitizeGoIdentifier("foo___bar")).toBe("foo_bar");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeGoIdentifier("__foo__")).toBe("foo");
  });

  it("applies fallback prefix for empty result", () => {
    expect(sanitizeGoIdentifier("---")).toBe("value");
  });

  it("applies fallback prefix for digit-start", () => {
    expect(sanitizeGoIdentifier("123foo")).toBe("value_123foo");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: atoms
// ---------------------------------------------------------------------------

describe("translateExpression atoms", () => {
  it("translates number literal", () => {
    expect(translateExpression(atom("number", 42))).toBe("42");
  });

  it("translates string literal", () => {
    expect(translateExpression(atom("string", "hello"))).toBe('"hello"');
  });

  it("translates boolean true", () => {
    expect(translateExpression(atom("identifier", "true"))).toBe("true");
  });

  it("translates boolean false", () => {
    expect(translateExpression(atom("identifier", "false"))).toBe("false");
  });

  it("translates null", () => {
    expect(translateExpression(atom("identifier", "null"))).toBe("nil");
  });

  it("translates none", () => {
    expect(translateExpression(atom("identifier", "none"))).toBe("nil");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: comparison operators
// ---------------------------------------------------------------------------

describe("translateExpression comparisons", () => {
  it("translates eq operator", () => {
    expect(translateExpression(list("eq", [path("x"), atom("number", 5)]))).toBe(
      'steleEq(steleGetPathVal(globalCtx, []string{"x"}), 5)',
    );
  });

  it("translates gt operator", () => {
    expect(translateExpression(list("gt", [path("balance"), atom("number", 0)]))).toBe(
      'steleGt(steleGetPathVal(globalCtx, []string{"balance"}), 0)',
    );
  });

  it("translates neq operator", () => {
    expect(translateExpression(list("neq", [path("status"), atom("string", "closed")]))).toBe(
      'steleNeq(steleGetPathVal(globalCtx, []string{"status"}), "closed")',
    );
  });

  it("translates lte operator", () => {
    expect(translateExpression(list("lte", [path("count"), atom("number", 10)]))).toBe(
      'steleLte(steleGetPathVal(globalCtx, []string{"count"}), 10)',
    );
  });
});

// ---------------------------------------------------------------------------
// translateExpression: logic operators
// ---------------------------------------------------------------------------

describe("translateExpression logic", () => {
  it("translates and with two predicates", () => {
    const expr = list("and", [list("gt", [path("x"), atom("number", 0)]), list("lt", [path("x"), atom("number", 10)])]);
    const result = translateExpression(expr);
    expect(result).toContain("&&");
    expect(result).toContain("steleGt");
    expect(result).toContain("steleLt");
  });

  it("translates or with two predicates", () => {
    const expr = list("or", [list("eq", [path("x"), atom("number", 1)]), list("eq", [path("x"), atom("number", 2)])]);
    const result = translateExpression(expr);
    expect(result).toContain("||");
  });

  it("translates not", () => {
    const expr = list("not", [list("eq", [path("x"), atom("number", 1)])]);
    expect(translateExpression(expr)).toContain("!");
  });

  it("translates implies", () => {
    const expr = list("implies", [list("eq", [path("x"), atom("number", 1)]), list("gt", [path("y"), atom("number", 0)])]);
    const result = translateExpression(expr);
    expect(result).toContain("!");
    expect(result).toContain("||");
  });

  it("translates iff", () => {
    const expr = list("iff", [list("eq", [path("x"), atom("number", 1)]), list("eq", [path("y"), atom("number", 1)])]);
    const result = translateExpression(expr);
    expect(result).toContain("==");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: arithmetic operators
// ---------------------------------------------------------------------------

describe("translateExpression arithmetic", () => {
  it("translates add with two operands", () => {
    expect(translateExpression(list("add", [path("a"), path("b")]))).toBe(
      "steleAdd(steleGetPathVal(globalCtx, []string{\"a\"}), steleGetPathVal(globalCtx, []string{\"b\"}))",
    );
  });

  it("translates sub", () => {
    expect(translateExpression(list("sub", [path("a"), path("b")]))).toContain("steleSub");
  });

  it("translates mul with three operands", () => {
    const expr = list("mul", [path("a"), path("b"), atom("number", 2)]);
    const result = translateExpression(expr);
    expect(result).toContain("steleMul");
  });

  it("translates div", () => {
    expect(translateExpression(list("div", [path("a"), path("b")]))).toContain("steleDiv");
  });

  it("translates neg", () => {
    expect(translateExpression(list("neg", [path("x")]))).toContain("steleNeg");
  });

  it("translates abs", () => {
    expect(translateExpression(list("abs", [path("x")]))).toContain("steleAbs");
  });

  it("translates mod", () => {
    expect(translateExpression(list("mod", [path("x"), atom("number", 3)]))).toContain("steleMod");
  });

  it("translates round", () => {
    expect(translateExpression(list("round", [path("x")]))).toContain("steleRound");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: aggregate operators
// ---------------------------------------------------------------------------

describe("translateExpression aggregates", () => {
  it("translates count", () => {
    expect(translateExpression(list("count", [collection("items")]))).toContain("steleCount");
  });

  it("translates sum", () => {
    expect(translateExpression(list("sum", [collection("items")]))).toContain("steleSum");
  });

  it("translates avg with projection", () => {
    expect(translateExpression(list("avg", [collection("items"), path("price")]))).toContain("steleAvg");
  });

  it("translates min", () => {
    expect(translateExpression(list("min", [collection("items")]))).toContain("steleMin");
  });

  it("translates max", () => {
    expect(translateExpression(list("max", [collection("items")]))).toContain("steleMax");
  });

  it("translates is-empty", () => {
    expect(translateExpression(list("is-empty", [collection("items")]))).toContain("steleIsEmpty");
  });

  it("translates has-length", () => {
    expect(translateExpression(list("has-length", [collection("items"), atom("number", 3)]))).toContain("steleHasLength");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: string operators
// ---------------------------------------------------------------------------

describe("translateExpression strings", () => {
  it("translates contains", () => {
    expect(translateExpression(list("contains", [path("name"), atom("string", "foo")]))).toContain("steleContains");
  });

  it("translates starts-with", () => {
    expect(translateExpression(list("starts-with", [path("name"), atom("string", "Dr.")])))
      .toContain("steleStartsWith");
  });

  it("translates trim", () => {
    expect(translateExpression(list("trim", [path("name")]))).toContain("steleTrim");
  });

  it("translates lower", () => {
    expect(translateExpression(list("lower", [path("name")]))).toContain("steleLower");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: quantifiers
// ---------------------------------------------------------------------------

describe("translateExpression quantifiers", () => {
  it("translates forall", () => {
    const expr = list("forall", [
      atom("identifier", "item"),
      collection("items"),
      list("gt", [path("item"), atom("number", 0)]),
    ]);
    const result = translateExpression(expr);
    expect(result).toContain("steleForall");
    expect(result).toContain("func(item any) bool");
  });

  it("translates exists", () => {
    const expr = list("exists", [
      atom("identifier", "tx"),
      collection("transactions"),
      list("eq", [path("tx"), atom("string", "pending")]),
    ]);
    const result = translateExpression(expr);
    expect(result).toContain("steleExists");
    expect(result).toContain("func(tx any) bool");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: control operators
// ---------------------------------------------------------------------------

describe("translateExpression control", () => {
  it("translates not-null", () => {
    expect(translateExpression(list("not-null", [path("account", "email")]))).toContain("steleNotNull");
  });

  it("translates between", () => {
    expect(translateExpression(list("between", [path("age"), atom("number", 0), atom("number", 150)]))).toContain("steleBetween");
  });

  it("translates when", () => {
    const expr = list("when", [list("gt", [path("x"), atom("number", 0)]), list("lt", [path("x"), atom("number", 10)])]);
    const result = translateExpression(expr);
    expect(result).toContain("!");
    expect(result).toContain("||");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: path access
// ---------------------------------------------------------------------------

describe("translateExpression path", () => {
  it("translates simple path", () => {
    expect(translateExpression(path("account"))).toBe('steleGetPathVal(globalCtx, []string{"account"})');
  });

  it("translates nested path", () => {
    expect(translateExpression(path("account", "balance"))).toBe(
      'steleGetPathVal(globalCtx, []string{"account", "balance"})',
    );
  });

  it("translates path with bound variable", () => {
    const ctx: TranslationContext = {
      bindings: new Map([["item", "item"]]),
      rootContextName: "globalCtx",
      usedNames: new Set(["item"]),
      bind: () => ({ name: "item", context: ctx as any }),
      resolve: (id: string) => ctx.bindings.get(id),
    };
    expect(translateExpression(path("item", "balance"), ctx)).toBe(
      'steleGetPathVal(item, []string{"balance"})',
    );
  });
});

// ---------------------------------------------------------------------------
// astToSource tests
// ---------------------------------------------------------------------------

describe("astToSource", () => {
  it("renders number", () => {
    expect(astToSource(atom("number", 42))).toBe("42");
  });

  it("renders string", () => {
    expect(astToSource(atom("string", "hello"))).toBe('"hello"');
  });

  it("renders list expression", () => {
    expect(astToSource(list("eq", [path("x"), atom("number", 5)]))).toBe("(eq (path x) 5)");
  });
});

// ---------------------------------------------------------------------------
// generateGoTestSource tests
// ---------------------------------------------------------------------------

describe("generateGoTestSource", () => {
  it("generates Go package declaration", () => {
    const source = generateGoTestSource(createEmptyContract());
    expect(source).toContain("package contract_test");
  });

  it("generates test function for each invariant", () => {
    const contract = createContractWithInvariant("balance-positive", list("gt", [path("balance"), atom("number", 0)]));
    const source = generateGoTestSource(contract);
    expect(source).toContain("func TestBalance_positive(t *testing.T)");
  });

  it("generates empty test when no invariants", () => {
    const source = generateGoTestSource(createEmptyContract());
    expect(source).toContain("func TestEmptyContract");
  });

  it("includes steleAssertTrue call", () => {
    const contract = createContractWithInvariant("balance-positive", list("gt", [path("balance"), atom("number", 0)]));
    const source = generateGoTestSource(contract);
    expect(source).toContain("steleAssertTrue");
  });
});

// ---------------------------------------------------------------------------
// translateExpression: field operator
// ---------------------------------------------------------------------------

describe("translateExpression field operator", () => {
  it("translates field extending a simple path", () => {
    const expr = list("field", [path("account"), atom("identifier", "cash")]);
    expect(translateExpression(expr)).toBe(
      'steleGetPathVal(globalCtx, []string{"account", "cash"})',
    );
  });

  it("translates field extending a nested path", () => {
    const expr = list("field", [path("account", "details"), atom("identifier", "balance")]);
    expect(translateExpression(expr)).toBe(
      'steleGetPathVal(globalCtx, []string{"account", "details", "balance"})',
    );
  });

  it("throws when first argument is not a path", () => {
    const expr = list("field", [atom("identifier", "account"), atom("identifier", "cash")]);
    expect(() => translateExpression(expr)).toThrow('Operator "field" expects its first argument to be a path expression.');
  });

  it("throws when wrong number of operands", () => {
    const expr = list("field", [path("account")]);
    expect(() => translateExpression(expr)).toThrow('Operator "field" expects a path and a field name.');
  });
});

// ---------------------------------------------------------------------------
// translateExpression: in operator
// ---------------------------------------------------------------------------

describe("translateExpression in operator", () => {
  it("translates in as membership check", () => {
    const expr = list("in", [atom("number", 5), collection("ids")]);
    expect(translateExpression(expr)).toContain("steleExistsIn");
    expect(translateExpression(expr)).toBe(
      'steleExistsIn(5, steleGetPathVal(globalCtx, []string{"ids"}))',
    );
  });

  it("translates in with path value and path collection", () => {
    const expr = list("in", [path("name"), collection("names")]);
    expect(translateExpression(expr)).toContain("steleExistsIn");
    expect(translateExpression(expr)).toBe(
      'steleExistsIn(steleGetPathVal(globalCtx, []string{"name"}), steleGetPathVal(globalCtx, []string{"names"}))',
    );
  });

  it("throws when wrong number of operands", () => {
    const expr = list("in", [atom("number", 5)]);
    expect(() => translateExpression(expr)).toThrow('Operator "in" expects exactly two operands.');
  });
});

// ---------------------------------------------------------------------------
// json-path operator tests
// ---------------------------------------------------------------------------

describe("translateExpression json-path operator", () => {
  it("translates json-path as steleJsonPath call", () => {
    const expr = list("json-path", [path("data"), atom("string", "accounts.balance")]);
    const result = translateExpression(expr);
    expect(result).toBe('steleJsonPath(steleGetPathVal(globalCtx, []string{"data"}), "accounts.balance")');
  });
});

// ---------------------------------------------------------------------------
// decimal-eq operator tests
// ---------------------------------------------------------------------------

describe("translateExpression decimal-eq operator", () => {
  it("translates decimal-eq as steleDecimalEq call", () => {
    const expr = list("decimal-eq", [path("amount"), atom("number", 1234.56)]);
    const result = translateExpression(expr);
    expect(result).toBe("steleDecimalEq(steleGetPathVal(globalCtx, []string{\"amount\"}), 1234.56)");
  });
});

// ---------------------------------------------------------------------------
// STELE_ALLOWED_IMPORTS tests
// ---------------------------------------------------------------------------

describe("STELE_ALLOWED_IMPORTS", () => {
  it("contains standard library imports", () => {
    expect(STELE_ALLOWED_IMPORTS.has("fmt")).toBe(true);
    expect(STELE_ALLOWED_IMPORTS.has("encoding/json")).toBe(true);
    expect(STELE_ALLOWED_IMPORTS.has("testing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function createEmptyContract(): any {
  return {
    rootPath: "test.cdl",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
  };
}

function createContractWithInvariant(id: string, assertExpr?: AstNode): any {
  const invariant = {
    kind: "invariant",
    filePath: "test.cdl",
    node: list("invariant", []),
    span,
    id,
    severity: "error",
    description: "Test invariant",
    assertExpression: assertExpr,
    dependsOn: [],
  };
  return {
    ...createEmptyContract(),
    invariants: [invariant],
  };
}
