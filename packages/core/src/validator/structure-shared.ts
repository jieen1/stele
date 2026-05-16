import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { validationError } from "./structure-error.js";

/**
 * Read exactly one expression from a list node.
 * Throws validation error if the node contains more or fewer than one item.
 * @param code - Error code to use in the thrown error
 */
export function readSingleExpression(node: ListNode, label: string, code: string): AstNode {
  if (node.items.length !== 1) {
    throw validationError(
      code,
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }

  return node.items[0]!;
}

/**
 * Ensure a field is not set. Throws validation error if it is.
 * @param code - Error code to use in the thrown error
 */
export function ensureFieldUnset(value: unknown, field: string, label: string, code: string, span: SourceSpan): void {
  if (value !== undefined) {
    throw validationError(
      code,
      `${label} may declare "${field}" only once.`,
      span,
      `Found a duplicate "${field}" declaration.`,
      `Remove the duplicate "${field}" declaration.`,
    );
  }
}

/**
 * Read exactly one string or identifier from a list node.
 * Returns the value of the node item.
 * Throws validation error if the node contains more or fewer than one item,
 * or if the item is not a string or identifier.
 * @param code - Error code to use in the thrown error
 */
export function readSingleString(node: ListNode, label: string, code: string): string {
  if (node.items.length !== 1) {
    throw validationError(
      code,
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }

  const item = node.items[0]!;
  if (item.kind !== "string" && item.kind !== "identifier") {
    throw validationError(
      code,
      `${label} must be a string or identifier.`,
      item.span,
      "Expected a string literal or identifier.",
      "Wrap the value in double quotes.",
    );
  }

  return item.value;
}
