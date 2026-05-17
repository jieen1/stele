import { describe, expect, it } from "vitest";
import { lex } from "../src/lexer/lexer.js";

describe("lexer", () => {
  it("handles empty input", () => {
    const tokens = lex("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.kind).toBe("eof");
  });

  it("handles whitespace-only input", () => {
    const tokens = lex("   \t\n  \t  ");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.kind).toBe("eof");
  });

  it("handles BOM at start", () => {
    const tokens = lex("﻿(invariant X)");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("lparen");
  });

  it("handles comments", () => {
    const tokens = lex("; this is a comment\n(invariant X)");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("lparen");
  });

  it("handles inline comments", () => {
    const tokens = lex("(invariant X) ; comment here");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content.find((t) => t.kind === "rparen")).toBeDefined();
    expect(content.find((t) => t.kind === "comment")).toBeUndefined();
  });

  it("handles strings", () => {
    const tokens = lex('"hello world"');
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("string");
  });

  it("handles escaped quotes in strings", () => {
    const tokens = lex('"he said \\"hi\\""');
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("string");
  });

  it("handles numbers", () => {
    const tokens = lex("42 -3.14 0.5 1e10");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("number");
    expect(content[0]?.raw).toBe("42");
  });

  it("handles scientific notation", () => {
    const tokens = lex("1e10 3.14e-5");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("number");
    expect(content[1]?.kind).toBe("number");
  });

  it("handles identifiers", () => {
    const tokens = lex("invariant");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("identifier");
    expect(content[0]?.raw).toBe("invariant");
  });

  it("handles keywords", () => {
    const tokens = lex(":keyword");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content[0]?.kind).toBe("keyword");
  });

  it("tracks line numbers", () => {
    const tokens = lex("\n\n(invariant X)");
    const content = tokens.filter((t) => t.kind !== "eof");
    const paren = content.find((t) => t.kind === "lparen");
    expect(paren?.span.line).toBe(3);
  });

  it("tracks column numbers", () => {
    const tokens = lex("   (invariant X)");
    const content = tokens.filter((t) => t.kind !== "eof");
    const paren = content.find((t) => t.kind === "lparen");
    expect(paren?.span.column).toBe(4);
  });

  it("throws on unterminated string", () => {
    expect(() => lex('"unterminated')).toThrow();
  });

  it("handles unterminated list gracefully (returns tokens with eof)", () => {
    const tokens = lex("(invariant");
    const content = tokens.filter((t) => t.kind !== "eof");
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content.some((t) => t.kind === "lparen")).toBe(true);
  });

  it("handles nested parentheses", () => {
    const tokens = lex("((invariant X))");
    const content = tokens.filter((t) => t.kind !== "eof");
    const lparens = content.filter((t) => t.kind === "lparen");
    expect(lparens).toHaveLength(2);
  });

  it("handles mixed tokens", () => {
    const tokens = lex("(invariant X :severity high 42 \"desc\")");
    const content = tokens.filter((t) => t.kind !== "eof");
    const kinds = content.map((t) => t.kind);
    expect(kinds).toContain("identifier");
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("number");
    expect(kinds).toContain("string");
  });
});
