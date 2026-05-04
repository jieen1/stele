import { describe, expect, it } from "vitest";
import { type Token, SteleError, lex } from "../src/index";

describe("lex", () => {
  it("lexes parens, identifiers, keywords, comments, and eof in stable order", () => {
    const tokens = lex("(metadata :title foo) ; ignore me\n(rule bar)", "sample.stele");

    expect(summarize(tokens)).toEqual([
      ["lparen", undefined, "(", 1, 1],
      ["identifier", "metadata", "metadata", 1, 2],
      ["keyword", "title", ":title", 1, 11],
      ["identifier", "foo", "foo", 1, 18],
      ["rparen", undefined, ")", 1, 21],
      ["lparen", undefined, "(", 2, 1],
      ["identifier", "rule", "rule", 2, 2],
      ["identifier", "bar", "bar", 2, 7],
      ["rparen", undefined, ")", 2, 10],
      ["eof", undefined, "", 2, 11],
    ]);
  });

  it("lexes strings with supported escapes", () => {
    const [token] = lex("\"line\\n\\t\\r\\\\\\\"end\"");

    expect(token).toMatchObject({
      kind: "string",
      raw: "\"line\\n\\t\\r\\\\\\\"end\"",
      value: "line\n\t\r\\\"end",
      span: {
        file: "<input>",
        line: 1,
        column: 1,
      },
    });
  });

  it("rejects single-quoted strings as invalid characters", () => {
    expectLexError("'nope'", {
      code: "E0001",
      category: "Lexical Error",
      line: 1,
      column: 1,
    });
  });

  it("rejects multiline strings with an unterminated string error", () => {
    expectLexError("\"hello\nworld\"", {
      code: "E0002",
      line: 1,
      column: 1,
    });
  });

  it("rejects unterminated strings at eof", () => {
    expectLexError("\"unterminated", {
      code: "E0002",
      line: 1,
      column: 1,
    });
  });

  it("rejects invalid escape sequences", () => {
    expectLexError("\"bad\\q\"", {
      code: "E0003",
      line: 1,
      column: 1,
    });
  });

  it("lexes integers, decimals, negatives, and exponents", () => {
    const tokens = lex("0 -42 3.14 -0.5 1e-9 -2.5E+3");

    expect(tokens.filter((token) => token.kind === "number")).toEqual([
      numberToken("0", 0, 1, 1),
      numberToken("-42", -42, 1, 3),
      numberToken("3.14", 3.14, 1, 7),
      numberToken("-0.5", -0.5, 1, 12),
      numberToken("1e-9", 1e-9, 1, 17),
      numberToken("-2.5E+3", -2500, 1, 22),
    ]);
  });

  it("tracks line and column across comments and newlines", () => {
    const tokens = lex("alpha ; trailing comment\n  beta\n; whole line\n:gamma", "positions.stele");

    expect(tokens.filter((token) => token.kind !== "eof")).toMatchObject([
      {
        kind: "identifier",
        value: "alpha",
        span: { file: "positions.stele", line: 1, column: 1 },
      },
      {
        kind: "identifier",
        value: "beta",
        span: { file: "positions.stele", line: 2, column: 3 },
      },
      {
        kind: "keyword",
        value: "gamma",
        span: { file: "positions.stele", line: 4, column: 1 },
      },
    ]);
  });

  it("throws SteleError diagnostics for invalid characters", () => {
    expect(() => lex("foo @ bar", "bad.stele")).toThrowError(SteleError);

    try {
      lex("foo @ bar", "bad.stele");
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E0001",
        category: "Lexical Error",
        span: {
          file: "bad.stele",
          line: 1,
          column: 5,
        },
      });

      expect((error as SteleError).message).toContain("@");
      expect((error as SteleError).detail).toContain("Unexpected character");
      expect((error as SteleError).hint).toContain("Remove");
    }
  });
});

function summarize(tokens: Token[]): Array<[string, string | number | undefined, string, number, number]> {
  return tokens.map((token) => [
    token.kind,
    "value" in token ? token.value : undefined,
    token.raw,
    token.span.line,
    token.span.column,
  ]);
}

function numberToken(raw: string, value: number, line: number, column: number): Token {
  return {
    kind: "number",
    raw,
    value,
    span: {
      file: "<input>",
      line,
      column,
    },
  };
}

function expectLexError(
  input: string,
  expectation: {
    code: string;
    category?: string;
    line: number;
    column: number;
  },
): void {
  expect(() => lex(input)).toThrowError(SteleError);

  try {
    lex(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SteleError);
    const expected: {
      code: string;
      category?: string;
      span: {
        file: string;
        line: number;
        column: number;
      };
    } = {
      code: expectation.code,
      span: {
        file: "<input>",
        line: expectation.line,
        column: expectation.column,
      },
    };

    if (expectation.category !== undefined) {
      expected.category = expectation.category;
    }

    expect(error).toMatchObject(expected);
  }
}
