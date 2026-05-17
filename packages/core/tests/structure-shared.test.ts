import { describe, expect, it } from "vitest";
import {
  readSingleExpression,
  ensureFieldUnset,
  readSingleString,
} from "../src/validator/structure-shared.js";
import type { AstNode, ListNode, SourceSpan } from "../src/ast/types.js";

describe("readSingleExpression", () => {
  function makeIdentifier(value: string): AstNode {
    return { kind: "identifier", value, span: { file: "", line: 1, column: 1 } };
  }

  function makeNode(items: AstNode[]): ListNode {
    return { kind: "list", head: "test", items, span: { file: "", line: 1, column: 1 } };
  }

  it("returns single expression", () => {
    const items = [makeIdentifier("X")];
    const result = readSingleExpression(makeNode(items), "Test", "E0001");
    expect(result.kind).toBe("identifier");
  });

  it("throws for empty list", () => {
    expect(() => readSingleExpression(makeNode([]), "Test", "E0001")).toThrow("exactly one value");
  });

  it("throws for multiple items", () => {
    const a = makeIdentifier("A");
    const b = makeIdentifier("B");
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
  function makeString(value: string): AstNode {
    return { kind: "string", value, span: { file: "", line: 1, column: 1 } };
  }

  function makeIdentifier(value: string): AstNode {
    return { kind: "identifier", value, span: { file: "", line: 1, column: 1 } };
  }

  function makeNumber(raw: string, value: number): AstNode {
    return { kind: "number", raw, value, span: { file: "", line: 1, column: 1 } };
  }

  function makeNode(items: AstNode[]): ListNode {
    return { kind: "list", head: "test", items, span: { file: "", line: 1, column: 1 } };
  }

  it("reads string value", () => {
    const items = [makeString("hello world")];
    expect(readSingleString(makeNode(items), "Test", "E0001")).toBe("hello world");
  });

  it("reads identifier value", () => {
    const items = [makeIdentifier("severity")];
    expect(readSingleString(makeNode(items), "Test", "E0001")).toBe("severity");
  });

  it("throws for non-string non-identifier", () => {
    const items = [makeNumber("42", 42)];
    expect(() => readSingleString(makeNode(items), "Test", "E0001")).toThrow("must be a string or identifier");
  });

  it("throws for empty list", () => {
    expect(() => readSingleString(makeNode([]), "Test", "E0001")).toThrow("exactly one value");
  });
});
