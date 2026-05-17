import { describe, expect, it } from "vitest";
import { describeNode, validationError } from "../src/validator/structure-error.js";
import type { AstNode, ListNode, SourceSpan } from "../src/ast/types.js";

function makeIdentifier(value: string): AstNode {
  return { kind: "identifier", value, span: { file: "", line: 1, column: 1 } };
}

function makeKeyword(value: string): AstNode {
  return { kind: "keyword", value, span: { file: "", line: 1, column: 1 } };
}

function makeString(value: string): AstNode {
  return { kind: "string", value, span: { file: "", line: 1, column: 1 } };
}

function makeListNode(head: string): ListNode {
  return { kind: "list", head, items: [], span: { file: "", line: 1, column: 1 } };
}

describe("describeNode", () => {
  it("describes identifier nodes", () => {
    expect(describeNode(makeIdentifier("myVar"))).toBe('identifier "myVar"');
  });

  it("describes list nodes", () => {
    expect(describeNode(makeListNode("invariant"))).toBe('list "invariant"');
  });

  it("describes string nodes", () => {
    expect(describeNode(makeString("hello"))).toBe('string "hello"');
  });

  it("describes keyword nodes", () => {
    expect(describeNode(makeKeyword("severity"))).toBe('keyword "severity"');
  });
});

describe("validationError", () => {
  it("creates SteleError with correct category", () => {
    const span: SourceSpan = { file: "test.stele", line: 5, column: 10 };
    const err = validationError("E0001", "Bad input", span, "Detail", "Hint");
    expect(err.category).toBe("Validation Error");
    expect(err.code).toBe("E0001");
  });

  it("preserves span information", () => {
    const span: SourceSpan = { file: "test.stele", line: 5, column: 10 };
    const err = validationError("E0001", "Bad input", span, "Detail", "Hint");
    expect(err.span).toEqual(span);
  });
});
