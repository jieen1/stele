import type { AstNode, ListNode } from "../ast/types.js";
import { readSingleExpression } from "./structure-shared.js";
import { ALLOWED_INVARIANT_FIELDS } from "./structure-types.js";

// Re-export for backward compatibility (tests)
export { readSingleExpression };
import type {
  CheckerUse,
  InvariantDeclaration,
  InvariantDependency,
  InvariantMultiValueField,
  InvariantSingleValueField,
  InvariantSingleValueFieldName,
  ScenarioUse,
} from "./structure-types.js";
import { describeNode, validationError } from "./structure-error.js";

export function parseInvariantDeclaration(filePath: string, node: ListNode, groupId?: string): InvariantDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0305",
      "Invariant declarations must start with an identifier.",
      node.span,
      "The first invariant item should be the invariant id.",
      'Use a form like (invariant ACCT_001 ...).',
    );
  }

  let severity: string | undefined;
  let description: string | undefined;
  let assertExpression: AstNode | undefined;
  let usesChecker: CheckerUse | undefined;
  let usesScenario: ScenarioUse | undefined;
  let whenExpression: AstNode | undefined;
  let dependsOn: InvariantDependency[] = [];
  let category: InvariantSingleValueField | undefined;
  let tags: InvariantMultiValueField | undefined;
  let tolerance: InvariantSingleValueField | undefined;
  let rationale: InvariantSingleValueField | undefined;
  let since: InvariantSingleValueField | undefined;
  let appliesTo: InvariantSingleValueField | undefined;
  let explain: InvariantSingleValueField | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0305",
        `Invariant "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Invariant fields must be nested list forms such as (severity high) or (assert ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    if (!ALLOWED_INVARIANT_FIELDS.has(field.head)) {
      throw validationError(
        "E0305",
        `Invariant "${idNode.value}" has an unknown field "${field.head}".`,
        field.span,
        `Supported invariant fields are: ${Array.from(ALLOWED_INVARIANT_FIELDS).join(", ")}.`,
        "Rename or remove this field.",
      );
    }

    switch (field.head) {
      case "severity":
        ensureInvariantFieldUnset(severity, field, `Invariant "${idNode.value}" severity`);
        severity = readSingleText(field, `Invariant "${idNode.value}" severity`);
        break;
      case "description":
        ensureInvariantFieldUnset(description, field, `Invariant "${idNode.value}" description`);
        description = readSingleString(field, `Invariant "${idNode.value}" description`);
        break;
      case "assert":
        ensureInvariantFieldUnset(assertExpression, field, `Invariant "${idNode.value}" assert`);
        assertExpression = readSingleExpression(field, `Invariant "${idNode.value}" assert`, "E0305");
        break;
      case "uses-checker": {
        ensureInvariantFieldUnset(usesChecker, field, `Invariant "${idNode.value}" uses-checker`);
        const checkerIdNode = field.items[0];

        if (checkerIdNode?.kind !== "identifier") {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" must reference a checker id.`,
            field.span,
            "uses-checker expects an identifier as its first argument.",
            'Use a form like (uses-checker checker_id).',
          );
        }

        usesChecker = {
          checkerId: checkerIdNode.value,
          span: checkerIdNode.span,
          args: field.items.slice(1),
          node: field,
        };
        break;
      }
      case "uses-scenario": {
        ensureInvariantFieldUnset(usesScenario, field, `Invariant "${idNode.value}" uses-scenario`);
        const scenarioIdNode = field.items[0];

        if (scenarioIdNode?.kind !== "identifier") {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" must reference a scenario id.`,
            field.span,
            "uses-scenario expects an identifier as its first argument.",
            'Use a form like (uses-scenario fund-pnl-flow).',
          );
        }

        if (field.items.length !== 1) {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" uses-scenario expects exactly one scenario id.`,
            field.span,
            `Found ${field.items.length} value(s).`,
            "Keep a single scenario id inside uses-scenario.",
          );
        }

        usesScenario = {
          scenarioId: scenarioIdNode.value,
          span: scenarioIdNode.span,
          node: field,
        };
        break;
      }
      case "when":
        ensureInvariantFieldUnset(whenExpression, field, `Invariant "${idNode.value}" when`);
        whenExpression = readSingleExpression(field, `Invariant "${idNode.value}" when`, "E0305");
        break;
      case "depends-on":
        ensureInvariantFieldUnset(dependsOn.length === 0 ? undefined : dependsOn, field, `Invariant "${idNode.value}" depends-on`);
        dependsOn = field.items.map((item) => {
          if (item.kind !== "identifier") {
            throw validationError(
              "E0305",
              `Invariant "${idNode.value}" has an invalid dependency entry.`,
              item.span,
              "depends-on expects invariant ids as identifiers.",
              'Use a form like (depends-on ACCT_001 ACCT_002).',
            );
          }

          return { id: item.value, span: item.span };
        });
        break;
      case "category":
        ensureInvariantFieldUnset(category, field, `Invariant "${idNode.value}" category`);
        category = readSingleValueField(field, "category");
        break;
      case "tags":
        ensureInvariantFieldUnset(tags, field, `Invariant "${idNode.value}" tags`);
        tags = readMultiValueField(field, "tags");
        break;
      case "tolerance":
        ensureInvariantFieldUnset(tolerance, field, `Invariant "${idNode.value}" tolerance`);
        tolerance = readSingleValueField(field, "tolerance");
        break;
      case "rationale":
        ensureInvariantFieldUnset(rationale, field, `Invariant "${idNode.value}" rationale`);
        rationale = readSingleValueField(field, "rationale");
        break;
      case "since":
        ensureInvariantFieldUnset(since, field, `Invariant "${idNode.value}" since`);
        since = readSingleValueField(field, "since");
        break;
      case "applies-to":
        ensureInvariantFieldUnset(appliesTo, field, `Invariant "${idNode.value}" applies-to`);
        appliesTo = readSingleValueField(field, "applies-to");
        break;
      case "explain":
        ensureInvariantFieldUnset(explain, field, `Invariant "${idNode.value}" explain`);
        explain = readSingleValueField(field, "explain");
        break;
    }
  }

  if (severity === undefined) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" is missing a severity field.`,
      node.span,
      "Every invariant must declare a severity.",
      "Add a field such as (severity high).",
    );
  }

  if (description === undefined) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" is missing a description field.`,
      node.span,
      "Every invariant must describe what it protects.",
      'Add a field such as (description "Explain the rule").',
    );
  }

  if ((assertExpression === undefined) === (usesChecker === undefined)) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" must declare exactly one of assert or uses-checker.`,
      node.span,
      "Invariant bodies need one executable rule source.",
      "Keep either (assert ...) or (uses-checker ...), but not both.",
    );
  }

  return {
    kind: "invariant",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    groupId,
    severity,
    description,
    assertExpression,
    usesChecker,
    usesScenario,
    whenExpression,
    dependsOn,
    category,
    tags,
    tolerance,
    rationale,
    since,
    appliesTo,
    explain,
  };
}

// -- helpers --

function readSingleString(node: ListNode, label: string): string {
  const item = readSingleExpression(node, label, "E0305");

  if (item.kind !== "string") {
    throw validationError(
      "E0305",
      `${label} must be a string literal.`,
      item.span,
      `Found ${describeNode(item)} instead of a string literal.`,
      "Wrap the value in double quotes.",
    );
  }

  return item.value;
}

function readSingleText(node: ListNode, label: string): string {
  const item = readSingleExpression(node, label, "E0305");

  if (item.kind !== "identifier" && item.kind !== "string") {
    throw validationError(
      "E0305",
      `${label} must be an identifier or string literal.`,
      item.span,
      `Found ${describeNode(item)} instead.`,
      "Use a plain identifier like high or a quoted string if needed.",
    );
  }

  return item.value;
}

function readSingleValueField(node: ListNode, name: InvariantSingleValueFieldName): InvariantSingleValueField {
  return {
    kind: "field",
    name,
    node,
    span: node.span,
    valueNode: readSingleExpression(node, `Invariant field "${name}"`, "E0305"),
  };
}

function readMultiValueField(node: ListNode, name: "tags"): InvariantMultiValueField {
  if (node.items.length === 0) {
    throw validationError(
      "E0305",
      `Invariant field "${name}" expects at least one value.`,
      node.span,
      "This field was declared without any values.",
      "Provide one or more values for this field.",
    );
  }

  return {
    kind: "field",
    name,
    node,
    span: node.span,
    valueNodes: [...node.items],
  };
}

function ensureInvariantFieldUnset(value: unknown, field: ListNode, label: string): void {
  if (value !== undefined) {
    throw validationError(
      "E0305",
      `${label} may only be declared once.`,
      field.span,
      "This field already appeared earlier in the same invariant or group.",
      "Merge the values into one field.",
    );
  }
}
