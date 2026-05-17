import { describe, expect, it } from "vitest";
import { formatAstNode } from "../src/utils/ast-format.js";
import type { AstNode } from "@stele/core";

describe("formatAstNode", () => {
  it("formats identifier", () => {
    const node: AstNode = { kind: "identifier", value: "myVar", span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("myVar");
  });

  it("formats keyword", () => {
    const node: AstNode = { kind: "keyword", value: "myKey", span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe(":myKey");
  });

  it("formats string", () => {
    const node: AstNode = { kind: "string", value: "hello world", span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe('"hello world"');
  });

  it("formats number", () => {
    const node: AstNode = { kind: "number", raw: "42", value: 42, span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("42");
  });

  it("formats float number", () => {
    const node: AstNode = { kind: "number", raw: "3.14", value: 3.14, span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("3.14");
  });

  it("formats empty list", () => {
    const node: AstNode = { kind: "list", head: "op", items: [], span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("(op)");
  });

  it("formats list with items", () => {
    const item: AstNode = { kind: "identifier", value: "X", span: { file: "", line: 1, column: 1 } };
    const node: AstNode = { kind: "list", head: "invariant", items: [item], span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("(invariant X)");
  });

  it("formats nested lists", () => {
    const inner: AstNode = { kind: "identifier", value: "X", span: { file: "", line: 1, column: 1 } };
    const outer: AstNode = { kind: "list", head: "op", items: [inner], span: { file: "", line: 1, column: 1 } };
    const list: AstNode = { kind: "list", head: "outer", items: [outer], span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(list)).toBe("(outer (op X))");
  });

  it("formats list with multiple items", () => {
    const a: AstNode = { kind: "identifier", value: "A", span: { file: "", line: 1, column: 1 } };
    const b: AstNode = { kind: "identifier", value: "B", span: { file: "", line: 1, column: 1 } };
    const node: AstNode = { kind: "list", head: "op", items: [a, b], span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(node)).toBe("(op A B)");
  });

  it("formats complex nested expression", () => {
    const sev: AstNode = { kind: "keyword", value: "severity", span: { file: "", line: 1, column: 1 } };
    const high: AstNode = { kind: "identifier", value: "high", span: { file: "", line: 1, column: 1 } };
    const inner: AstNode = { kind: "list", head: "field", items: [sev, high], span: { file: "", line: 1, column: 1 } };
    const outer: AstNode = { kind: "list", head: "invariant", items: [inner], span: { file: "", line: 1, column: 1 } };
    expect(formatAstNode(outer)).toBe("(invariant (field :severity high))");
  });
});
