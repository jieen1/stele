import { describe, expect, it } from "vitest";
import {
  readSingleExpression,
  ensureFieldUnset,
  readSingleString,
} from "../src/validator/structure-shared.js";
import type { AstNode, ListNode, SourceSpan } from "../src/ast/types.js";

describe("readSingleExpression", () => {
  function makeNode(items: AstNode[]): ListNode {
    return { kind: "list", head: "test", items, span: { file: "", line: 1, column: 1 } };
  }

  it("returns single expression", () => {
    const items = [{ kind: "identifier", value: "X", span: { file: "", line: 1, column: 1 } }];
    const result = readSingleExpression(makeNode(items), "Test", "E0001");
    expect(result.value).toBe("X");
  });

  it("throws for empty list", () => {
    expect(() => readSingleExpression(makeNode([]), "Test", "E0001")).toThrow("exactly one value");
  });

  it("throws for multiple items", () => {
    const a = { kind: "identifier", value: "A", span: { file: "", line: 1, column: 1 } };
    const b = { kind: "identifier", value: "B", span: { file: "", line: 1, column: 1 } };
    expect(() => readSingleExpression(makeNode([a, b]), "Test", "E0001")).toThrow("exactly one value");
  });
});

describe("ensureFieldUnset", () => {
  it("does not throw when undefined", () => {
    expect(() => ensureFieldUnset(undefined, "field", "Test", "E0001", { file: "", line: 1, column: 1 }))
      .not.toThrow();
  });

  it("throws when value is set", () => {
    expect(() => ensureFieldUnset("value", "severity", "Test", "E0001", { file: "", line: 1, column: 1 }))
      .toThrow('may declare "severity" only once');
  });
});

describe("readSingleString", () => {
  function makeNode(items: AstNode[]): ListNode {
    return { kind: "list", head: "test", items, span: { file: "", line: 1, column: 1 } };
  }

  it("reads string value", () => {
    const items = [{ kind: "string", value: "hello world", span: { file: "", line: 1, column: 1 } }];
    expect(readSingleString(makeNode(items), "Test", "E0001")).toBe("hello world");
  });

  it("reads identifier value", () => {
    const items = [{ kind: "identifier", value: "severity", span: { file: "", line: 1, column: 1 } }];
    expect(readSingleString(makeNode(items), "Test", "E0001")).toBe("severity");
  });

  it("throws for non-string non-identifier", () => {
    const items = [{ kind: "number", raw: "42", value: 42, span: { file: "", line: 1, column: 1 } }];
    expect(() => readSingleString(makeNode(items), "Test", "E0001")).toThrow("must be a string or identifier");
  });

  it("throws for empty list", () => {
    expect(() => readSingleString(makeNode([]), "Test", "E0001")).toThrow("exactly one value");
  });
});
