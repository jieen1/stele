import { type ListNode } from "@stele/core";
import { wrapExpression } from "../translator.js";
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
  // EP04 batch 1: mod, pow, round, ceil, floor.
  // All routed through stele_* helpers so cross-backend error semantics
  // (divisor == 0, NaN propagation, banker's rounding, etc.) stay byte-equal.
  mod: (node, context, translate) => {
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return `stele_mod(${left}, ${right})`;
  },
  pow: (node, context, translate) => {
    const base = translate(node.items[0]!, context);
    const exponent = translate(node.items[1]!, context);
    return `stele_pow(${base}, ${exponent})`;
  },
  round: (node, context, translate) => {
    const value = translate(node.items[0]!, context);
    const digits = node.items[1] === undefined ? "0" : translate(node.items[1], context);
    return `stele_round(${value}, ${digits})`;
  },
  ceil: (node, context, translate) => `stele_ceil(${translate(node.items[0]!, context)})`,
  floor: (node, context, translate) => `stele_floor(${translate(node.items[0]!, context)})`,
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

