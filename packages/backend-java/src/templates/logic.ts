import type { ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { JavaExpressionTranslator, JavaOperatorHandler, TranslationContext } from "./comparison.js";

export const logicOperatorHandlers: Record<string, JavaOperatorHandler> = {
  and: translateAnd,
  or: translateOr,
  not: translateNot,
};

function translateAnd(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "and" requires at least one operand.',
      node.span,
      "Pass at least one predicate.",
      "Use a form like (and (gt x 0) (lt x 10)).",
    );
  }
  return node.items.map((item) => wrapForLogical(translate(item, context))).join(" && ");
}

function translateOr(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
): string {
  if (node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "or" requires at least one operand.',
      node.span,
      "Pass at least one predicate.",
      "Use a form like (or (eq x 1) (eq x 2)).",
    );
  }
  return node.items.map((item) => wrapForLogical(translate(item, context))).join(" || ");
}

function translateNot(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "not" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single predicate, e.g. (not (eq x 1)).",
    );
  }
  return `!${wrapForLogical(translate(node.items[0]!, context))}`;
}

export function wrapForLogical(expression: string): string {
  return /^[A-Za-z0-9_.]+(\(.*\))?$/.test(expression) ? expression : `(${expression})`;
}
