import { compilePattern } from "@stele/call-graph-core";
import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { describeNode, validationError } from "./structure-error.js";
import { ensureFieldUnset } from "./structure-shared.js";
import { isFixHintActionable } from "./structure-trace-policy.js";

/**
 * Effect-system top-level declarations parsed from CDL.
 *
 * @see docs/design/phase-b/04-effect-system.md for semantics
 * @see docs/design/phase-b/06-cdl-extensions.md §4.3-§4.8 for grammar
 */

export interface EffectName {
  readonly name: string;
  readonly description?: string;
  readonly span: SourceSpan;
}

export interface EffectDeclarationsDeclaration {
  readonly kind: "effect-declarations";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly effects: readonly EffectName[];
}

export interface EffectAnnotationDeclaration {
  readonly kind: "effect-annotation";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly target: readonly string[];
  readonly annotates: readonly string[];
}

export interface EffectPolicyDeclaration {
  readonly kind: "effect-policy";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly id: string;
  readonly description?: string;
  readonly severity: "error" | "warning";
  readonly targetScope: readonly string[];
  readonly forbid: readonly string[] | undefined;
  readonly allowOnly: readonly string[] | undefined;
  readonly fixHint?: string;
}

export interface EffectSuppressionDeclaration {
  readonly kind: "effect-suppression";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly target: string;
  readonly suppresses: readonly string[];
  readonly reason: string;
  readonly severity: "warning" | "error";
}

const CODE_BAD_EFFECT_NAME = "E0350";
const CODE_MISSING_EFFECT_NAME = "E0353";
const CODE_UNKNOWN_FIELD_DECL = "E0354";
const CODE_MISSING_TARGET_ANNOTATION = "E0355";
const CODE_MISSING_ANNOTATES = "E0356";
const CODE_MISSING_REASON = "E0357";
const CODE_FORBID_AND_ALLOW = "E0358";
const CODE_UNKNOWN_FIELD = "E0359";

// E0335 (pattern syntax) and E0339 (vague fix-hint) reused from trace-policy.
const CODE_BAD_PATTERN = "E0335";
const CODE_BAD_SEVERITY = "E0336";
const CODE_FIX_HINT_VAGUE = "E0339";

const EFFECT_NAME_RE = /^[a-z][a-z0-9._-]*$/;
const EFFECT_GLOB_RE = /^[a-z][a-z0-9._*-]*$/;

const KNOWN_DECLARATIONS_FIELDS = new Set(["effect"]);
const KNOWN_EFFECT_FIELDS = new Set(["description"]);
const KNOWN_ANNOTATION_FIELDS = new Set(["target", "annotates"]);
const KNOWN_POLICY_FIELDS = new Set([
  "description",
  "severity",
  "target-scope",
  "forbid",
  "allow-only",
  "fix-hint",
]);
const KNOWN_SUPPRESSION_FIELDS = new Set([
  "target",
  "suppresses",
  "reason",
  "severity",
]);

/**
 * Parse a `(effect-declarations ...)` top-level form.
 * Throws SteleError on E0350/E0353/E0354.
 *
 * Duplicate-block-per-file and cross-block effect-name duplication are checked
 * in `uniqueness.ts`.
 */
export function parseEffectDeclarationsDeclaration(
  filePath: string,
  node: ListNode,
): EffectDeclarationsDeclaration {
  const effects: EffectName[] = [];
  const seen = new Map<string, SourceSpan>();

  for (const item of node.items) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD_DECL,
        "Effect-declarations contains an unsupported entry.",
        item.span,
        `Found ${describeNode(item)} where an (effect ...) list was expected.`,
        "Wrap each effect in an (effect <name> ...) clause.",
      );
    }

    if (!KNOWN_DECLARATIONS_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD_DECL,
        `Effect-declarations has an unknown field "${item.head}".`,
        item.span,
        "Supported entries inside effect-declarations are: (effect <name> ...).",
        "Rename or remove this entry.",
      );
    }

    const effect = parseEffectEntry(item);
    const existing = seen.get(effect.name);
    if (existing !== undefined) {
      throw validationError(
        "E0352",
        `Effect "${effect.name}" is declared more than once in this block.`,
        effect.span,
        `First declared at line ${existing.line}, column ${existing.column}.`,
        "Remove the duplicate (effect ...) entry.",
      );
    }
    seen.set(effect.name, effect.span);
    effects.push(effect);
  }

  return {
    kind: "effect-declarations",
    filePath,
    node,
    span: node.span,
    effects,
  };
}

function parseEffectEntry(item: ListNode): EffectName {
  const nameNode = item.items[0];
  if (nameNode === undefined) {
    throw validationError(
      CODE_MISSING_EFFECT_NAME,
      "Effect entry is missing the effect name.",
      item.span,
      "Each (effect ...) entry must begin with a name like db.read.",
      "Add an effect name, e.g. (effect db.read).",
    );
  }
  if (nameNode.kind !== "identifier" && nameNode.kind !== "string") {
    throw validationError(
      CODE_MISSING_EFFECT_NAME,
      "Effect name must be an identifier or string.",
      nameNode.span,
      `Found ${describeNode(nameNode)}.`,
      "Use an identifier or string literal for the effect name.",
    );
  }
  const name = nameNode.value;
  if (name.trim().length === 0) {
    throw validationError(
      CODE_MISSING_EFFECT_NAME,
      "Effect name must be non-empty.",
      nameNode.span,
      "Empty effect names cannot be referenced.",
      "Provide a non-empty effect name.",
    );
  }
  if (!EFFECT_NAME_RE.test(name)) {
    throw validationError(
      CODE_BAD_EFFECT_NAME,
      `Effect name "${name}" violates dot-notation pattern.`,
      nameNode.span,
      "Effect names must match /^[a-z][a-z0-9._-]*$/ (lowercase, dot-notation).",
      'Rename to lowercase dot-notation, e.g. "db.read".',
    );
  }

  let description: string | undefined;
  for (const child of item.items.slice(1)) {
    if (child.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD_DECL,
        `Effect "${name}" contains an unsupported entry.`,
        child.span,
        `Found ${describeNode(child)} where a (description ...) list was expected.`,
        "Wrap optional fields in (description \"...\").",
      );
    }
    if (!KNOWN_EFFECT_FIELDS.has(child.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD_DECL,
        `Effect "${name}" has an unknown field "${child.head}".`,
        child.span,
        "Supported effect fields are: description.",
        "Rename or remove this field.",
      );
    }
    if (child.head === "description") {
      ensureFieldUnset(description, "description", `Effect "${name}" description`, CODE_UNKNOWN_FIELD_DECL, child.span);
      description = readSingleStringField(child, `Effect "${name}" description`, CODE_UNKNOWN_FIELD_DECL);
    }
  }

  return { name, description, span: item.span };
}

/**
 * Parse a `(effect-annotation ...)` top-level form.
 * Throws SteleError on E0355/E0356/E0335/E0359.
 *
 * Validation that annotated effect names resolve to declared effects is a
 * cross-form check (it needs the whole contract, since declarations may live
 * in a different imported file) and runs in `uniqueness.ts`
 * (`validateEffectNameReferences`, E0350).
 */
export function parseEffectAnnotationDeclaration(
  filePath: string,
  node: ListNode,
): EffectAnnotationDeclaration {
  let target: readonly string[] | undefined;
  let annotates: readonly string[] | undefined;

  for (const item of node.items) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        "Effect-annotation contains an unsupported entry.",
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in (target ...) or (annotates ...).",
      );
    }

    if (!KNOWN_ANNOTATION_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Effect-annotation has an unknown field "${item.head}".`,
        item.span,
        "Supported effect-annotation fields are: target, annotates.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "target": {
        ensureFieldUnset(target, "target", "Effect-annotation target", CODE_UNKNOWN_FIELD, item.span);
        target = readPatternList(item, "Effect-annotation target");
        break;
      }
      case "annotates": {
        ensureFieldUnset(annotates, "annotates", "Effect-annotation annotates", CODE_UNKNOWN_FIELD, item.span);
        annotates = readEffectRefList(item, "Effect-annotation annotates");
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Effect-annotation has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (target === undefined || target.length === 0) {
    throw validationError(
      CODE_MISSING_TARGET_ANNOTATION,
      "Effect-annotation must declare a non-empty (target ...) field.",
      node.span,
      "The target field is required and must list at least one pattern.",
      'Add (target "<pattern>") with one or more NodeId patterns.',
    );
  }

  if (annotates === undefined || annotates.length === 0) {
    throw validationError(
      CODE_MISSING_ANNOTATES,
      "Effect-annotation must declare a non-empty (annotates ...) field.",
      node.span,
      "The annotates field is required and must list at least one effect.",
      "Add (annotates <effect> [<effect> ...]).",
    );
  }

  return {
    kind: "effect-annotation",
    filePath,
    node,
    span: node.span,
    target,
    annotates,
  };
}

/**
 * Parse a `(effect-policy <id> ...)` top-level form.
 * Throws SteleError on E0358/E0359/E0335/E0336/E0339.
 *
 * Duplicate-id check happens in uniqueness.ts.
 */
export function parseEffectPolicyDeclaration(
  filePath: string,
  node: ListNode,
): EffectPolicyDeclaration {
  const idNode = node.items[0];

  if (idNode === undefined || (idNode.kind !== "identifier" && idNode.kind !== "string")) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Effect-policy declarations must start with an identifier or string id.",
      node.span,
      "The first item of an effect-policy form is the policy id.",
      "Use a form like (effect-policy NO_IO_IN_UI ...).",
    );
  }

  const id = idNode.value;
  let description: string | undefined;
  let severity: "error" | "warning" | undefined;
  let targetScope: readonly string[] | undefined;
  let forbid: readonly string[] | undefined;
  let allowOnly: readonly string[] | undefined;
  let fixHint: string | undefined;
  let forbidSpan: SourceSpan | undefined;
  let allowOnlySpan: SourceSpan | undefined;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Effect-policy "${id}" contains an unsupported entry.`,
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in a supported field list.",
      );
    }

    if (!KNOWN_POLICY_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Effect-policy "${id}" has an unknown field "${item.head}".`,
        item.span,
        "Supported effect-policy fields are: description, severity, target-scope, forbid, allow-only, fix-hint.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "description": {
        ensureFieldUnset(description, "description", `Effect-policy "${id}" description`, CODE_UNKNOWN_FIELD, item.span);
        description = readSingleStringField(item, `Effect-policy "${id}" description`, CODE_UNKNOWN_FIELD);
        break;
      }
      case "severity": {
        ensureFieldUnset(severity, "severity", `Effect-policy "${id}" severity`, CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, `Effect-policy "${id}" severity`, CODE_BAD_SEVERITY);
        if (value !== "error" && value !== "warning") {
          throw validationError(
            CODE_BAD_SEVERITY,
            `Effect-policy "${id}" severity must be "error" or "warning".`,
            item.span,
            `Found "${value}".`,
            'Use (severity "error") or (severity "warning").',
          );
        }
        severity = value;
        break;
      }
      case "target-scope": {
        ensureFieldUnset(targetScope, "target-scope", `Effect-policy "${id}" target-scope`, CODE_UNKNOWN_FIELD, item.span);
        targetScope = readPatternList(item, `Effect-policy "${id}" target-scope`);
        break;
      }
      case "forbid": {
        ensureFieldUnset(forbid, "forbid", `Effect-policy "${id}" forbid`, CODE_UNKNOWN_FIELD, item.span);
        forbid = readEffectRefList(item, `Effect-policy "${id}" forbid`);
        forbidSpan = item.span;
        break;
      }
      case "allow-only": {
        ensureFieldUnset(allowOnly, "allow-only", `Effect-policy "${id}" allow-only`, CODE_UNKNOWN_FIELD, item.span);
        allowOnly = readEffectRefList(item, `Effect-policy "${id}" allow-only`, { allowEmpty: true });
        allowOnlySpan = item.span;
        break;
      }
      case "fix-hint": {
        ensureFieldUnset(fixHint, "fix-hint", `Effect-policy "${id}" fix-hint`, CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, `Effect-policy "${id}" fix-hint`, CODE_FIX_HINT_VAGUE);
        if (!isFixHintActionable(value)) {
          throw validationError(
            CODE_FIX_HINT_VAGUE,
            `Effect-policy "${id}" fix-hint is too vague to be actionable.`,
            item.span,
            'A fix-hint must reference code (e.g. `Service.fetch`) or a file:line location (e.g. "src/service.ts:42").',
            "Quote a code symbol with backticks or cite the file and line where the fix should be applied.",
          );
        }
        fixHint = value;
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Effect-policy "${id}" has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (targetScope === undefined || targetScope.length === 0) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      `Effect-policy "${id}" must declare a non-empty (target-scope ...) field.`,
      node.span,
      "The target-scope field is required.",
      'Add (target-scope "**/components/**") with one or more patterns.',
    );
  }

  if (forbid !== undefined && allowOnly !== undefined) {
    const span = forbidSpan ?? allowOnlySpan ?? node.span;
    throw validationError(
      CODE_FORBID_AND_ALLOW,
      `Effect-policy "${id}" declares both (forbid ...) and (allow-only ...).`,
      span,
      "An effect-policy must use exactly one of (forbid ...) or (allow-only ...), not both.",
      "Remove one of (forbid ...) or (allow-only ...).",
    );
  }

  if (forbid === undefined && allowOnly === undefined) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      `Effect-policy "${id}" must declare either (forbid ...) or (allow-only ...).`,
      node.span,
      "Without forbid or allow-only the policy imposes no constraint.",
      "Add (forbid <effect> ...) or (allow-only <effect> ...).",
    );
  }

  return {
    kind: "effect-policy",
    filePath,
    node,
    span: node.span,
    id,
    description,
    severity: severity ?? "error",
    targetScope,
    forbid,
    allowOnly,
    fixHint,
  };
}

/**
 * Parse a `(effect-suppression ...)` top-level form.
 * Throws SteleError on E0357/E0359.
 *
 * (reason "...") is mandatory per Round 2 D-CG-1.
 */
export function parseEffectSuppressionDeclaration(
  filePath: string,
  node: ListNode,
): EffectSuppressionDeclaration {
  let target: string | undefined;
  let suppresses: readonly string[] | undefined;
  let reason: string | undefined;
  let severity: "warning" | "error" | undefined;

  for (const item of node.items) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        "Effect-suppression contains an unsupported entry.",
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in (target ...), (suppresses ...), (reason ...), or (severity ...).",
      );
    }

    if (!KNOWN_SUPPRESSION_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Effect-suppression has an unknown field "${item.head}".`,
        item.span,
        "Supported effect-suppression fields are: target, suppresses, reason, severity.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "target": {
        ensureFieldUnset(target, "target", "Effect-suppression target", CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, "Effect-suppression target", CODE_UNKNOWN_FIELD);
        if (value.trim().length === 0) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            "Effect-suppression target must be a non-empty NodeId string.",
            item.span,
            "Empty target NodeId cannot resolve to any frame.",
            'Provide a NodeId such as "src/cache/cached-get.ts::cachedGet(1)".',
          );
        }
        target = value;
        break;
      }
      case "suppresses": {
        ensureFieldUnset(suppresses, "suppresses", "Effect-suppression suppresses", CODE_UNKNOWN_FIELD, item.span);
        suppresses = readEffectRefList(item, "Effect-suppression suppresses");
        break;
      }
      case "reason": {
        ensureFieldUnset(reason, "reason", "Effect-suppression reason", CODE_MISSING_REASON, item.span);
        const value = readSingleStringField(item, "Effect-suppression reason", CODE_MISSING_REASON);
        if (value.trim().length === 0) {
          throw validationError(
            CODE_MISSING_REASON,
            "Effect-suppression reason must be a non-empty string.",
            item.span,
            "Empty reasons defeat the audit purpose of suppression.",
            'Provide a non-empty (reason "<why this suppression is justified>").',
          );
        }
        reason = value;
        break;
      }
      case "severity": {
        ensureFieldUnset(severity, "severity", "Effect-suppression severity", CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, "Effect-suppression severity", CODE_BAD_SEVERITY);
        if (value !== "warning" && value !== "error") {
          throw validationError(
            CODE_BAD_SEVERITY,
            'Effect-suppression severity must be "warning" or "error".',
            item.span,
            `Found "${value}".`,
            'Use (severity "warning") or (severity "error").',
          );
        }
        severity = value;
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Effect-suppression has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (target === undefined) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Effect-suppression must declare a (target \"<NodeId>\") field.",
      node.span,
      "The target field is required.",
      'Add (target "src/cache/cached-get.ts::cachedGet(1)").',
    );
  }

  if (suppresses === undefined || suppresses.length === 0) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Effect-suppression must declare a non-empty (suppresses ...) field.",
      node.span,
      "The suppresses field lists which effects this suppression hides.",
      "Add (suppresses <effect> [<effect> ...]).",
    );
  }

  if (reason === undefined) {
    throw validationError(
      CODE_MISSING_REASON,
      "Effect-suppression is missing the required (reason \"...\") field.",
      node.span,
      "Every effect-suppression must include a non-empty reason for audit purposes (Round 2 D-CG-1 / MC-13).",
      'Add (reason "<why this suppression is justified>").',
    );
  }

  return {
    kind: "effect-suppression",
    filePath,
    node,
    span: node.span,
    target,
    suppresses,
    reason,
    severity: severity ?? "warning",
  };
}

// --- helpers ----------------------------------------------------------------

function readPatternList(item: ListNode, label: string): readonly string[] {
  if (item.items.length === 0) {
    throw validationError(
      CODE_BAD_PATTERN,
      `${label} must contain at least one pattern.`,
      item.span,
      "This field was declared without any patterns.",
      "Provide one or more quoted patterns.",
    );
  }

  const patterns: string[] = [];
  for (const child of item.items) {
    if (child.kind !== "string") {
      throw validationError(
        CODE_BAD_PATTERN,
        `${label} values must be quoted patterns.`,
        child.span,
        `Found ${describeNode(child)} instead of a string literal.`,
        "Wrap each pattern in double quotes.",
      );
    }
    validatePatternSyntax(child.value, child.span, label);
    patterns.push(child.value);
  }
  return patterns;
}

function readEffectRefList(
  item: ListNode,
  label: string,
  options: { allowEmpty?: boolean } = {},
): readonly string[] {
  const allowEmpty = options.allowEmpty === true;
  if (!allowEmpty && item.items.length === 0) {
    throw validationError(
      CODE_BAD_EFFECT_NAME,
      `${label} must contain at least one effect name.`,
      item.span,
      "This field was declared without any effect names.",
      "Provide one or more effect names or globs.",
    );
  }

  const refs: string[] = [];
  for (const child of item.items) {
    if (child.kind !== "identifier" && child.kind !== "string") {
      throw validationError(
        CODE_BAD_EFFECT_NAME,
        `${label} values must be identifiers or strings.`,
        child.span,
        `Found ${describeNode(child)}.`,
        "Use identifiers like db.read or strings like \"db.read\".",
      );
    }
    const value = child.value;
    if (value.trim().length === 0) {
      throw validationError(
        CODE_BAD_EFFECT_NAME,
        `${label} entries must be non-empty.`,
        child.span,
        "Empty effect names cannot resolve to any declared effect.",
        "Provide a non-empty effect name.",
      );
    }
    if (!EFFECT_GLOB_RE.test(value)) {
      throw validationError(
        CODE_BAD_EFFECT_NAME,
        `${label} entry "${value}" violates dot-notation pattern.`,
        child.span,
        "Effect references must match /^[a-z][a-z0-9._*-]*$/ (lowercase dot-notation, optional `*` glob).",
        'Use "db.read" or "payment.*".',
      );
    }
    refs.push(value);
  }
  return refs;
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
  const value = node.items[0] as AstNode;
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

function validatePatternSyntax(pattern: string, span: SourceSpan, label: string): void {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw validationError(
      CODE_BAD_PATTERN,
      `${label} pattern must be a non-empty string.`,
      span,
      "Empty or whitespace-only patterns never match any NodeId.",
      'Provide a NodeId pattern such as "**/components/**::*" or "extern:stripe::*".',
    );
  }
  if (pattern.endsWith("::")) {
    throw validationError(
      CODE_BAD_PATTERN,
      `${label} pattern has a trailing "::" separator.`,
      span,
      `Pattern "${pattern}" is missing the symbol-name segment after the final "::".`,
      "Add the symbol-name glob (e.g. \"::*\") after the last container.",
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
        "Use (2), (*), or no parentheses.",
      );
    }
  }
  compilePattern(pattern);
}
