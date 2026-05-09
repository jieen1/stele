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
  // EP04 batch 1: trim/lower/upper/split/join.
  // Cross-backend semantics pinned: locale-independent case mapping, Unicode
  // whitespace trim parity with JS, empty-separator split rejection, mixed-type
  // join rejection. All routed through runtime helpers so error messages stay
  // byte-equal across Python and TypeScript.
  trim: (node, context, translate) => `stele_trim(${translate(node.items[0]!, context)})`,
  lower: (node, context, translate) => `stele_lower(${translate(node.items[0]!, context)})`,
  upper: (node, context, translate) => `stele_upper(${translate(node.items[0]!, context)})`,
  split: (node, context, translate) => {
    const value = translate(node.items[0]!, context);
    const sep = translate(node.items[1]!, context);
    return `stele_split(${value}, ${sep})`;
  },
  join: (node, context, translate) => {
    const collection = translate(node.items[0]!, context);
    const sep = translate(node.items[1]!, context);
    return `stele_join(${collection}, ${sep})`;
  },
} as Record<string, PythonOperatorHandler>;
