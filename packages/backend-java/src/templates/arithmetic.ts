import type { AstNode, ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { JavaExpressionTranslator, JavaOperatorHandler, TranslationContext } from "./comparison.js";

export const arithmeticOperatorHandlers: Record<string, JavaOperatorHandler> = {
  add: (node, context, translate) => translateVariadicArithmetic(node, context, translate, "add", "steleAdd"),
  sub: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "sub", "steleSub"),
  mul: (node, context, translate) => translateVariadicArithmetic(node, context, translate, "mul", "steleMul"),
  div: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "div", "steleDiv"),
  neg: translateNeg,
  abs: translateAbs,
  mod: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "mod", "steleMod"),
  pow: (node, context, translate) => translateBinaryArithmetic(node, context, translate, "pow", "stelePow"),
  round: translateRound,
  ceil: (node, context, translate) => translateUnary(node, context, translate, "ceil", "steleCeil"),
  floor: (node, context, translate) => translateUnary(node, context, translate, "floor", "steleFloor"),
};

function translateVariadicArithmetic(
  node: ListNode,
  context: TranslationContext,
  translate: JavaExpressionTranslator,
  operatorName: string,
  helper: string,
): string {
  if (node.items.length < 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      `Operator "${operatorName}" requires at least two operands.`,
      node.span,
      `Found ${node.items.length} operand(s).`,
      `Pass at least two operands, e.g. (${operatorName} 1 2).`,
    );
  }
  const args = node.items.map((item) => translate(item, context)).join(", ");
  return `SteleRuntime.${helper}(${args})`;
}

function translateBinaryArithmetic(
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
      `Pass two arguments, e.g. (${operatorName} a b).`,
    );
  }
  const left = translate(node.items[0]!, context);
  const right = translate(node.items[1]!, context);
  return `SteleRuntime.${helper}(${left}, ${right})`;
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
  return `SteleRuntime.${helper}(${translate(node.items[0]!, context)})`;
}

function translateNeg(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "neg" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single number, e.g. (neg 5).",
    );
  }
  return `SteleRuntime.steleNeg(${translate(node.items[0]!, context)})`;
}

function translateAbs(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length !== 1) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "abs" expects exactly one operand.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Pass a single number, e.g. (abs (path foo)).",
    );
  }
  return `SteleRuntime.steleAbs(${translate(node.items[0]!, context)})`;
}

function translateRound(node: ListNode, context: TranslationContext, translate: JavaExpressionTranslator): string {
  if (node.items.length < 1 || node.items.length > 2) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "round" expects one number and optionally a digit count.',
      node.span,
      `Found ${node.items.length} operand(s).`,
      "Use a form like (round x) or (round x 2).",
    );
  }
  const value = translate(node.items[0]!, context);
  if (node.items.length === 1) {
    return `SteleRuntime.steleRound(${value})`;
  }
  const digits = translate(node.items[1]!, context);
  return `SteleRuntime.steleRound(${value}, ${digits})`;
}
