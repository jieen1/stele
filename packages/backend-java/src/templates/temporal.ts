import type { AstNode, ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { JavaExpressionTranslator, JavaOperatorHandler, TranslationContext } from "./comparison.js";
import { toJavaString } from "./collection.js";

export const temporalOperatorHandlers: Record<string, JavaOperatorHandler> = {
  modified: translateModified,
  "state-before": translateStateBefore,
  "state-after": translateStateAfter,
  within: (node, context, translate) => translateBinaryRuntime(node, context, translate, "within", "steleWithin"),
  before: (node, context, translate) => translateBinaryRuntime(node, context, translate, "before", "steleBefore"),
  after: (node, context, translate) => translateBinaryRuntime(node, context, translate, "after", "steleAfter"),
};

function translateModified(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "modified" expects exactly one (path ...) operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (modified (path account balance)).",
    );
  }
  const segments = readModifiedPath(node.items[0]!, node);
  return `SteleRuntime.steleIsModified(${context.rootContextName}, ${segments})`;
}

function translateStateBefore(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "state-before" takes no operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use the bare form (state-before).",
    );
  }
  return `SteleRuntime.steleStateBefore(${context.rootContextName})`;
}

function translateStateAfter(node: ListNode, context: TranslationContext): string {
  if (node.items.length !== 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "state-after" takes no operands.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use the bare form (state-after).",
    );
  }
  return `SteleRuntime.steleStateAfter(${context.rootContextName})`;
}

function translateBinaryRuntime(
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
      `Operator "${operatorName}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Use a form like (${operatorName} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `SteleRuntime.${helper}(${left}, ${right})`;
}

function readModifiedPath(node: AstNode, owner: ListNode): string {
  if (node.kind !== "list" || node.head !== "path" || node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "modified" expects exactly one path expression.',
      node.span ?? owner.span,
      "The Java backend compares state-before and state-after by path.",
      "Use a form like (modified (path account balance)).",
    );
  }
  const segments = node.items.map(readPathPart);
  return `new String[]{${segments.map(toJavaString).join(", ")}}`;
}

function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  throw new SteleError(
    "E0603",
    "Backend Error",
    "Path segments must be identifiers or keywords.",
    node.span,
    `Found ${node.kind} in a translated path expression.`,
    "Replace the segment with a symbol-like path part.",
  );
}
