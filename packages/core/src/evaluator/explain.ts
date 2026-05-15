import type { AstNode, ListNode } from "../ast/types.js";
import type { InvariantDeclaration } from "../validator/structure-types.js";
import type { ExplainTrace } from "../report/types.js";

const INDENT = "  ";

// ---------------------------------------------------------------------------
// AST-to-string helpers
// ---------------------------------------------------------------------------

function astToString(node: AstNode): string {
  switch (node.kind) {
    case "identifier":
      return node.value;
    case "keyword":
      return node.value.startsWith(":") ? node.value : `:${node.value}`;
    case "string":
      return node.value;
    case "number":
      return node.raw;
    case "list":
      return `(${node.head} ${node.items.map(astToString).join(" ")})`;
  }
}

// ---------------------------------------------------------------------------
// Trace builders
// ---------------------------------------------------------------------------

/**
 * Build a root ExplainTrace for an invariant declaration.
 *
 * Walks the assert-expression AST, records each sub-expression, and attaches
 * human-readable explanations from the (explain) operator.
 *
 * The `evaluated` field is null until the language backend populates it with
 * actual runtime results.
 */
export function buildInvariantTrace(invariant: InvariantDeclaration, evaluated: boolean | null): ExplainTrace {
  const children: ExplainTrace[] = [];

  if (invariant.assertExpression !== undefined) {
    const assertTrace = nodeToTrace(invariant.assertExpression);
    if (assertTrace !== undefined) {
      children.push(assertTrace);
    }
  }

  if (invariant.whenExpression !== undefined) {
    const whenTrace = nodeToTrace(invariant.whenExpression);
    if (whenTrace !== undefined) {
      children.push(whenTrace);
    }
  }

  return {
    expression: `(invariant ${invariant.id})`,
    evaluated,
    explanation: invariantExplanation(invariant),
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Recursively walk an AST node into an ExplainTrace.
 */
function nodeToTrace(node: AstNode): ExplainTrace | undefined {
  if (node.kind !== "list") {
    return { expression: astToString(node), evaluated: null };
  }

  // Check for embedded (explain "reason") child
  let explanation: string | undefined;
  const explainNode = node.items.find(
    (item): item is ListNode => item.kind === "list" && item.head === "explain" && item.items[0]?.kind === "string",
  );
  if (explainNode !== undefined) {
    const valNode = explainNode.items[0];
    if (valNode?.kind === "string") {
      explanation = valNode.value;
    }
  }

  const children: ExplainTrace[] = [];
  for (const item of node.items) {
    if (item.kind === "list" && item.head === "explain") {
      continue; // Skip embedded explain nodes
    }
    const child = nodeToTrace(item);
    if (child !== undefined) {
      children.push(child);
    }
  }

  const result: ExplainTrace = {
    expression: astToString(node),
    evaluated: null,
    ...(explanation !== undefined ? { explanation } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format an ExplainTrace as indented text for CLI output.
 */
export function formatExplainTrace(trace: ExplainTrace, depth = 0): string[] {
  const prefix = INDENT.repeat(depth);
  const lines: string[] = [];

  const status = trace.evaluated === true
    ? "true"
    : trace.evaluated === false
      ? "false"
      : "?";

  lines.push(`${prefix}${trace.expression} - ${status}`);

  if (trace.explanation !== undefined) {
    lines.push(`${prefix}  why: ${trace.explanation}`);
  }

  if (trace.failureDetail !== undefined) {
    lines.push(`${prefix}  detail: ${trace.failureDetail}`);
  }

  if (trace.children !== undefined) {
    for (const child of trace.children) {
      lines.push(...formatExplainTrace(child, depth + 1));
    }
  }

  return lines;
}

/**
 * Extract explanation text from an invariant's (explain) field.
 * Returns undefined if no (explain) operator is present.
 */
export function invariantExplanation(invariant: InvariantDeclaration): string | undefined {
  const node = invariant.explain?.valueNode;
  if (node === undefined) return undefined;
  if (node.kind === "string") return node.value;
  if (node.kind === "identifier") return node.value;
  return undefined;
}
