import { type ListNode } from "@stele/core";
import type { PythonOperatorHandler } from "../translator.js";

export const stringOperatorHandlers: Record<string, PythonOperatorHandler> = {
  matches: (node, context, translate) => {
    const left = translate(node.items[0]!, context);
    const right = translate(node.items[1]!, context);
    return `bool(re.search(${right}, ${left}))`;
  },
  contains: (node, context, translate) => {
    const haystack = translate(node.items[0]!, context);
    const needle = translate(node.items[1]!, context);
    return `${needle} in ${haystack}`;
  },
  "starts-with": (node, context, translate) => {
    const value = translate(node.items[0]!, context);
    const prefix = translate(node.items[1]!, context);
    return `${value}.startswith(${prefix})`;
  },
  "ends-with": (node, context, translate) => {
    const value = translate(node.items[0]!, context);
    const suffix = translate(node.items[1]!, context);
    return `${value}.endswith(${suffix})`;
  },
} as Record<string, PythonOperatorHandler>;
