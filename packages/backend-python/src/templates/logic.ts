import { wrapExpression } from "../translator.js";
import type { PythonOperatorHandler } from "../translator.js";

export const logicOperatorHandlers: Record<string, PythonOperatorHandler> = {
  and: (node, context, translate) => node.items.map((item) => wrapExpression(translate(item, context))).join(" and "),
  or: (node, context, translate) => node.items.map((item) => wrapExpression(translate(item, context))).join(" or "),
  not: (node, context, translate) => `not ${wrapExpression(translate(node.items[0]!, context))}`,
  implies: (node, context, translate) =>
    `(not ${wrapExpression(translate(node.items[0]!, context))} or ${wrapExpression(translate(node.items[1]!, context))})`,
  iff: (node, context, translate) =>
    `(${wrapExpression(translate(node.items[0]!, context))} == ${wrapExpression(translate(node.items[1]!, context))})`,
  when: (node, context, translate) =>
    `(not ${wrapExpression(translate(node.items[0]!, context))} or ${wrapExpression(translate(node.items[1]!, context))})`,
  if: (node, context, translate) =>
    `(${translate(node.items[1]!, context)} if ${translate(node.items[0]!, context)} else ${translate(node.items[2]!, context)})`,
} as Record<string, PythonOperatorHandler>;

