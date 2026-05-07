import { type AstNode } from "@stele/core";

export function formatAstNode(node: AstNode): string {
  switch (node.kind) {
    case "identifier":
      return node.value;
    case "keyword":
      return `:${node.value}`;
    case "string":
      return JSON.stringify(node.value);
    case "number":
      return node.raw;
    case "list":
      return `(${node.head}${node.items.length === 0 ? "" : ` ${node.items.map(formatAstNode).join(" ")}`})`;
  }
}
