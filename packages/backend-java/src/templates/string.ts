import type { AstNode, ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import type { JavaExpressionTranslator, JavaOperatorHandler, TranslationContext } from "./comparison.js";

export const stringOperatorHandlers: Record<string, JavaOperatorHandler> = {
  contains: (node, context, translate) => translateBinaryRuntime(node, context, translate, "contains", "steleContains"),
  "starts-with": (node, context, translate) => translateBinaryRuntime(node, context, translate, "starts-with", "steleStartsWith"),
  "ends-with": (node, context, translate) => translateBinaryRuntime(node, context, translate, "ends-with", "steleEndsWith"),
  matches: (node, context, translate) => translateBinaryRuntime(node, context, translate, "matches", "steleMatches"),
  trim: (node, context, translate) => translateUnary(node, context, translate, "trim", "steleTrim"),
  lower: (node, context, translate) => translateUnary(node, context, translate, "lower", "steleLower"),
  upper: (node, context, translate) => translateUnary(node, context, translate, "upper", "steleUpper"),
  split: (node, context, translate) => translateBinaryRuntime(node, context, translate, "split", "steleSplit"),
  join: (node, context, translate) => translateBinaryRuntime(node, context, translate, "join", "steleJoin"),
  // Phase 1: json-path operator
  "json-path": (node, context, translate) => translateBinaryRuntime(node, context, translate, "json-path", "steleJsonPath"),
};

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
