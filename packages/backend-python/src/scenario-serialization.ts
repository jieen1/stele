import { SteleError, type AstNode, type ListNode, type ScenarioDeclaration, type ScenarioOperation } from "@stele/core";
import { readPathPart, toPythonString } from "./translation-utils.js";

function isListNode(node: AstNode): node is ListNode {
  return node.kind === "list";
}

// ---------------------------------------------------------------------------
// Scenario serialization
//
// Converts scenario AST nodes to plain JavaScript objects that can be
// rendered as inline Python literals in generated pytest source.
// ---------------------------------------------------------------------------

// Re-exported types for scenario serialization

export interface SerializedScenario {
  id: string;
  executor: string;
  sandbox: unknown;
  steps: SerializedStep[];
}

export interface SerializedStep {
  kind: string;
  id?: string;
  capture?: string;
  call: SerializedCall;
}

export interface SerializedCall {
  target: string;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Scenario → serialized object
// ---------------------------------------------------------------------------

export function serializeScenario(scenario: ScenarioDeclaration): SerializedScenario {
  return {
    id: scenario.id,
    executor: scenario.executor,
    sandbox: scenario.sandbox,
    steps: scenario.steps.map(serializeScenarioOperation),
  };
}

function serializeScenarioOperation(step: ScenarioOperation): SerializedStep {
  if (step.kind === "step") {
    return {
      kind: step.kind,
      id: step.id,
      capture: step.capture,
      call: serializeScenarioCall(step.call.target, step.call.body),
    };
  }

  return {
    kind: step.kind,
    capture: step.capture,
    call: serializeScenarioCall(step.call.target, step.call.body),
  };
}

function serializeScenarioCall(target: string, body: AstNode | undefined): SerializedCall {
  return {
    target,
    ...(body === undefined ? {} : { body: serializeScenarioValue(body) }),
  };
}

export function serializeScenarioValue(node: AstNode): unknown {
  if (node.kind === "number") {
    return node.value;
  }

  if (node.kind === "string") {
    return node.value;
  }

  if (node.kind === "keyword") {
    return `:${node.value}`;
  }

  if (node.kind === "identifier") {
    switch (node.value) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
      case "none":
        return null;
      default:
        throw new SteleError(
          "E0606",
          "Backend Error",
          `Unsupported bare identifier "${node.value}" in scenario body.`,
          node.span,
          "Scenario bodies currently support object, ref, gen, booleans, and null-like identifiers.",
          "Wrap the value in a supported scenario expression or quote it as a string literal.",
        );
    }
  }

  if (node.head === "object") {
    return Object.fromEntries(node.items.map(serializeScenarioObjectField));
  }

  if (isListNode(node) && node.head === "ref") {
    return { $ref: serializeScenarioRef(node) };
  }

  if (isListNode(node) && node.head === "gen") {
    return { $gen: serializeScenarioGenerator(node) };
  }

  throw new SteleError(
    "E0606",
    "Backend Error",
    `Unsupported scenario body operator "${node.head}".`,
    node.span,
    "The Python scenario slice supports object, ref, and gen forms inside scenario call bodies.",
    "Rewrite this body using the supported scenario expression forms.",
  );
}

function serializeScenarioObjectField(node: AstNode): [string, unknown] {
  if (node.kind !== "list") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario object fields must be list entries.",
      node.span,
      "Each object field should look like (key expr).",
      "Rewrite this object entry as a single-field list.",
    );
  }

  if (node.items.length !== 1) {
    throw new SteleError(
      "E0606",
      "Backend Error",
      `Scenario object field "${node.head}" expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value for each object key.",
    );
  }

  return [node.head, serializeScenarioValue(node.items[0]!)];
}

function serializeScenarioRef(node: ListNode): string[] {
  const [captureNode, ...fieldNodes] = node.items;

  if (captureNode?.kind !== "identifier") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario ref expressions must start with a captured identifier.",
      captureNode?.span ?? node.span,
      `Found ${captureNode === undefined ? "nothing" : captureNode.kind} where the capture name should be.`,
      "Use a form like (ref fund id).",
    );
  }

  return [captureNode.value, ...fieldNodes.map((item: AstNode) => readPathPart(item))];
}

function serializeScenarioGenerator(node: ListNode): Record<string, unknown> {
  const [kindNode, prefixNode] = node.items;

  if (kindNode?.kind !== "identifier" || kindNode.value !== "unique-name") {
    throw new SteleError(
      "E0606",
      "Backend Error",
      "Scenario gen expressions currently support only unique-name.",
      kindNode?.span ?? node.span,
      `Found ${kindNode === undefined ? "nothing" : describeScenarioNode(kindNode)} instead.`,
      'Use a form like (gen unique-name "fund").',
    );
  }

  if (prefixNode?.kind !== "string" || node.items.length !== 2) {
    throw new SteleError(
      "E0606",
      "Backend Error",
      'Scenario gen unique-name expects exactly one string prefix.',
      prefixNode?.span ?? node.span,
      `Found ${node.items.length - 1} generator argument(s).`,
      'Use a form like (gen unique-name "fund").',
    );
  }

  return {
    kind: "unique-name",
    prefix: prefixNode.value,
  };
}

function describeScenarioNode(node: AstNode): string {
  if (node.kind === "list") {
    return `list "${node.head}"`;
  }

  return `${node.kind} "${node.value}"`;
}

// ---------------------------------------------------------------------------
// Render serialized scenario as Python literal
// ---------------------------------------------------------------------------

export function renderPythonValue(value: unknown, indentLevel: number): string[] {
  const prefix = "    ".repeat(indentLevel);

  if (value === null) {
    return [`${prefix}None,`];
  }

  if (typeof value === "string") {
    return [`${prefix}${toPythonString(value)},`];
  }

  if (typeof value === "number") {
    return [`${prefix}${String(value)},`];
  }

  if (typeof value === "boolean") {
    return [`${prefix}${value ? "True" : "False"},`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[],`];
    }

    const lines = [`${prefix}[`];
    for (const item of value) {
      lines.push(...renderPythonValue(item, indentLevel + 1));
    }
    lines.push(`${prefix}],`);
    return lines;
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    return [`${prefix}{},`];
  }

  const lines = [`${prefix}{`];

  for (const [key, entryValue] of entries) {
    const renderedInline = renderInlinePythonValue(entryValue);

    if (renderedInline !== undefined) {
      lines.push(`${"    ".repeat(indentLevel + 1)}${toPythonString(key)}: ${renderedInline},`);
      continue;
    }

    lines.push(`${"    ".repeat(indentLevel + 1)}${toPythonString(key)}:`);
    lines.push(...renderPythonValue(entryValue, indentLevel + 2));
  }

  lines.push(`${prefix}},`);
  return lines;
}

function renderInlinePythonValue(value: unknown): string | undefined {
  if (value === null) {
    return "None";
  }

  if (typeof value === "string") {
    return toPythonString(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return `[${value.map((item) => toPythonString(item)).join(", ")}]`;
    }

    return undefined;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0) {
      return "{}";
    }

    if (entries.every(([, entryValue]) => renderInlinePythonValue(entryValue) !== undefined)) {
      return `{${entries
        .map(([key, entryValue]) => `${toPythonString(key)}: ${renderInlinePythonValue(entryValue)}`)
        .join(", ")}}`;
    }
  }

  return undefined;
}

