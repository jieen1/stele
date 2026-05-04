import type { SourceSpan } from "../ast/types.js";

export type Token =
  | {
      kind: "lparen";
      raw: "(";
      span: SourceSpan;
    }
  | {
      kind: "rparen";
      raw: ")";
      span: SourceSpan;
    }
  | {
      kind: "identifier";
      raw: string;
      value: string;
      span: SourceSpan;
    }
  | {
      kind: "keyword";
      raw: string;
      value: string;
      span: SourceSpan;
    }
  | {
      kind: "string";
      raw: string;
      value: string;
      span: SourceSpan;
    }
  | {
      kind: "number";
      raw: string;
      value: number;
      span: SourceSpan;
    }
  | {
      kind: "eof";
      raw: "";
      span: SourceSpan;
    };
