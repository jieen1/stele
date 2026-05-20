import type { SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import type { Token } from "./token.js";

export const DEFAULT_FILE = "<input>";
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export function lex(input: string, file = DEFAULT_FILE): Token[] {
  const lexer = new Lexer(input, file);
  return lexer.lex();
}

class Lexer {
  #offset = 0;
  #line = 1;
  #column = 1;
  readonly #input: string;
  readonly #file: string;

  constructor(input: string, file: string) {
    this.#input = input;
    this.#file = file;
  }

  lex(): Token[] {
    const tokens: Token[] = [];

    while (!this.#isAtEnd()) {
      const char = this.#peek();

      if (char === "\uFEFF" && this.#offset === 0) {
        this.#advance();
        continue;
      }

      if (char === " " || char === "\t" || char === "\r") {
        this.#advance();
        continue;
      }

      if (char === "\n") {
        this.#advance();
        continue;
      }

      if (char === ";") {
        this.#skipComment();
        continue;
      }

      const span = this.#span();

      if (char === "(") {
        this.#advance();
        tokens.push({ kind: "lparen", raw: "(", span });
        continue;
      }

      if (char === ")") {
        this.#advance();
        tokens.push({ kind: "rparen", raw: ")", span });
        continue;
      }

      if (char === "\"") {
        tokens.push(this.#readString());
        continue;
      }

      if (char === ":" && this.#isIdentifierStart(this.#peek(1))) {
        tokens.push(this.#readKeyword());
        continue;
      }

      if (this.#isNumberStart(char, this.#peek(1))) {
        tokens.push(this.#readNumber());
        continue;
      }

      if (this.#isIdentifierStart(char)) {
        tokens.push(this.#readIdentifier());
        continue;
      }

      if (char === ":") {
        throw this.#error(
          "E0001",
          "Unexpected ':' without a keyword name.",
          span,
          "Keywords must start with ':' followed by an identifier body.",
          "Add an identifier after ':' or remove the ':' character.",
        );
      }

      throw this.#error(
        "E0001",
        `Unexpected character "${char}".`,
        span,
        `Unexpected character "${char}" cannot start any token.`,
        "Remove the character or replace it with valid CDL syntax.",
      );
    }

    tokens.push({
      kind: "eof",
      raw: "",
      span: this.#span(),
    });

    return tokens;
  }

  #readIdentifier(): Token {
    const span = this.#span();
    let raw = "";

    raw += this.#advance();

    while (this.#isIdentifierPart(this.#peek())) {
      raw += this.#advance();
    }

    return {
      kind: "identifier",
      raw,
      value: raw,
      span,
    };
  }

  #readKeyword(): Token {
    const span = this.#span();
    let raw = "";

    raw += this.#advance();
    raw += this.#advance();

    while (this.#isIdentifierPart(this.#peek())) {
      raw += this.#advance();
    }

    return {
      kind: "keyword",
      raw,
      value: raw.slice(1),
      span,
    };
  }

  #readString(): Token {
    const span = this.#span();
    let raw = this.#advance();
    let value = "";

    while (!this.#isAtEnd()) {
      const char = this.#peek();

      if (char === "\"") {
        raw += this.#advance();
        return {
          kind: "string",
          raw,
          value,
          span,
        };
      }

      if (char === "\n" || char === "\r") {
        throw this.#error(
          "E0002",
          "Unterminated string literal.",
          span,
          "String literals cannot span multiple lines.",
          "Close the string before the newline or use an escaped newline representation.",
        );
      }

      if (char === "\\") {
        const escapeSpan = this.#span();
        raw += this.#advance();
        const escape = this.#peek();

        if (escape === undefined || escape === "\n" || escape === "\r") {
          throw this.#error(
            "E0002",
            "Unterminated string literal.",
            span,
            "The string ends before the escape sequence completes.",
            "Finish the escape sequence and close the string with a double quote.",
          );
        }

        raw += this.#advance();
        value += decodeEscape(escape, escapeSpan);
        continue;
      }

      raw += this.#advance();
      value += char;
    }

    throw this.#error(
      "E0002",
      "Unterminated string literal.",
      span,
      "Reached the end of input before finding a closing double quote.",
      "Close the string with a double quote.",
    );
  }

  #readNumber(): Token {
    const span = this.#span();
    const match = this.#input.slice(this.#offset).match(NUMBER_PATTERN);

    if (match === null) {
      throw this.#error(
        "E0001",
        `Unexpected character "${this.#peek()}".`,
        span,
        "Expected a valid number literal.",
        "Use an integer, decimal, or exponent number literal.",
      );
    }

    const [raw] = match;

    for (let index = 0; index < raw.length; index += 1) {
      this.#advance();
    }

    const next = this.#peek();

    if (!this.#isNumberDelimiter(next)) {
      throw this.#error(
        "E0001",
        `Invalid number literal "${raw}${next ?? ""}".`,
        span,
        `Number literals must be followed by a delimiter, but found "${next}".`,
        "Insert whitespace, a parenthesis, a comment, or another valid delimiter after the number.",
      );
    }

    return {
      kind: "number",
      raw,
      value: Number(raw),
      span,
    };
  }

  #skipComment(): void {
    while (!this.#isAtEnd()) {
      const char = this.#peek();

      if (char === "\n") {
        return;
      }

      this.#advance();
    }
  }

  #error(code: string, message: string, span: SourceSpan, detail: string, hint: string): SteleError {
    return new SteleError(code, "Lexical Error", message, span, detail, hint);
  }

  #span(): SourceSpan {
    return {
      file: this.#file,
      line: this.#line,
      column: this.#column,
    };
  }

  #isAtEnd(): boolean {
    return this.#offset >= this.#input.length;
  }

  #peek(ahead = 0): string | undefined {
    return this.#input[this.#offset + ahead];
  }

  #advance(): string {
    const char = this.#input[this.#offset]!;
    this.#offset += 1;

    if (char === "\n") {
      this.#line += 1;
      this.#column = 1;
    } else {
      this.#column += 1;
    }

    return char;
  }

  #isIdentifierStart(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z_]/.test(char);
  }

  #isIdentifierPart(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z0-9_-]/.test(char);
  }

  #isNumberStart(char: string | undefined, next: string | undefined): boolean {
    if (char === undefined) {
      return false;
    }

    if (char === "-") {
      return next !== undefined && /[0-9]/.test(next);
    }

    return /[0-9]/.test(char);
  }

  #isNumberDelimiter(char: string | undefined): boolean {
    return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n" || char === "(" || char === ")" || char === ";";
  }
}

function decodeEscape(char: string, span: SourceSpan): string {
  switch (char) {
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    default:
      throw new SteleError(
        "E0003",
        "Lexical Error",
        `Invalid escape sequence "\\${char}".`,
        span,
        `The escape sequence "\\${char}" is not supported.`,
        "Use one of \\\" \\\\ \\n \\t or \\r.",
      );
  }
}
