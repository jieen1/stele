import type { AstNode, SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";

export function describeNode(node: AstNode): string {
  if (node.kind === "list") {
    return `list "${node.head}"`;
  }

  return `${node.kind} "${node.value}"`;
}

export function validationError(code: string, message: string, span: SourceSpan, detail: string, hint: string): SteleError {
  return new SteleError(code, "Validation Error", message, span, detail, hint);
}
