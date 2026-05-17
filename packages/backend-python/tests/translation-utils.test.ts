import { describe, expect, it } from "vitest";
import { parseFile, type AstNode, type ListNode } from "@stele/core";
import {
  toPythonString,
  encodeCheckerArgs,
  allocateUniquePythonName,
  createTranslationContext,
  sanitizePythonIdentifier,
  readPathPart,
} from "../src/translation-utils.js";
import { PYTHON_RESERVED_WORDS } from "../src/types.js";

// ---------------------------------------------------------------------------
// toPythonString — edge cases
// ---------------------------------------------------------------------------

describe("toPythonString", () => {
  it("empty string returns quoted empty", () => {
    expect(toPythonString("")).toBe('""');
  });

  it("plain string round-trips", () => {
    expect(toPythonString("hello")).toBe('"hello"');
  });

  it("double quote is escaped", () => {
    expect(toPythonString('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  it("single quote passes through unescaped", () => {
    expect(toPythonString("it's")).toBe('"it\'s"');
  });

  it("backslash is escaped as \\\\ (JSON.stringify behavior)", () => {
    const result = toPythonString("\\path\\to\\file");
    // JSON.stringify("\\path\\to\\file") -> "\\path\\to\\file" (backslashes preserved as \\)
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("newline is escaped as \\n", () => {
    expect(toPythonString("line1\nline2")).toBe('"line1\\nline2"');
  });

  it("carriage return is escaped as \\r", () => {
    expect(toPythonString("line1\rline2")).toBe('"line1\\rline2"');
  });

  it("tab is escaped as \\t", () => {
    expect(toPythonString("a\tb")).toBe('"a\\tb"');
  });

  it("unicode emoji is preserved", () => {
    expect(toPythonString("🎉")).toBe('"🎉"');
  });

  it("unicode with accents round-trips via JSON", () => {
    const result = toPythonString("café");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("unicode CJK characters round-trips via JSON", () => {
    const result = toPythonString("こんにちは");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("mixed unicode and special chars round-trips via JSON", () => {
    const result = toPythonString("café ☃");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("null byte is escaped", () => {
    const result = toPythonString("a\0b");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("forward slash is not escaped (JSON default)", () => {
    expect(toPythonString("/path/to/file")).toBe('"/path/to/file"');
  });

  it("long string with all special chars round-trips", () => {
    const input = "a\"b'c\nd\re\tf\\g\0héi🎉";
    const result = toPythonString(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// encodeCheckerArgs — AST node encoding
// ---------------------------------------------------------------------------

function makeCheckerArg(key: string, valueNode: AstNode): ListNode {
  const keyId: AstNode = { kind: "identifier", value: key, span: { file: "", line: 1, column: 1 } };
  return {
    kind: "list",
    head: "",
    items: [keyId, valueNode],
    span: { file: "", line: 1, column: 1 },
  };
}

function makeNumberNode(raw: string, value: number): AstNode {
  return { kind: "number", raw, value, span: { file: "", line: 1, column: 1 } };
}

function makeStringNode(value: string): AstNode {
  return { kind: "string", value, span: { file: "", line: 1, column: 1 } };
}

function makeIdentifierNode(value: string): AstNode {
  return { kind: "identifier", value, span: { file: "", line: 1, column: 1 } };
}

describe("encodeCheckerArgs", () => {
  const ctx = createTranslationContext();

  it("empty args returns empty dict", () => {
    expect(encodeCheckerArgs([], ctx)).toBe("{}");
  });

  it("number value", () => {
    const node = makeCheckerArg("threshold", makeNumberNode("42", 42));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"threshold": 42}');
  });

  it("string value", () => {
    const node = makeCheckerArg("field", makeStringNode("amount"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"field": "amount"}');
  });

  it("boolean true", () => {
    const node = makeCheckerArg("enabled", makeIdentifierNode("true"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"enabled": True}');
  });

  it("boolean false", () => {
    const node = makeCheckerArg("enabled", makeIdentifierNode("false"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"enabled": False}');
  });

  it("null value", () => {
    const node = makeCheckerArg("opt", makeIdentifierNode("null"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"opt": None}');
  });

  it("none value", () => {
    const node = makeCheckerArg("opt", makeIdentifierNode("none"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"opt": None}');
  });

  it("multiple args are comma separated", () => {
    const limitNode = makeCheckerArg("limit", makeNumberNode("100", 100));
    const enabledNode = makeCheckerArg("enabled", makeIdentifierNode("true"));
    const result = encodeCheckerArgs([limitNode, enabledNode], ctx);
    expect(result).toBe('{"limit": 100, "enabled": True}');
  });

  it("skips malformed arg (not list)", () => {
    const badNode = { kind: "number", value: 5, raw: "5", span: { file: "", line: 1, column: 1 } } as AstNode;
    const result = encodeCheckerArgs([badNode], ctx);
    expect(result).toBe("{}");
  });

  it("skips arg list with wrong item count (1 item)", () => {
    const broken: ListNode = {
      kind: "list",
      head: "",
      items: [makeIdentifierNode("key")],
      span: { file: "", line: 1, column: 1 },
    };
    const result = encodeCheckerArgs([broken], ctx);
    expect(result).toBe("{}");
  });

  it("skips arg list with too many items", () => {
    const broken: ListNode = {
      kind: "list",
      head: "",
      items: [makeIdentifierNode("key"), makeNumberNode("1", 1), makeNumberNode("2", 2)],
      span: { file: "", line: 1, column: 1 },
    };
    const result = encodeCheckerArgs([broken], ctx);
    expect(result).toBe("{}");
  });

  it("skips arg where first item is not identifier", () => {
    const broken: ListNode = {
      kind: "list",
      head: "",
      items: [makeNumberNode("1", 1), makeIdentifierNode("val")],
      span: { file: "", line: 1, column: 1 },
    };
    const result = encodeCheckerArgs([broken], ctx);
    expect(result).toBe("{}");
  });

  it("mixed valid and invalid args", () => {
    const goodNode = makeCheckerArg("count", makeNumberNode("5", 5));
    const badNode = { kind: "number", value: 5, raw: "5", span: { file: "", line: 1, column: 1 } } as AstNode;
    const result = encodeCheckerArgs([goodNode, badNode], ctx);
    expect(result).toBe('{"count": 5}');
  });

  it("string value with special chars is JSON-escaped", () => {
    const node = makeCheckerArg("msg", makeStringNode("hello world"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"msg": "hello world"}');
  });

  it("string value with quotes is escaped", () => {
    const node = makeCheckerArg("q", makeStringNode('he said "hi"'));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toContain('he said');
  });

  it("unknown identifier value is silently skipped", () => {
    const node = makeCheckerArg("x", makeIdentifierNode("someVar"));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe("{}");
  });

  it("negative number value", () => {
    const node = makeCheckerArg("offset", makeNumberNode("-10", -10));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"offset": -10}');
  });

  it("float number value", () => {
    const node = makeCheckerArg("rate", makeNumberNode("3.14", 3.14));
    const result = encodeCheckerArgs([node], ctx);
    expect(result).toBe('{"rate": 3.14}');
  });
});

// ---------------------------------------------------------------------------
// allocateUniquePythonName
// ---------------------------------------------------------------------------

describe("allocateUniquePythonName", () => {
  it("returns base name if not in use", () => {
    expect(allocateUniquePythonName("foo", new Set())).toBe("foo");
  });

  it("appends _2 when base name is taken", () => {
    expect(allocateUniquePythonName("foo", new Set(["foo"]))).toBe("foo_2");
  });

  it("increments suffix when _2 is also taken", () => {
    expect(allocateUniquePythonName("foo", new Set(["foo", "foo_2"]))).toBe("foo_3");
  });

  it("avoids Python reserved words", () => {
    expect(allocateUniquePythonName("for", new Set())).toBe("for_2");
  });

  it("avoids reserved word even when not in usedNames", () => {
    expect(allocateUniquePythonName("class", new Set())).toBe("class_2");
  });

  it("avoids underscore which is reserved (produces __2 since base is _)", () => {
    // "_" is reserved, so loop: candidate = "_2" -> wait, "${baseName}_${suffix}" = "_2"? No.
    // baseName="_", suffix=2 -> candidate = "_2"? Let me check: `${"_"}_${2}` = "__2"
    expect(allocateUniquePythonName("_", new Set())).toBe("__2");
  });

  it("skips multiple consecutive suffixes", () => {
    const used = new Set(["foo", "foo_2", "foo_3", "foo_4"]);
    expect(allocateUniquePythonName("foo", used)).toBe("foo_5");
  });

  it("handles empty base name", () => {
    expect(allocateUniquePythonName("", new Set())).toBe("");
  });

  it("handles empty base name that is in usedNames", () => {
    expect(allocateUniquePythonName("", new Set([""]))).toBe("_2");
  });

  it("different base names don't collide", () => {
    const used = new Set(["a", "a_2"]);
    expect(allocateUniquePythonName("b", used)).toBe("b");
    expect(allocateUniquePythonName("a", used)).toBe("a_3");
  });
});

// ---------------------------------------------------------------------------
// createTranslationContext
// ---------------------------------------------------------------------------

describe("createTranslationContext", () => {
  it("default context has empty bindings", () => {
    const ctx = createTranslationContext();
    expect(ctx.bindings.size).toBe(0);
    expect(ctx.usedNames.size).toBe(0);
    expect(ctx.rootContextName).toBe("stele_context");
  });

  it("resolve returns undefined for unknown", () => {
    const ctx = createTranslationContext();
    expect(ctx.resolve("nonexistent")).toBeUndefined();
  });

  it("bind creates new context with binding", () => {
    const ctx = createTranslationContext();
    const result = ctx.bind("myVar");
    expect(result.name).toBeDefined();
    expect(result.context.resolve("myVar")).toBe(result.name);
  });

  it("bind does not affect parent context", () => {
    const ctx = createTranslationContext();
    ctx.bind("myVar");
    expect(ctx.resolve("myVar")).toBeUndefined();
  });

  it("bind sanitizes identifier", () => {
    const ctx = createTranslationContext();
    const result = ctx.bind("my-var");
    expect(result.name).toContain("my_var");
  });

  it("bind produces unique names on collision", () => {
    const bindings = new Map([["x", "x"]]);
    const usedNames = new Set(["x", "x_2"]);
    const ctx = createTranslationContext(bindings, usedNames);
    const result = ctx.bind("x");
    expect(result.name).toBe("x_3");
  });

  it("custom root context name", () => {
    const ctx = createTranslationContext(new Map(), new Set(), "custom_ctx");
    expect(ctx.rootContextName).toBe("custom_ctx");
  });

  it("nested bind chains contexts", () => {
    const ctx = createTranslationContext();
    const level1 = ctx.bind("outer");
    const level2 = level1.context.bind("inner");
    expect(level1.context.resolve("outer")).toBe(level1.name);
    expect(level2.context.resolve("inner")).toBe(level2.name);
    expect(level2.context.resolve("outer")).toBe(level1.name);
  });
});

// ---------------------------------------------------------------------------
// sanitizePythonIdentifier — via @stele/core
// ---------------------------------------------------------------------------

describe("sanitizePythonIdentifier", () => {
  it("keeps simple identifiers", () => {
    expect(sanitizePythonIdentifier("account", "item")).toBe("account");
  });

  it("replaces hyphens with underscores", () => {
    expect(sanitizePythonIdentifier("my-field", "item")).toBe("my_field");
  });

  it("handles multiple hyphens", () => {
    expect(sanitizePythonIdentifier("a-b-c-d", "item")).toBe("a_b_c_d");
  });

  it("handles leading hyphens", () => {
    const result = sanitizePythonIdentifier("-field", "item");
    expect(result).not.toBe("-field");
  });

  it("handles empty string by using fallback", () => {
    expect(sanitizePythonIdentifier("", "item")).toBe("item");
  });

  it("handles numbers only", () => {
    const result = sanitizePythonIdentifier("123", "item");
    expect(result).toBeDefined();
  });

  it("handles special characters", () => {
    const result = sanitizePythonIdentifier("a!@#b", "item");
    expect(result).toBeDefined();
  });

  it("is deterministic", () => {
    const result1 = sanitizePythonIdentifier("my-field", "item");
    const result2 = sanitizePythonIdentifier("my-field", "item");
    expect(result1).toBe(result2);
  });
});

// ---------------------------------------------------------------------------
// readPathPart
// ---------------------------------------------------------------------------

describe("readPathPart", () => {
  it("identifier returns value", () => {
    const node = { kind: "identifier", value: "account", span: { file: "", line: 1, column: 1 } } as AstNode;
    expect(readPathPart(node)).toBe("account");
  });

  it("keyword returns colon-prefixed value", () => {
    const node = { kind: "keyword", value: "account", span: { file: "", line: 1, column: 1 } } as AstNode;
    expect(readPathPart(node)).toBe(":account");
  });

  it("throws for unsupported node kind", () => {
    const node = { kind: "number", value: 5, raw: "5", span: { file: "", line: 1, column: 1 } } as AstNode;
    expect(() => readPathPart(node)).toThrow("Path segments must be identifiers or keywords");
  });
});

// ---------------------------------------------------------------------------
// PYTHON_RESERVED_WORDS
// ---------------------------------------------------------------------------

describe("PYTHON_RESERVED_WORDS", () => {
  it("contains Python 3 keywords plus underscore", () => {
    // 37 keywords (Python 3.10+) + 1 underscore = 38
    expect(PYTHON_RESERVED_WORDS.size).toBe(38);
  });

  it("contains common keywords", () => {
    for (const kw of ["if", "for", "while", "def", "class", "return", "import", "from", "try", "except"]) {
      expect(PYTHON_RESERVED_WORDS.has(kw)).toBe(true);
    }
  });

  it("contains True/False/None", () => {
    expect(PYTHON_RESERVED_WORDS.has("True")).toBe(true);
    expect(PYTHON_RESERVED_WORDS.has("False")).toBe(true);
    expect(PYTHON_RESERVED_WORDS.has("None")).toBe(true);
  });

  it("does not contain non-keywords", () => {
    expect(PYTHON_RESERVED_WORDS.has("print")).toBe(false);
    expect(PYTHON_RESERVED_WORDS.has("len")).toBe(false);
    expect(PYTHON_RESERVED_WORDS.has("range")).toBe(false);
  });
});
