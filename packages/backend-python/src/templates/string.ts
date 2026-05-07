import type { ListNode, PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

export const stringOperatorHandlers: Record<string, PythonOperatorHandler> = {
  matches: (node, context, translate) => {
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return `bool(re.search(${right}, ${left}))`;
  },
} as Record<string, PythonOperatorHandler>;
