import { SteleError, type AstNode, type ListNode } from "@stele/core";
import type { PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

export const collectionOperatorHandlers: Record<string, PythonOperatorHandler> = {
  collection: translateCollection,
  sum: translateSum,
  count: (node, context, translate) => `len(${translate(node.items[0]!, context)})`,
  avg: (node, context, translate) => translateAverage(node, context, translate),
  min: (node, context, translate) => translateExtremum(node, context, translate, "min"),
  max: (node, context, translate) => translateExtremum(node, context, translate, "max"),
  where: (node, context, translate) => translateWhere(node, context, translate),
  forall: (node, context, translate) => translateQuantifier(node, context, translate, "all"),
  exists: (node, context, translate) => translateQuantifier(node, context, translate, "any"),
  none: (node, context, translate) => `not ${wrapExpression(translateQuantifier(node, context, translate, "any"))}`,
  "exists-in": (node, context, translate) => `${translate(node.items[0]!, context)} in ${translate(node.items[1]!, context)}`,
  "not-null": (node, context, translate) => `${translate(node.items[0]!, context)} is not None`,
} as Record<string, PythonOperatorHandler>;

function translateCollection(node: ListNode, context: TranslationContext): string {
  const target = node.items[0];

  if (target?.kind !== "identifier") {
    throw new SteleError(
      "E0602",
      "Backend Error",
      'Operator "collection" expects an identifier target.',
      node.span,
      "The Python backend only knows how to resolve named collections from stele_context.",
      'Use a form like (collection transactions).',
    );
  }

  return `${context.rootContextName}[${JSON.stringify(target.value)}]`;
}

function translateSum(node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator): string {
  const collection = translate(node.items[0]!, context);
  const pathParts = node.items[1] === undefined ? "[]" : JSON.stringify(readProjectionPath(node.items[1]));
  return `stele_sum(${collection}, ${pathParts})`;
}

function translateAverage(node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator): string {
  const collection = translate(node.items[0]!, context);
  const pathParts = node.items[1] === undefined ? "[]" : JSON.stringify(readProjectionPath(node.items[1]));
  return `(stele_sum(${collection}, ${pathParts}) / len(${collection}))`;
}

function translateExtremum(
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
  operator: "min" | "max",
): string {
  const collection = translate(node.items[0]!, context);
  const projection = node.items[1];

  if (projection === undefined) {
    return `${operator}(${collection})`;
  }

  const pathParts = JSON.stringify(readProjectionPath(projection));
  return `${operator}(stele_get_path(item, ${pathParts}) for item in ${collection})`;
}

function translateWhere(node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator): string {
  const binding = node.items[0];

  if (binding?.kind !== "identifier") {
    throw new SteleError(
      "E0602",
      "Backend Error",
      'Operator "where" must bind an identifier.',
      node.span,
      "The first where argument becomes the Python list-comprehension variable.",
      'Use a form like (where txn (collection transactions) ...).',
    );
  }

  const bound = context.bind(binding.value);
  const collection = translate(node.items[1]!, context);
  const predicate = translate(node.items[2]!, bound.context);

  return `[${bound.name} for ${bound.name} in ${collection} if ${predicate}]`;
}

function translateQuantifier(
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
  quantifier: "all" | "any",
): string {
  const binding = node.items[0];

  if (binding?.kind !== "identifier") {
    throw new SteleError(
      "E0602",
      "Backend Error",
      `Quantifier "${node.head}" must bind an identifier.`,
      node.span,
      "The first quantifier argument becomes the Python loop variable.",
      'Use a form like (forall txn (collection transactions) ...).',
    );
  }

  const bound = context.bind(binding.value);
  const collection = translate(node.items[1]!, context);
  const predicate = translate(node.items[2]!, bound.context);

  return `${quantifier}(${predicate} for ${bound.name} in ${collection})`;
}

function readProjectionPath(node: AstNode): string[] {
  if (node.kind !== "list" || node.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Collection projections must use a path expression such as (path value).',
      node.span,
      "The Python backend only supports path-based collection projections in v0.1.",
      'Rewrite the projection as (path field-name).',
    );
  }

  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "path" requires at least one segment.',
      node.span,
      "A projection path needs one or more identifier segments.",
      'Use a form like (path value).',
    );
  }

  return node.items.map((part) => {
    if (part.kind === "identifier") {
      return part.value;
    }

    if (part.kind === "keyword") {
      return `:${part.value}`;
    }

    throw new SteleError(
      "E0603",
      "Backend Error",
      'Projection paths may only contain identifier or keyword segments.',
      part.span,
      `Found ${part.kind} inside the collection projection.`,
      "Replace the segment with a symbol-like path part.",
    );
  });
}

function wrapExpression(value: string): string {
  return /^[A-Za-z0-9_.\[\]"]+$/.test(value) ? value : `(${value})`;
}
