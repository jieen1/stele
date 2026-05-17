import { describe, expect, it } from "vitest";
import { describeNode, validationError } from "../src/validator/structure-error.js";
import type { AstNode, ListNode, SourceSpan } from "../src/ast/types.js";

describe("describeNode", () => {
  it("describes identifier nodes", () => {
    const node: AstNode = { kind: "identifier", value: "myVar", span: { file: "", line: 1, column: 1 } };
    expect(describeNode(node)).toBe('identifier "myVar"');
  });

  it("describes list nodes", () => {
    const node: ListNode = { kind: "list", head: "invariant", items: [], span: { file: "", line: 1, column: 1 } };
    expect(describeNode(node)).toBe('list "invariant"');
  });

  it("describes string nodes", () => {
    const node: AstNode = { kind: "string", value: "hello", span: { file: "", line: 1, column: 1 } };
    expect(describeNode(node)).toBe('string "hello"');
  });

  it("describes keyword nodes", () => {
    const node: AstNode = { kind: "keyword", value: "severity", span: { file: "", line: 1, column: 1 } };
    expect(describeNode(node)).toBe('keyword "severity"');
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
