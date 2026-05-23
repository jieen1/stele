import { SteleError, type AstNode, type ListNode } from "@stele/core";
import { arithmeticOperatorHandlers } from "./templates/arithmetic.js";
import { collectionOperatorHandlers } from "./templates/collection.js";
import { comparisonOperatorHandlers, extendedComparisonHandlers } from "./templates/comparison.js";
import { logicOperatorHandlers } from "./templates/logic.js";
import { temporalOperatorHandlers } from "./templates/temporal.js";
import { stringOperatorHandlers } from "./templates/string.js";
import { toPythonString, readPathPart } from "./translation-utils.js";
import { type TranslationContext, type PythonOperatorHandler } from "./types.js";
import { createTranslationContext } from "./translation-utils.js";

// ---------------------------------------------------------------------------
// Operator registry
// ---------------------------------------------------------------------------

const PYTHON_OPERATOR_HANDLERS: Record<string, PythonOperatorHandler> = {
  path: translatePath,
  field: translateField,
  value: translateValue,
  ...comparisonOperatorHandlers,
  ...extendedComparisonHandlers,
  ...arithmeticOperatorHandlers,
  ...collectionOperatorHandlers,
  ...logicOperatorHandlers,
  ...temporalOperatorHandlers,
  ...stringOperatorHandlers,
};

// ---------------------------------------------------------------------------
// Expression translation
// ---------------------------------------------------------------------------

export function translateExpression(node: AstNode, context: TranslationContext = createTranslationContext()): string {
  if (node.kind === "number") {
    return node.raw;
  }

  if (node.kind === "string") {
    return toPythonString(node.value);
  }

  if (node.kind === "keyword") {
    return toPythonString(`:${node.value}`);
  }

  if (node.kind === "identifier") {
    const binding = context.resolve(node.value);

    if (binding !== undefined) {
      return binding;
    }

    switch (node.value) {
      case "true":
        return "True";
      case "false":
        return "False";
      case "null":
      case "none":
        return "None";
      default:
        throw new SteleError(
          "E0602",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in Python backend expression.`,
          node.span,
          "Only bound variables, booleans, null-like symbols, and operator forms translate directly to Python.",
          "Wrap values in supported operators such as path, collection, or value.",
        );
    }
  }

  const handler = PYTHON_OPERATOR_HANDLERS[node.head];

  if (handler === undefined) {
    throw new SteleError(
      "E0601",
      "Backend Error",
      `Unsupported Python backend operator "${node.head}".`,
      node.span,
      "This operator is not yet implemented by @stele/backend-python.",
      "Use a supported operator or extend the backend translator before generating pytest output.",
    );
  }

  return handler(node, context, translateExpression);
}

// ---------------------------------------------------------------------------
// Path / field / value operators
// ---------------------------------------------------------------------------

function translatePath(node: ListNode, context: TranslationContext): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" requires at least one segment.',
      node.span,
      "A path expression needs one or more symbol segments to translate to Python.",
      'Use a form like (path account cash).',
    );
  }

  const [root, ...parts] = node.items;

  if (root?.kind !== "identifier" && root?.kind !== "keyword") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" expects symbol-like path segments.',
      root?.span ?? node.span,
      `Found ${root?.kind ?? "nothing"} where the root path segment should be.`,
      "Use identifiers or keywords for path parts.",
    );
  }

  const rootKey = root.kind === "keyword" ? `:${root.value}` : root.value;
  const binding = root.kind === "identifier" ? context.resolve(root.value) : undefined;
  const pathParts = parts.map(readPathPart);

  if (binding !== undefined) {
    return pathParts.length === 0 ? binding : `stele_get_path(${binding}, ${JSON.stringify(pathParts)})`;
  }

  if (parts.length === 0) {
    return `stele_get_path(${context.rootContextName}, ${JSON.stringify([rootKey])})`;
  }

  return `stele_get_path(${context.rootContextName}[${toPythonString(rootKey)}], ${JSON.stringify(pathParts)})`;
}

function translateField(node: ListNode, context: TranslationContext): string {
  const base = node.items[0];
  const field = node.items[1];

  if (base?.kind !== "list" || base.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects its first argument to be a path expression.',
      base?.span ?? node.span,
      "The Python backend extends existing path expressions by appending one field segment.",
      'Use a form like (field (path account) cash).',
    );
  }

  if (field?.kind !== "identifier" && field?.kind !== "keyword") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "field" expects an identifier or keyword segment.',
      field?.span ?? node.span,
      `Found ${field?.kind ?? "nothing"} where the appended field should be.`,
      "Replace the appended segment with a symbol-like path part.",
    );
  }

  const extendedPath: ListNode = {
    kind: "list",
    head: "path",
    items: [...base.items, field],
    span: node.span,
  };

  return translatePath(extendedPath, context);
}

function translateValue(node: ListNode, context: TranslationContext): string {
  return translateExpression(node.items[0]!, context);
}

// ---------------------------------------------------------------------------
// Expression wrapping
// ---------------------------------------------------------------------------

export function wrapExpression(value: string): string {
  return /^[A-Za-z0-9_.\[\]"]+$/.test(value) ? value : `(${value})`;
}
