import type { AstNode, AtomNode, SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import { lex } from "../lexer/lexer.js";
import type { Token } from "../lexer/token.js";

const DEFAULT_FILE = "<input>";

export type ParsedFile = {
  kind: "file";
  body: AstNode[];
  file: string;
};

export function parseFile(input: string, file = DEFAULT_FILE): ParsedFile {
  const parser = new Parser(lex(input, file), file);
  return parser.parseFile();
}

class Parser {
  #current = 0;
  readonly #tokens: Token[];
  readonly #file: string;

  constructor(tokens: Token[], file: string) {
    this.#tokens = tokens;
    this.#file = file;
  }

  parseFile(): ParsedFile {
    const body: AstNode[] = [];

    while (!this.#isAtEnd()) {
      body.push(this.#parseExpression());
    }

    return {
      kind: "file",
      body,
      file: this.#file,
    };
  }

  #parseExpression(): AstNode {
    const token = this.#peek();

    switch (token.kind) {
      case "lparen":
        return this.#parseList();
      case "rparen":
        throw this.#error(
          "E0101",
          "Unmatched closing parenthesis.",
          token.span,
          "Found ')' without a matching opening parenthesis.",
          "Remove the extra ')' or add the missing opening parenthesis.",
        );
      case "identifier":
      case "keyword":
      case "string":
      case "number":
        this.#advance();
        return toAtomNode(token);
      case "eof":
        throw this.#error(
          "E0103",
          "Unexpected end of file.",
          token.span,
          "Expected another expression before the end of input.",
          "Finish the current form or remove incomplete syntax.",
        );
    }
  }

  #parseList(): AstNode {
    const open = this.#consume("lparen");

    if (this.#check("eof")) {
      throw this.#error(
        "E0101",
        "Unmatched opening parenthesis.",
        open.span,
        "Reached end of input before finding a matching closing parenthesis.",
        "Add a closing ')' for this list.",
      );
    }

    const headToken = this.#advance();

    if (headToken.kind === "rparen") {
      throw this.#error(
        "E0102",
        "List head must be an identifier.",
        headToken.span,
        "Encountered an empty list where an identifier head was required.",
        "Start the list with an identifier such as '(operator ...)'",
      );
    }

    if (headToken.kind === "eof") {
      throw this.#error(
        "E0101",
        "Unmatched opening parenthesis.",
        open.span,
        "Reached end of input before finding a list head or closing parenthesis.",
        "Add a valid identifier head and a closing ')'.",
      );
    }

    if (headToken.kind !== "identifier") {
      throw this.#error(
        "E0102",
        "List head must be an identifier.",
        headToken.span,
        `Found ${formatTokenKind(headToken.kind)} where a list head identifier was required.`,
        "Replace the head with an identifier such as '(operator ...)'",
      );
    }

    const items: AstNode[] = [];

    while (!this.#check("rparen")) {
      if (this.#check("eof")) {
        throw this.#error(
          "E0101",
          "Unmatched opening parenthesis.",
          open.span,
          "Reached end of input before finding a matching closing parenthesis.",
          "Add a closing ')' for this list.",
        );
      }

      items.push(this.#parseExpression());
    }

    this.#consume("rparen");

    return {
      kind: "list",
      head: headToken.value,
      items,
      span: open.span,
    };
  }

  #consume(kind: Token["kind"]): Token {
    const token = this.#peek();

    if (token.kind !== kind) {
      throw this.#error(
        "E0103",
        `Unexpected token "${token.raw}".`,
        token.span,
        `Expected ${kind} but found ${token.kind}.`,
        "Check the surrounding CDL syntax.",
      );
    }

    return this.#advance();
  }

  #check(kind: Token["kind"]): boolean {
    return this.#peek().kind === kind;
  }

  #isAtEnd(): boolean {
    return this.#peek().kind === "eof";
  }

  #peek(): Token {
    return this.#tokens[this.#current]!;
  }

  #advance(): Token {
    const token = this.#tokens[this.#current]!;
    this.#current += 1;
    return token;
  }

  #error(code: string, message: string, span: SourceSpan, detail: string, hint: string): SteleError {
    return new SteleError(code, "Parser Error", message, span, detail, hint);
  }
}

function toAtomNode(token: Extract<Token, { kind: "identifier" | "keyword" | "string" | "number" }>): AtomNode {
  switch (token.kind) {
    case "identifier":
      return { kind: "identifier", value: token.value, span: token.span };
    case "keyword":
      return { kind: "keyword", value: token.value, span: token.span };
    case "string":
      return { kind: "string", value: token.value, span: token.span };
    case "number":
      return { kind: "number", value: token.value, raw: token.raw, span: token.span };
  }
}

function formatTokenKind(kind: Token["kind"]): string {
  switch (kind) {
    case "identifier":
    case "keyword":
    case "string":
    case "number":
    case "lparen":
    case "rparen":
    case "eof":
      return `"${kind}" token`;
  }
}
