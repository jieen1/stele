import { type ListNode } from "@stele/core";
import type { PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

const CHAIN_OPERATORS: Record<string, string> = {
  add: "+",
  mul: "*",
};

export const arithmeticOperatorHandlers: Record<string, PythonOperatorHandler> = {
  ...Object.fromEntries(
    Object.entries(CHAIN_OPERATORS).map(([operator, symbol]) => [
      operator,
      (node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator) =>
        translateChainedArithmetic(node, context, translate, symbol),
    ]),
  ),
  sub: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "-"),
  div: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "/"),
  neg: (node, context, translate) => `-${wrapExpression(translate(node.items[0]!, context))}`,
  abs: (node, context, translate) => `abs(${translate(node.items[0]!, context)})`,
} as Record<string, PythonOperatorHandler>;

function translateChainedArithmetic(
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
  symbol: string,
): string {
  return node.items.map((item) => wrapExpression(translate(item, context))).join(` ${symbol} `);
}

function translateBinaryArithmetic(
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
  symbol: string,
): string {
  const [left, right] = node.items;
  return `${wrapExpression(translate(left!, context))} ${symbol} ${wrapExpression(translate(right!, context))}`;
}

function wrapExpression(value: string): string {
  return /^[A-Za-z0-9_.\[\]"]+$/.test(value) ? value : `(${value})`;
}
