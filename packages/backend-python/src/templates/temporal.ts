import { SteleError, type AstNode, type ListNode } from "@stele/core";
import type { PythonExpressionTranslator, PythonOperatorHandler, TranslationContext } from "../translator.js";

export const temporalOperatorHandlers: Record<string, PythonOperatorHandler> = {
  before: (node, context, translate) => `${translate(node.items[0]!, context)} < ${translate(node.items[1]!, context)}`,
  after: (node, context, translate) => `${translate(node.items[0]!, context)} > ${translate(node.items[1]!, context)}`,
  modified: (node, context) => `stele_is_modified(${context.rootContextName}, ${JSON.stringify(readModifiedPath(node.items[0], node))})`,
  "state-before": (_node, context) => `${context.rootContextName}["state-before"]`,
  "state-after": (_node, context) => `${context.rootContextName}["state-after"]`,
  within: (node, context, translate) => translateWithin(node, context, translate),
} as Record<string, PythonOperatorHandler>;

function translateWithin(node: ListNode, context: TranslationContext, translate: PythonExpressionTranslator): string {
  const event = translate(node.items[0]!, context);
  const duration = node.items[1];

  if (duration?.kind === "number") {
    return `(datetime.datetime.now() - ${event}) < datetime.timedelta(seconds=${duration.raw})`;
  }

  return `((datetime.datetime.now() - ${event}) < ${translate(duration!, context)})`;
}

function readModifiedPath(node: AstNode | undefined, owner: ListNode): string[] {
  if (node?.kind !== "list" || node.head !== "path" || node.items.length === 0) {
    throw new SteleError(
      "E0603",
      "Backend Error",
      'Operator "modified" expects exactly one path expression.',
      node?.span ?? owner.span,
      "The Python backend compares state-before and state-after by path.",
      'Use a form like (modified (path account balance)).',
    );
  }

  return node.items.map((part) => {
    if (part.kind === "identifier") {
      return part.value;
    }

    if (part.kind === "keyword") {
      return `:${part.value}`;
    }

    throw new SteleError(
      "E0603",
      "Backend Error",
      'Modified path segments must be identifiers or keywords.',
      part.span,
      `Found ${part.kind} inside a modified path.`,
      "Replace the segment with a symbol-like path part.",
    );
  });
}
