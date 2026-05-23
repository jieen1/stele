import { compilePattern } from "@stele/call-graph-core";
import type { ListNode, SourceSpan } from "../ast/types.js";
import { describeNode, validationError } from "./structure-error.js";
import { ensureFieldUnset } from "./structure-shared.js";

/**
 * Single trace-policy declaration parsed from CDL.
 *
 * @see docs/design/phase-b/02-trace-based-policy.md for semantics
 */
export interface TracePolicyExempt {
  readonly pattern: string;
  readonly reason: string;
  readonly span: SourceSpan;
}

export interface TracePolicyDeclaration {
  readonly kind: "trace-policy";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly id: string;
  readonly description?: string;
  readonly severity: "error" | "warning";
  readonly target: readonly string[];
  readonly mustTransit: readonly string[];
  readonly mustBePrecededBy: readonly string[];
  readonly mustBeFollowedBy: readonly string[];
  readonly denyDirect: readonly string[];
  readonly denyTransit: readonly string[];
  readonly scope: readonly string[];
  readonly exempt: readonly TracePolicyExempt[];
  readonly fixHint?: string;
}

const CODE_MISSING_ID = "E0330";
const CODE_MISSING_TARGET = "E0332";
const CODE_NO_CONSTRAINT = "E0333";
const CODE_EXEMPT_MISSING_REASON = "E0334";
const CODE_BAD_PATTERN = "E0335";
const CODE_BAD_SEVERITY = "E0336";
const CODE_DUPLICATE_FIELD = "E0337";
const CODE_UNKNOWN_FIELD = "E0338";
const CODE_FIX_HINT_VAGUE = "E0339";

const KNOWN_FIELDS = new Set([
  "description",
  "severity",
  "target",
  "must-transit",
  "must-be-preceded-by",
  "must-be-followed-by",
  "deny-direct",
  "deny-transit",
  "scope",
  "exempt",
  "fix-hint",
]);

/**
 * Validate a fix-hint string: must contain at least one backtick-quoted snippet
 * (`...`) OR a file:line reference (something like `src/x.ts:42`). Returns
 * true when the hint is "actionable" by the agent.
 */
export function isFixHintActionable(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.includes("`")) {
    return true;
  }
  // file:line — any non-space sequence ending with `:<digits>` works.
  if (/\S:\d+/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Parse a `(trace-policy ...)` top-level form. Throws SteleError on E0330-E0339.
 */
export function parseTracePolicyDeclaration(
  filePath: string,
  node: ListNode,
): TracePolicyDeclaration {
  const idNode = node.items[0];

  if (idNode === undefined || (idNode.kind !== "identifier" && idNode.kind !== "string")) {
    throw validationError(
      CODE_MISSING_ID,
      "Trace-policy declarations must start with an identifier or string id.",
      node.span,
      "The first item of a trace-policy form is the policy id.",
      'Use a form like (trace-policy DB_VIA_REPOSITORY ...).',
    );
  }

  const id = idNode.value;
  let description: string | undefined;
  let severity: "error" | "warning" | undefined;
  let target: readonly string[] | undefined;
  let mustTransit: readonly string[] | undefined;
  let mustBePrecededBy: readonly string[] | undefined;
  let mustBeFollowedBy: readonly string[] | undefined;
  let denyDirect: readonly string[] | undefined;
  let denyTransit: readonly string[] | undefined;
  let scope: readonly string[] | undefined;
  let fixHint: string | undefined;
  const exempt: TracePolicyExempt[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Trace-policy "${id}" contains an unsupported entry.`,
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in a supported field list.",
      );
    }

    if (!KNOWN_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Trace-policy "${id}" has an unknown field "${item.head}".`,
        item.span,
        "Supported trace-policy fields are: description, severity, target, must-transit, must-be-preceded-by, must-be-followed-by, deny-direct, deny-transit, scope, exempt, fix-hint.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "description": {
        ensureFieldUnset(description, "description", `Trace-policy "${id}" description`, CODE_DUPLICATE_FIELD, item.span);
        description = readSingleStringField(item, `Trace-policy "${id}" description`, CODE_DUPLICATE_FIELD);
        break;
      }
      case "severity": {
        ensureFieldUnset(severity, "severity", `Trace-policy "${id}" severity`, CODE_DUPLICATE_FIELD, item.span);
        const value = readSingleStringField(item, `Trace-policy "${id}" severity`, CODE_BAD_SEVERITY);
        if (value !== "error" && value !== "warning") {
          throw validationError(
            CODE_BAD_SEVERITY,
            `Trace-policy "${id}" severity must be "error" or "warning".`,
            item.span,
            `Found "${value}".`,
            'Use (severity "error") or (severity "warning").',
          );
        }
        severity = value;
        break;
      }
      case "target": {
        ensureFieldUnset(target, "target", `Trace-policy "${id}" target`, CODE_DUPLICATE_FIELD, item.span);
        target = readPatternList(item, id, "target");
        break;
      }
      case "must-transit": {
        ensureFieldUnset(mustTransit, "must-transit", `Trace-policy "${id}" must-transit`, CODE_DUPLICATE_FIELD, item.span);
        mustTransit = readPatternList(item, id, "must-transit");
        break;
      }
      case "must-be-preceded-by": {
        ensureFieldUnset(mustBePrecededBy, "must-be-preceded-by", `Trace-policy "${id}" must-be-preceded-by`, CODE_DUPLICATE_FIELD, item.span);
        mustBePrecededBy = readPatternList(item, id, "must-be-preceded-by");
        break;
      }
      case "must-be-followed-by": {
        ensureFieldUnset(mustBeFollowedBy, "must-be-followed-by", `Trace-policy "${id}" must-be-followed-by`, CODE_DUPLICATE_FIELD, item.span);
        mustBeFollowedBy = readPatternList(item, id, "must-be-followed-by");
        break;
      }
      case "deny-direct": {
        ensureFieldUnset(denyDirect, "deny-direct", `Trace-policy "${id}" deny-direct`, CODE_DUPLICATE_FIELD, item.span);
        denyDirect = readPatternList(item, id, "deny-direct");
        break;
      }
      case "deny-transit": {
        ensureFieldUnset(denyTransit, "deny-transit", `Trace-policy "${id}" deny-transit`, CODE_DUPLICATE_FIELD, item.span);
        denyTransit = readPatternList(item, id, "deny-transit");
        break;
      }
      case "scope": {
        ensureFieldUnset(scope, "scope", `Trace-policy "${id}" scope`, CODE_DUPLICATE_FIELD, item.span);
        scope = readPatternList(item, id, "scope");
        break;
      }
      case "exempt": {
        exempt.push(parseExemptEntry(item, id));
        break;
      }
      case "fix-hint": {
        ensureFieldUnset(fixHint, "fix-hint", `Trace-policy "${id}" fix-hint`, CODE_DUPLICATE_FIELD, item.span);
        const value = readSingleStringField(item, `Trace-policy "${id}" fix-hint`, CODE_FIX_HINT_VAGUE);
        if (!isFixHintActionable(value)) {
          throw validationError(
            CODE_FIX_HINT_VAGUE,
            `Trace-policy "${id}" fix-hint is too vague to be actionable.`,
            item.span,
            'A fix-hint must reference code (e.g. `Repository.find`) or a file:line location (e.g. "src/repo.ts:42").',
            "Quote a code symbol with backticks or cite the file and line where the fix should be applied.",
          );
        }
        fixHint = value;
        break;
      }
      default:
        // Unreachable: KNOWN_FIELDS gates the switch.
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Trace-policy "${id}" has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (target === undefined || target.length === 0) {
    throw validationError(
      CODE_MISSING_TARGET,
      `Trace-policy "${id}" must declare a non-empty (target ...) field.`,
      node.span,
      "The target field is required and must list at least one pattern.",
      'Add (target "<pattern>") with one or more NodeId patterns.',
    );
  }

  const constraintCount =
    (mustTransit?.length ?? 0) +
    (mustBePrecededBy?.length ?? 0) +
    (mustBeFollowedBy?.length ?? 0) +
    (denyDirect?.length ?? 0) +
    (denyTransit?.length ?? 0);

  if (constraintCount === 0) {
    throw validationError(
      CODE_NO_CONSTRAINT,
      `Trace-policy "${id}" must declare at least one must-* or deny-* constraint.`,
      node.span,
      "A trace-policy with only a target imposes no rule on the call graph.",
      "Add one of: (must-transit ...), (must-be-preceded-by ...), (must-be-followed-by ...), (deny-direct ...), (deny-transit ...).",
    );
  }

  return {
    kind: "trace-policy",
    filePath,
    node,
    span: node.span,
    id,
    description,
    severity: severity ?? "error",
    target,
    mustTransit: mustTransit ?? [],
    mustBePrecededBy: mustBePrecededBy ?? [],
    mustBeFollowedBy: mustBeFollowedBy ?? [],
    denyDirect: denyDirect ?? [],
    denyTransit: denyTransit ?? [],
    scope: scope ?? [],
    exempt,
    fixHint,
  };
}

function parseExemptEntry(item: ListNode, policyId: string): TracePolicyExempt {
  if (item.items.length < 2) {
    throw validationError(
      CODE_EXEMPT_MISSING_REASON,
      `Trace-policy "${policyId}" exempt entry must include a pattern and (reason "...").`,
      item.span,
      `Found ${item.items.length} item(s) inside this exempt entry.`,
      'Use (exempt "<pattern>" (reason "<why>")).',
    );
  }

  const patternNode = item.items[0]!;
  if (patternNode.kind !== "string") {
    throw validationError(
      CODE_BAD_PATTERN,
      `Trace-policy "${policyId}" exempt pattern must be a string literal.`,
      patternNode.span,
      `Found ${describeNode(patternNode)} instead of a string literal.`,
      "Wrap the pattern in double quotes.",
    );
  }

  const pattern = patternNode.value;
  validatePatternSyntax(pattern, patternNode.span, `Trace-policy "${policyId}" exempt`);

  let reason: string | undefined;
  for (const child of item.items.slice(1)) {
    if (child.kind !== "list" || child.head !== "reason") {
      throw validationError(
        CODE_EXEMPT_MISSING_REASON,
        `Trace-policy "${policyId}" exempt entry only supports a trailing (reason "...").`,
        child.span,
        `Found ${describeNode(child)}.`,
        'Use (exempt "<pattern>" (reason "<why>")).',
      );
    }
    if (reason !== undefined) {
      throw validationError(
        CODE_EXEMPT_MISSING_REASON,
        `Trace-policy "${policyId}" exempt entry declares (reason ...) more than once.`,
        child.span,
        "Each exempt entry may declare reason only once.",
        "Keep a single (reason \"...\") inside this exempt entry.",
      );
    }
    reason = readSingleStringField(child, `Trace-policy "${policyId}" exempt reason`, CODE_EXEMPT_MISSING_REASON);
  }

  if (reason === undefined) {
    throw validationError(
      CODE_EXEMPT_MISSING_REASON,
      `Trace-policy "${policyId}" exempt entry is missing (reason "...").`,
      item.span,
      "Every exempt requires a reason so audits remain readable.",
      'Add (reason "<why this case is exempt>").',
    );
  }

  return { pattern, reason, span: item.span };
}

function readPatternList(item: ListNode, policyId: string, fieldName: string): readonly string[] {
  if (item.items.length === 0) {
    throw validationError(
      fieldName === "target" ? CODE_MISSING_TARGET : CODE_BAD_PATTERN,
      `Trace-policy "${policyId}" ${fieldName} must contain at least one pattern.`,
      item.span,
      "This field was declared without any patterns.",
      `Provide one or more quoted patterns inside (${fieldName} ...).`,
    );
  }

  const patterns: string[] = [];
  for (const child of item.items) {
    if (child.kind !== "string") {
      throw validationError(
        CODE_BAD_PATTERN,
        `Trace-policy "${policyId}" ${fieldName} values must be quoted patterns.`,
        child.span,
        `Found ${describeNode(child)} instead of a string literal.`,
        "Wrap each pattern in double quotes.",
      );
    }
    validatePatternSyntax(child.value, child.span, `Trace-policy "${policyId}" ${fieldName}`);
    patterns.push(child.value);
  }
  return patterns;
}

function readSingleStringField(node: ListNode, label: string, code: string): string {
  if (node.items.length !== 1) {
    throw validationError(
      code,
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }
  const value = node.items[0]!;
  if (value.kind !== "string") {
    throw validationError(
      code,
      `${label} must be a string literal.`,
      value.span,
      `Found ${describeNode(value)} instead of a string literal.`,
      "Wrap the value in double quotes.",
    );
  }
  return value.value;
}

/**
 * Validate a NodeId pattern string. Routes through call-graph-core's
 * `compilePattern` and additionally rejects empty / whitespace-only sources
 * and the malformed-arity / trailing-`::` shapes that `compilePattern`
 * silently treats as never-matching.
 */
function validatePatternSyntax(pattern: string, span: SourceSpan, label: string): void {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw validationError(
      CODE_BAD_PATTERN,
      `${label} pattern must be a non-empty string.`,
      span,
      "Empty or whitespace-only patterns never match any NodeId.",
      'Provide a NodeId pattern such as "**::Repository::*" or "extern:stripe::*".',
    );
  }
  if (pattern.endsWith("::")) {
    throw validationError(
      CODE_BAD_PATTERN,
      `${label} pattern has a trailing "::" separator.`,
      span,
      `Pattern "${pattern}" is missing the symbol-name segment after the final "::".`,
      "Add the symbol-name glob (e.g. \"::*\" or \"::find(2)\") after the last container.",
    );
  }
  const arityMatch = /\(([^()]*)\)\s*(?:#[0-9a-f]{8})?\s*$/.exec(pattern);
  if (arityMatch) {
    const inside = arityMatch[1] ?? "";
    if (inside !== "" && inside !== "*" && !/^\d+$/.test(inside)) {
      throw validationError(
        CODE_BAD_PATTERN,
        `${label} pattern has a malformed arity "(${inside})".`,
        span,
        `Pattern "${pattern}" must use a numeric arity, "(*)", or omit parentheses.`,
        'Use (2), (*), or no parentheses.',
      );
    }
  }
  // Exercise the canonical compiler so we share its cache and contract.
  compilePattern(pattern);
}
