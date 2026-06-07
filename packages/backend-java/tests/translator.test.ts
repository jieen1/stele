import { describe, expect, it } from "vitest";
import {
  translateExpression,
  sanitizeJavaIdentifier,
  astToSource,
} from "../src/translator.js";
import type { AstNode, ListNode } from "@stele/core";

function makeNumber(value: number): AstNode {
  return { kind: "number", value, raw: String(value), span: { file: "test.cdl", line: 1, column: 1 } };
}

function makeString(value: string): AstNode {
  return { kind: "string", value, span: { file: "test.cdl", line: 1, column: 1 } };
}

function makeIdentifier(value: string): AstNode {
  return { kind: "identifier", value, span: { file: "test.cdl", line: 1, column: 1 } };
}

function makeList(head: string, items: AstNode[]): ListNode {
  return { kind: "list", head, items, span: { file: "test.cdl", line: 1, column: 1 } };
}

describe("sanitizeJavaIdentifier", () => {
  it("converts kebab-case to camelCase", () => {
    expect(sanitizeJavaIdentifier("my-test")).toBe("myTest");
  });

  it("handles uppercase CDL identifiers", () => {
    expect(sanitizeJavaIdentifier("ACCT_BALANCE_POSITIVE")).toBe("ACCT_BALANCE_POSITIVE");
  });

  it("uses fallback prefix for empty result", () => {
    expect(sanitizeJavaIdentifier("---")).toBe("value");
  });

  it("prefixes when result starts with digit", () => {
    expect(sanitizeJavaIdentifier("123abc")).toBe("value_123abc");
  });

  it("handles simple identifiers", () => {
    expect(sanitizeJavaIdentifier("balance")).toBe("balance");
  });
});

describe("translateExpression: literals", () => {
  it("translates numbers", () => {
    expect(translateExpression(makeNumber(42))).toBe("42");
  });

  it("translates strings", () => {
    expect(translateExpression(makeString("hello"))).toBe('"hello"');
  });

  it("translates true", () => {
    expect(translateExpression(makeIdentifier("true"))).toBe("true");
  });

  it("translates false", () => {
    expect(translateExpression(makeIdentifier("false"))).toBe("false");
  });

  it("translates null", () => {
    expect(translateExpression(makeIdentifier("null"))).toBe("null");
  });

  it("translates none", () => {
    expect(translateExpression(makeIdentifier("none"))).toBe("null");
  });
});

describe("translateExpression: path", () => {
  it("translates single-segment path", () => {
    const node = makeList("path", [makeIdentifier("accounts")]);
    expect(translateExpression(node)).toContain("SteleRuntime.getAtPath");
  });

  it("translates multi-segment path", () => {
    const node = makeList("path", [makeIdentifier("account"), makeIdentifier("balance")]);
    expect(translateExpression(node)).toContain("SteleRuntime.getAtPath");
  });
});

describe("translateExpression: comparisons", () => {
  it("translates eq", () => {
    const node = makeList("eq", [makeNumber(1), makeNumber(1)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleEq(1, 1)");
  });

  it("translates neq", () => {
    const node = makeList("neq", [makeNumber(1), makeNumber(2)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleNeq(1, 2)");
  });

  it("translates gt", () => {
    const node = makeList("gt", [makeNumber(5), makeNumber(3)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleGt(5, 3)");
  });

  it("translates gte", () => {
    const node = makeList("gte", [makeNumber(5), makeNumber(5)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleGte(5, 5)");
  });

  it("translates lt", () => {
    const node = makeList("lt", [makeNumber(3), makeNumber(5)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleLt(3, 5)");
  });

  it("translates lte", () => {
    const node = makeList("lte", [makeNumber(5), makeNumber(5)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleLte(5, 5)");
  });
});

describe("translateExpression: logic", () => {
  it("translates and", () => {
    const node = makeList("and", [
      makeList("gt", [makeNumber(1), makeNumber(0)]),
      makeList("lt", [makeNumber(1), makeNumber(10)]),
    ]);
    expect(translateExpression(node)).toContain(" && ");
  });

  it("translates or", () => {
    const node = makeList("or", [
      makeList("eq", [makeNumber(1), makeNumber(1)]),
      makeList("eq", [makeNumber(1), makeNumber(2)]),
    ]);
    expect(translateExpression(node)).toContain(" || ");
  });

  it("translates not", () => {
    const node = makeList("not", [makeList("eq", [makeNumber(1), makeNumber(1)])]);
    expect(translateExpression(node)).toContain("!");
  });
});

describe("translateExpression: arithmetic", () => {
  it("translates add", () => {
    const node = makeList("add", [makeNumber(1), makeNumber(2)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleAdd(1, 2)");
  });

  it("translates sub", () => {
    const node = makeList("sub", [makeNumber(10), makeNumber(3)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleSub(10, 3)");
  });

  it("translates mul", () => {
    const node = makeList("mul", [makeNumber(3), makeNumber(4)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleMul(3, 4)");
  });

  it("translates neg", () => {
    const node = makeList("neg", [makeNumber(5)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleNeg(5)");
  });

  it("translates abs", () => {
    const node = makeList("abs", [makeNumber(-5)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleAbs(-5)");
  });
});

describe("translateExpression: string operators", () => {
  it("translates contains", () => {
    const node = makeList("contains", [makeString("hello world"), makeString("world")]);
    expect(translateExpression(node)).toBe('SteleRuntime.steleContains("hello world", "world")');
  });

  it("translates starts-with", () => {
    const node = makeList("starts-with", [makeString("hello"), makeString("hel")]);
    expect(translateExpression(node)).toBe('SteleRuntime.steleStartsWith("hello", "hel")');
  });

  it("translates matches", () => {
    const node = makeList("matches", [makeString("test123"), makeString("test.*")]);
    expect(translateExpression(node)).toBe('SteleRuntime.steleMatches("test123", "test.*")');
  });
});

describe("translateExpression: collection operators", () => {
  it("translates count", () => {
    const node = makeList("count", [makeList("path", [makeIdentifier("items")])]);
    expect(translateExpression(node)).toContain("SteleRuntime.steleCount");
  });

  it("translates is-empty", () => {
    const node = makeList("is-empty", [makeList("path", [makeIdentifier("items")])]);
    expect(translateExpression(node)).toContain("SteleRuntime.steleIsEmpty");
  });

  it("translates sum", () => {
    const node = makeList("sum", [makeList("path", [makeIdentifier("items")])]);
    expect(translateExpression(node)).toContain("SteleRuntime.steleSum");
  });
});

describe("translateExpression: quantifiers", () => {
  it("translates forall", () => {
    const node = makeList("forall", [
      makeIdentifier("item"),
      makeList("path", [makeIdentifier("items")]),
      makeList("gt", [makeList("path", [makeIdentifier("item"), makeIdentifier("value")]), makeNumber(0)]),
    ]);
    const result = translateExpression(node);
    expect(result).toContain("SteleRuntime.steleForall");
    expect(result).toContain("item ->");
  });

  it("translates exists", () => {
    const node = makeList("exists", [
      makeIdentifier("item"),
      makeList("path", [makeIdentifier("items")]),
      makeList("gt", [makeList("path", [makeIdentifier("item"), makeIdentifier("value")]), makeNumber(0)]),
    ]);
    const result = translateExpression(node);
    expect(result).toContain("SteleRuntime.steleExists");
    expect(result).toContain("item ->");
  });
});

describe("translateExpression: control operators", () => {
  it("translates when", () => {
    const node = makeList("when", [
      makeList("gt", [makeNumber(1), makeNumber(0)]),
      makeList("lt", [makeNumber(1), makeNumber(10)]),
    ]);
    const result = translateExpression(node);
    expect(result).toContain("!");
    expect(result).toContain("||");
  });

  it("translates implies", () => {
    const node = makeList("implies", [
      makeList("eq", [makeNumber(1), makeNumber(1)]),
      makeList("gt", [makeNumber(2), makeNumber(0)]),
    ]);
    const result = translateExpression(node);
    expect(result).toContain("!");
    expect(result).toContain("||");
  });
});

describe("translateExpression: value", () => {
  it("translates value wrapper", () => {
    const node = makeList("value", [makeNumber(5)]);
    expect(translateExpression(node)).toBe("5");
  });

  it("translates value with path", () => {
    const node = makeList("value", [makeList("path", [makeIdentifier("x")])]);
    expect(translateExpression(node)).toContain("SteleRuntime.getAtPath");
  });
});

describe("translateExpression: json-path operator", () => {
  it("translates json-path via SteleRuntime.steleJsonPath", () => {
    const node = makeList("json-path", [makeList("path", [makeIdentifier("data")]), makeString("accounts.balance")]);
    expect(translateExpression(node)).toBe('SteleRuntime.steleJsonPath(SteleRuntime.getAtPath(ctx, new String[]{"data"}), "accounts.balance")');
  });
});

describe("translateExpression: decimal-eq operator", () => {
  it("translates decimal-eq via SteleRuntime.steleDecimalEq", () => {
    const node = makeList("decimal-eq", [makeList("path", [makeIdentifier("amount")]), makeNumber(1234.56)]);
    expect(translateExpression(node)).toBe("SteleRuntime.steleDecimalEq(SteleRuntime.getAtPath(ctx, new String[]{\"amount\"}), 1234.56)");
  });
});

describe("astToSource", () => {
  it("converts number back to source", () => {
    expect(astToSource(makeNumber(42))).toBe("42");
  });

  it("converts list back to source", () => {
    const node = makeList("gt", [makeNumber(5), makeNumber(3)]);
    expect(astToSource(node)).toBe("(gt 5 3)");
  });

  it("converts nested list back to source", () => {
    const node = makeList("and", [
      makeList("gt", [makeNumber(1), makeNumber(0)]),
      makeList("lt", [makeNumber(1), makeNumber(10)]),
    ]);
    expect(astToSource(node)).toBe("(and (gt 1 0) (lt 1 10))");
  });
});

describe("translateExpression: unsupported operators throw", () => {
  // @tcb-negative @stele/backend-java
  it("throws for unknown operator", () => {
    const node = makeList("unknown-op", [makeNumber(1)]);
    expect(() => translateExpression(node)).toThrow();
  });
});
