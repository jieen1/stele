import type { AstNode, ListNode } from "../ast/types.js";
import { readSingleExpression, ensureFieldUnset } from "./structure-shared.js";
import { ALLOWED_INVARIANT_FIELDS } from "./structure-types.js";
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

/** Alias for complexity contract targeting. */
export { parseInvariantDeclaration as validateInvariant };
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
        ensureFieldUnset(severity, "severity", `Invariant "${idNode.value}" severity`, "E0305", field.span);
        severity = readSingleText(field, `Invariant "${idNode.value}" severity`);
        break;
      case "description":
        ensureFieldUnset(description, "description", `Invariant "${idNode.value}" description`, "E0305", field.span);
        description = readStringLiteral(field, `Invariant "${idNode.value}" description`);
        break;
      case "assert":
        ensureFieldUnset(assertExpression, "assert", `Invariant "${idNode.value}" assert`, "E0305", field.span);
        assertExpression = readSingleExpression(field, `Invariant "${idNode.value}" assert`, "E0305");
        break;
      case "uses-checker": {
        ensureFieldUnset(usesChecker, "uses-checker", `Invariant "${idNode.value}" uses-checker`, "E0305", field.span);
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
        ensureFieldUnset(usesScenario, "uses-scenario", `Invariant "${idNode.value}" uses-scenario`, "E0305", field.span);
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
        ensureFieldUnset(whenExpression, "when", `Invariant "${idNode.value}" when`, "E0305", field.span);
        whenExpression = readSingleExpression(field, `Invariant "${idNode.value}" when`, "E0305");
        break;
      case "depends-on":
        ensureFieldUnset(dependsOn.length === 0 ? undefined : dependsOn, "depends-on", `Invariant "${idNode.value}" depends-on`, "E0305", field.span);
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
        ensureFieldUnset(category, "category", `Invariant "${idNode.value}" category`, "E0305", field.span);
        category = readSingleValueField(field, "category");
        break;
      case "tags":
        ensureFieldUnset(tags, "tags", `Invariant "${idNode.value}" tags`, "E0305", field.span);
        tags = readMultiValueField(field, "tags");
        break;
      case "tolerance":
        ensureFieldUnset(tolerance, "tolerance", `Invariant "${idNode.value}" tolerance`, "E0305", field.span);
        tolerance = readSingleValueField(field, "tolerance");
        break;
      case "rationale":
        ensureFieldUnset(rationale, "rationale", `Invariant "${idNode.value}" rationale`, "E0305", field.span);
        rationale = readSingleValueField(field, "rationale");
        break;
      case "since":
        ensureFieldUnset(since, "since", `Invariant "${idNode.value}" since`, "E0305", field.span);
        since = readSingleValueField(field, "since");
        break;
      case "applies-to":
        ensureFieldUnset(appliesTo, "applies-to", `Invariant "${idNode.value}" applies-to`, "E0305", field.span);
        appliesTo = readSingleValueField(field, "applies-to");
        break;
      case "explain":
        ensureFieldUnset(explain, "explain", `Invariant "${idNode.value}" explain`, "E0305", field.span);
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

function readStringLiteral(node: ListNode, label: string): string {
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
