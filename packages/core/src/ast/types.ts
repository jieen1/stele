export type SteleType =
  | "Number"
  | "String"
  | "Boolean"
  | "Path"
  | "Collection"
  | "Predicate"
  | "TimeRange"
  | "Symbol"
  | "Unknown";

export type SourceSpan = {
  file: string;
  line: number;
  column: number;
};

export type AtomNode =
  | { kind: "identifier"; value: string; span: SourceSpan }
  | { kind: "keyword"; value: string; span: SourceSpan }
  | { kind: "string"; value: string; span: SourceSpan }
  | { kind: "number"; value: number; raw: string; span: SourceSpan };

export type ListNode = {
  kind: "list";
  head: string;
  items: AstNode[];
  span: SourceSpan;
};

export type AstNode = AtomNode | ListNode;

/**
 * Output of the parser — a list of top-level AST nodes for a single file.
 * Lives here (primitives) so it can be referenced without crossing
 * the core-parsing ↔ core-domain-primitives boundary.
 */
export type ParsedFile = {
  kind: "file";
  body: AstNode[];
  file: string;
};
