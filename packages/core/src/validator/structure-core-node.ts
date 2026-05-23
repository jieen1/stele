import type { ListNode } from "../ast/types.js";
import type {
  CoreNodeDeclaration,
  CoreNodeMetricBoundary,
  CoreNodeMetricName,
  CoreNodeRole,
} from "./structure-types.js";
import { validationError } from "./structure-error.js";
import { readSingleExpression, ensureFieldUnset, readSingleString } from "./structure-shared.js";

const VALID_ROLES: CoreNodeRole[] = ["business-core-service"];

const VALID_METRICS_FOR_ROLE: Record<CoreNodeRole, CoreNodeMetricName[]> = {
  "business-core-service": ["sloc", "public-method-count", "max-cyclomatic"],
};

const CODE = "E0324";

export function parseCoreNodeDeclaration(filePath: string, node: ListNode): CoreNodeDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE,
      "Core-node declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the core-node id.",
      `Use a form like (core-node "payment-service" ...)`,
    );
  }

  const id = idNode.value;
  let lang: string | undefined;
  let role: CoreNodeRole | undefined;
  let target: string | undefined;
  let description: string | undefined;
  let rationale: string | undefined;
  const metrics: CoreNodeMetricBoundary[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE,
        `Core-node "${id}" contains an unsupported field entry.`,
        item.span,
        "Core-node fields must be nested list forms such as (lang ...), (role ...), or (metric ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "lang": {
        ensureFieldUnset(lang, "lang", `Core-node "${id}" lang`, CODE, item.span);
        lang = readSingleString(item, `Core-node "${id}" lang`, CODE);
        if (lang !== "typescript") {
          throw validationError(
            CODE,
            `Core-node "${id}" has an unsupported language "${lang}".`,
            item.span,
            'Only "typescript" is supported for core-node language.',
            'Use (lang typescript).',
          );
        }
        break;
      }
      case "role": {
        ensureFieldUnset(role, "role", `Core-node "${id}" role`, CODE, item.span);
        const roleValue = readSingleString(item, `Core-node "${id}" role`, CODE);
        if (!VALID_ROLES.includes(roleValue as CoreNodeRole)) {
          throw validationError(
            CODE,
            `Core-node "${id}" has an unsupported role "${roleValue}".`,
            item.span,
            `Supported roles are: ${VALID_ROLES.join(", ")}.`,
            "Use a supported role.",
          );
        }
        role = roleValue as CoreNodeRole;
        break;
      }
      case "target": {
        ensureFieldUnset(target, "target", `Core-node "${id}" target`, CODE, item.span);
        target = readSingleString(item, `Core-node "${id}" target`, CODE);
        if (!validateTargetFormat(target)) {
          throw validationError(
            CODE,
            `Core-node "${id}" has an invalid target format "${target}".`,
            item.span,
            'Target must be in the form "path/to/file.ts::ClassName".',
            "Use the format path::ClassName.",
          );
        }
        break;
      }
      case "description": {
        ensureFieldUnset(description, "description", `Core-node "${id}" description`, CODE, item.span);
        description = readSingleString(item, `Core-node "${id}" description`, CODE);
        break;
      }
      case "rationale": {
        ensureFieldUnset(rationale, "rationale", `Core-node "${id}" rationale`, CODE, item.span);
        rationale = readSingleString(item, `Core-node "${id}" rationale`, CODE);
        break;
      }
      case "metric": {
        if (role === undefined) {
          throw validationError(
            CODE,
            `Core-node "${id}" must declare (role ...) before (metric ...) so metric names can be validated.`,
            item.span,
            "The role determines which metrics are allowed.",
            "Move the (role ...) field before any (metric ...) fields.",
          );
        }
        const metric = parseMetricBoundary(item, role);
        // Check for duplicate metric names
        const dup = metrics.find((m) => m.name === metric.name);
        if (dup !== undefined) {
          throw validationError(
            CODE,
            `Core-node "${id}" has a duplicate metric "${metric.name}".`,
            item.span,
            `Metric "${metric.name}" was already declared.`,
            "Use unique metric names within a core-node.",
          );
        }
        if (metrics.length >= 3) {
          throw validationError(
            CODE,
            `Core-node "${id}" has too many metrics (max 3).`,
            item.span,
            `A maximum of 3 metrics are allowed per core-node.`,
            "Remove or consolidate metric declarations.",
          );
        }
        metrics.push(metric);
        break;
      }
      default:
        throw validationError(
          CODE,
          `Core-node "${id}" has an unknown field "${item.head}".`,
          item.span,
          "Supported core-node fields are: lang, role, target, description, rationale, metric.",
          "Rename or remove this field.",
        );
    }
  }

  // Validate required fields
  if (lang === undefined) {
    throw validationError(
      CODE,
      `Core-node "${id}" must declare a (lang ...) field.`,
      node.span,
      "The language field is required.",
      'Add (lang typescript).',
    );
  }

  if (role === undefined) {
    throw validationError(
      CODE,
      `Core-node "${id}" must declare a (role ...) field.`,
      node.span,
      "The role field is required.",
      'Add (role business-core-service).',
    );
  }

  if (target === undefined) {
    throw validationError(
      CODE,
      `Core-node "${id}" must declare a (target ...) field.`,
      node.span,
      "The target field is required.",
      'Add (target "path/to/file.ts::ClassName").',
    );
  }

  if (metrics.length === 0) {
    throw validationError(
      CODE,
      `Core-node "${id}" must declare at least one (metric ...) field.`,
      node.span,
      "At least one metric boundary is required.",
      'Add a metric like (metric sloc (ideal 220) (max 360)).',
    );
  }

  return {
    kind: "core-node",
    filePath,
    node,
    span: node.span,
    id,
    lang: lang as "typescript",
    role,
    target,
    description,
    rationale,
    metrics,
  };
}

function parseMetricBoundary(node: ListNode, role: CoreNodeRole): CoreNodeMetricBoundary {
  const nameNode = node.items[0];

  if (nameNode?.kind !== "identifier") {
    throw validationError(
      CODE,
      "Metric declarations must start with an identifier.",
      node.span,
      "The first item should be the metric name.",
      'Use a form like (metric sloc (ideal 220) (max 360)).',
    );
  }

  const metricName = nameNode.value;
  const allowedMetrics = VALID_METRICS_FOR_ROLE[role];

  if (!allowedMetrics.includes(metricName as CoreNodeMetricName)) {
    throw validationError(
      CODE,
      `Metric "${metricName}" is not valid for role "${role}".`,
      nameNode.span,
      `Valid metrics for this role are: ${allowedMetrics.join(", ")}.`,
      "Use a metric name that matches the declared role.",
    );
  }

  // Collect (ideal ...) and (max ...) sub-nodes
  let idealNode: ListNode | undefined;
  let maxNode: ListNode | undefined;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE,
        `Metric "${metricName}" contains an unsupported item.`,
        item.span,
        "Metric items must be (ideal N) and (max N) forms.",
        "Use (ideal N) and (max N) sub-nodes.",
      );
    }

    switch (item.head) {
      case "ideal": {
        if (idealNode !== undefined) {
          throw validationError(
            CODE,
            `Metric "${metricName}" declares (ideal ...) more than once.`,
            item.span,
            "Each metric can only have one ideal value.",
            "Keep a single (ideal ...) declaration.",
          );
        }
        idealNode = item;
        break;
      }
      case "max": {
        if (maxNode !== undefined) {
          throw validationError(
            CODE,
            `Metric "${metricName}" declares (max ...) more than once.`,
            item.span,
            "Each metric can only have one max value.",
            "Keep a single (max ...) declaration.",
          );
        }
        maxNode = item;
        break;
      }
      default:
        throw validationError(
          CODE,
          `Metric "${metricName}" has an unknown field "${item.head}".`,
          item.span,
          "Metric fields must be (ideal ...) and (max ...).",
          "Remove the unsupported field.",
        );
    }
  }

  if (idealNode === undefined) {
    throw validationError(
      CODE,
      `Metric "${metricName}" must declare an (ideal ...) value.`,
      node.span,
      "Each metric requires both (ideal N) and (max N).",
      'Add (ideal N) to the metric declaration.',
    );
  }

  if (maxNode === undefined) {
    throw validationError(
      CODE,
      `Metric "${metricName}" must declare a (max ...) value.`,
      node.span,
      "Each metric requires both (ideal N) and (max N).",
      'Add (max N) to the metric declaration.',
    );
  }

  const ideal = readNonNegativeInteger(idealNode, `metric "${metricName}" ideal`);
  const max = readNonNegativeInteger(maxNode, `metric "${metricName}" max`);

  if (ideal > max) {
    throw validationError(
      CODE,
      `Metric "${metricName}" has ideal (${ideal}) greater than max (${max}).`,
      node.span,
      "The ideal value must not exceed the max value.",
      "Adjust the ideal or max values so that ideal <= max.",
    );
  }

  return {
    name: metricName as CoreNodeMetricName,
    ideal,
    max,
  };
}

/**
 * Read a single non-negative integer from a list node.
 */
function readNonNegativeInteger(node: ListNode, label: string): number {
  const valueNode = readSingleExpression(node, label, CODE);

  if (valueNode.kind === "number") {
    const value = valueNode.value;
    if (value < 0) {
      throw validationError(
        CODE,
        `${label} must be a non-negative integer.`,
        valueNode.span,
        `Found negative value ${value}.`,
        "Use a non-negative integer.",
      );
    }
    if (!Number.isInteger(value)) {
      throw validationError(
        CODE,
        `${label} must be an integer.`,
        valueNode.span,
        `Found non-integer value ${value}.`,
        "Use a whole number.",
      );
    }
    return value;
  }

  throw validationError(
    CODE,
    `${label} must be a non-negative integer.`,
    valueNode.span,
    `Found ${valueNode.kind} instead of a number.`,
    "Use a numeric literal like 220.",
  );
}

/**
 * Validate that the target string matches "path/to/file.ts::ClassName".
 */
function validateTargetFormat(target: string): boolean {
  if (!target.includes("::")) {
    return false;
  }
  const parts = target.split("::");
  if (parts.length !== 2) {
    return false;
  }
  const pathPart = parts[0];
  const classPart = parts[1];
  // Path must be non-empty
  if (!pathPart || pathPart.includes(" ")) {
    return false;
  }
  // Class name must be non-empty and alphanumeric with common class-name chars
  if (!classPart || /[^a-zA-Z0-9_$-]/.test(classPart)) {
    return false;
  }
  return true;
}
