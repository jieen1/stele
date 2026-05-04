import { type ListNode } from "@stele/core";
import type { PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

export const temporalOperatorHandlers: Record<string, PythonOperatorHandler> = {
  before: (node, context, translate) => `${translate(node.items[0]!, context)} < ${translate(node.items[1]!, context)}`,
  after: (node, context, translate) => `${translate(node.items[0]!, context)} > ${translate(node.items[1]!, context)}`,
  "state-before": () => 'stele_context["state-before"]',
  "state-after": () => 'stele_context["state-after"]',
} as Record<string, PythonOperatorHandler>;
