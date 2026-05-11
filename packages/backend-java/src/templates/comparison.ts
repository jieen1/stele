import type { AstNode, ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { TranslationContext } from "../translator.js";

export type { TranslationContext };

export type JavaExpressionTranslator = (node: AstNode, context: TranslationContext) => string;
export type JavaOperatorHandler = (
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
) => string;

const COMPARISON_HELPER: Record<string, string> = {
  eq: "steleEq",
  neq: "steleNeq",
  gt: "steleGt",
  gte: "steleGte",
  lt: "steleLt",
  lte: "steleLte",
};

export const comparisonOperatorHandlers: Record<string, JavaOperatorHandler> = Object.fromEntries(
  Object.entries(COMPARISON_HELPER).map(([operator, helper]) => [
    operator,
    (node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator) =>
      translateComparison(node, context, translate, helper),
  ]),
) as Record<string, JavaOperatorHandler>;

function translateComparison(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
  helper: string,
): string {
  if (node.items.length !== 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${node.head}" expects exactly two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass two arguments, e.g. (${node.head} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `SteleRuntime.${helper}(${left}, ${right})`;
}
