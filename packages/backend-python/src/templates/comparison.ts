import { type ListNode } from "@stele/core";
import type { PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

const COMPARISON_OPERATORS: Record<string, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  in: "in",
};

export const extendedComparisonHandlers: Record<string, PythonOperatorHandler> = {
  between: (node, context, translate) => {
    const value = translate(node.items[0]!, context);
    const low = translate(node.items[1]!, context);
    const high = translate(node.items[2]!, context);
    return `(${low} <= ${value} <= ${high})`;
  },
  "approx-eq": (node, context, translate) => {
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    const tol = translate(node.items[2]!, context);
    return `abs(${left} - ${right}) <= ${tol}`;
  },
};

export const comparisonOperatorHandlers: Record<string, PythonOperatorHandler> = Object.fromEntries(
  Object.entries(COMPARISON_OPERATORS).map(([operator, symbol]) => [
    operator,
    (node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator) =>
      translateComparison(node, context, translate, symbol),
  ]),
) as Record<string, PythonOperatorHandler>;

function translateComparison(
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
  symbol: string,
): string {
  const [left, right] = node.items;

  return `(${translate(left!, context)}) ${symbol} (${translate(right!, context)})`;
}
