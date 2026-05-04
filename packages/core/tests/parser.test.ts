import { describe, expect, it } from "vitest";
import { type ParsedFile, SteleError, parseFile } from "../src/index";

describe("parseFile", () => {
  it("parses nested s-expressions with spans", () => {
    const parsed = parseFile("(and (eq left 1) (not flag))", "nested.stele");

    expect(parsed).toMatchObject<ParsedFile>({
      kind: "file",
      file: "nested.stele",
      body: [
        {
          kind: "list",
          head: "and",
          span: { file: "nested.stele", line: 1, column: 1 },
          items: [
            {
              kind: "list",
              head: "eq",
              span: { file: "nested.stele", line: 1, column: 6 },
              items: [
                {
                  kind: "identifier",
                  value: "left",
                  span: { file: "nested.stele", line: 1, column: 10 },
                },
                {
                  kind: "number",
                  value: 1,
                  raw: "1",
                  span: { file: "nested.stele", line: 1, column: 15 },
                },
              ],
            },
            {
              kind: "list",
              head: "not",
              span: { file: "nested.stele", line: 1, column: 18 },
              items: [
                {
                  kind: "identifier",
                  value: "flag",
                  span: { file: "nested.stele", line: 1, column: 23 },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("parses the metadata sample", () => {
    const parsed = parseFile('(metadata (stele-version "0.1"))');

    expect(parsed.body).toEqual([
      {
        kind: "list",
        head: "metadata",
        span: { file: "<input>", line: 1, column: 1 },
        items: [
          {
            kind: "list",
            head: "stele-version",
            span: { file: "<input>", line: 1, column: 11 },
            items: [
              {
                kind: "string",
                value: "0.1",
                span: { file: "<input>", line: 1, column: 26 },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("parses multiple top-level forms", () => {
    const parsed = parseFile("(metadata (stele-version \"0.1\"))\n(rule active)");

    expect(parsed.body).toHaveLength(2);
    expect(parsed.body[0]).toMatchObject({ kind: "list", head: "metadata" });
    expect(parsed.body[1]).toMatchObject({ kind: "list", head: "rule" });
  });

  it("rejects a list whose head is a number", () => {
    expectParseError("(123 value)", {
      code: "E0102",
      line: 1,
      column: 2,
      messageIncludes: "List head",
    });
  });

  it("rejects a list whose head is a keyword", () => {
    expectParseError("(:x value)", {
      code: "E0102",
      line: 1,
      column: 2,
      messageIncludes: "List head",
    });
  });

  it("rejects unmatched open parentheses", () => {
    expectParseError("(eq left 1", {
      code: "E0101",
      line: 1,
      column: 11,
      messageIncludes: "Unmatched",
    });
  });

  it("rejects unmatched close parentheses", () => {
    expectParseError(")", {
      code: "E0101",
      line: 1,
      column: 1,
      messageIncludes: "Unmatched",
    });
  });

  it("preserves atom kinds and values", () => {
    const parsed = parseFile('name :label "v" -1.5e2');

    expect(parsed.body).toEqual([
      {
        kind: "identifier",
        value: "name",
        span: { file: "<input>", line: 1, column: 1 },
      },
      {
        kind: "keyword",
        value: "label",
        span: { file: "<input>", line: 1, column: 6 },
      },
      {
        kind: "string",
        value: "v",
        span: { file: "<input>", line: 1, column: 13 },
      },
      {
        kind: "number",
        value: -150,
        raw: "-1.5e2",
        span: { file: "<input>", line: 1, column: 17 },
      },
    ]);
  });
});

function expectParseError(
  input: string,
  expectation: {
    code: string;
    line: number;
    column: number;
    messageIncludes: string;
  },
): void {
  expect(() => parseFile(input)).toThrowError(SteleError);

  try {
    parseFile(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SteleError);
    expect(error).toMatchObject({
      code: expectation.code,
      category: "Parser Error",
      span: {
        file: "<input>",
        line: expectation.line,
        column: expectation.column,
      },
    });
    expect((error as SteleError).message).toContain(expectation.messageIncludes);
  }
}
