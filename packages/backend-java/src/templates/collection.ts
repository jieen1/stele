import type { AstNode, ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { JavaExpressionTranslator, JavaOperatorHandler, TranslationContext } from "./comparison.js";

export const collectionOperatorHandlers: Record<string, JavaOperatorHandler> = {
  sum: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "sum", "steleSum"),
  count: translateCount,
  avg: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "avg", "steleAvg"),
  min: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "min", "steleMin"),
  max: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "max", "steleMax"),
  distinct: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "distinct", "steleDistinct"),
  unique: (node, context, translate) => translateAggregateWithProjection(node, context, translate, "unique", "steleUnique"),
  "has-length": translateHasLength,
  "is-empty": translateIsEmpty,
  "exists-in": translateExistsIn,
  // EP04
  length: (node, context, translate) => translateUnary(node, context, translate, "length", "steleLength"),
  concat: translateConcat,
  "sort-by": (node, context, translate) => translateSortBy(node, context, translate, "sort-by", "steleSortBy"),
  "sort-by-desc": (node, context, translate) => translateSortBy(node, context, translate, "sort-by-desc", "steleSortByDesc"),
  map: translateMap,
  first: (node, context, translate) => translateUnary(node, context, translate, "first", "steleFirst"),
  last: (node, context, translate) => translateUnary(node, context, translate, "last", "steleLast"),
};

function translateAggregateWithProjection(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length < 1 || node.items.length > 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects one collection and optionally a projection path.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} (path items)) or (${operatorName} (path items) (path price)).`,
    );
  }
  const collection = translate(node.items[0]!, context);
  const castCollection = `(List<Object>)${collection}`;
  const projection = node.items[1];
  if (projection === undefined) {
    return `SteleRuntime.${helper}(${castCollection})`;
  }
  const segments = readProjectionPath(projection, operatorName);
  return `SteleRuntime.${helper}(${castCollection}, ${formatSegmentArray(segments)})`;
}

function translateCount(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "count" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single collection, e.g. (count (path items)).",
    );
  }
  return `SteleRuntime.steleCount((List<Object>)${translate(node.items[0]!, context)})`;
}

function translateHasLength(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "has-length" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a collection and an expected length, e.g. (has-length (path items) 3).",
    );
  }
  const collection = translate(node.items[0]!, context);
  const length = translate(node.items[1]!, context);
  return `SteleRuntime.steleHasLength((List<Object>)${collection}, ${length})`;
}

function translateIsEmpty(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "is-empty" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a collection, e.g. (is-empty (path items)).",
    );
  }
  return `SteleRuntime.steleIsEmpty((List<Object>)${translate(node.items[0]!, context)})`;
}

function translateExistsIn(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "exists-in" expects exactly two operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a value and a container, e.g. (exists-in (path id) (path ids)).",
    );
  }
  const value = translate(node.items[0]!, context);
  const container = translate(node.items[1]!, context);
  return `SteleRuntime.steleExistsIn(${value}, (List<Object>)${container})`;
}

function translateUnary(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects exactly one operand.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass a single value, e.g. (${operatorName} (path foo)).`,
    );
  }
  return `SteleRuntime.${helper}((List<Object>)${translate(node.items[0]!, context)})`;
}

function translateConcat(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length < 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "concat" expects at least one collection operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass one or more collections, e.g. (concat (collection a) (collection b)).",
    );
  }
  const args = node.items.map((item) => `(List<Object>)${translate(item, context)}`).join(", ");
  return `SteleRuntime.steleConcat(${args})`;
}

function translateSortBy(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" expects a collection and a (path ...) projection.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} (collection items) (path price)).`,
    );
  }
  const collection = translate(node.items[0]!, context);
  const segments = readProjectionPath(node.items[1]!, operatorName);
  return `SteleRuntime.${helper}((List<Object>)${collection}, ${formatSegmentArray(segments)})`;
}

function translateMap(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "map" expects a collection and a (path ...) projection.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (map (collection items) (path price)).",
    );
  }
  const collection = translate(node.items[0]!, context);
  const segments = readProjectionPath(node.items[1]!, "map");
  return `SteleRuntime.steleMap((List<Object>)${collection}, ${formatSegmentArray(segments)})`;
}

function readProjectionPath(node: AstNode, operatorName: string): string[] {
  if (node.kind !== "list" || node.head !== "path") {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" projections must use a (path ...) expression.`,
      node.span,
      "The Java backend only supports path-based collection projections in v0.1.",
      "Rewrite the projection as (path field-name).",
    );
  }
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" projections require at least one path segment.`,
      node.span,
      "A projection path needs one or more identifier segments.",
      "Use a form like (path value).",
    );
  }
  return node.items.map(readPathPart);
}

function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  throw new SteleError(
    "E0603",
    "Backend Error",
    "Path segments must be identifiers or keywords.",
    node.span,
    `Found ${node.kind} in a path expression.`,
    "Replace the segment with a symbol-like path part.",
  );
}

export function formatSegmentArray(segments: readonly string[]): string {
  return `new String[]{${segments.map((s) => toJavaString(s)).join(", ")}}`;
}

export function toJavaString(value: string): string {
  return JSON.stringify(value);
}
