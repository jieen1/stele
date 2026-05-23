/**
 * Fix-hint template substitution. Per Round 2 E-P0-2, fix-hints in CDL must
 * contain a backtick code snippet OR a file:line reference; validator E0339
 * enforces this. This module substitutes `{...}` placeholders with the
 * runtime context (call site, target name, predecessor name, ...) so the
 * emitted Violation.fix.summary reads like:
 *
 *   Insert `await permission.verify(orderId, "payment")` before
 *   `stripe.charges.create(...)` in src/controllers/order.ts:42
 *
 * Unknown placeholders are kept verbatim and logged once via the optional
 * warning sink (default: `console.warn`).
 */

import type { TraceViolationKind } from "./types.js";

export interface FixHintContext {
  readonly predecessor?: string;
  readonly successor?: string;
  readonly targetCall?: string;
  readonly receiverArg?: string;
  readonly actualFile?: string;
  readonly actualLine?: number;
  readonly actualColumn?: number;
  readonly missingMethod?: string;
  readonly forbiddenNode?: string;
}

const PLACEHOLDER_REGEX = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

interface SubstitutionEnv {
  readonly warned: Set<string>;
  readonly warn: (placeholder: string) => void;
}

function defaultWarn(placeholder: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[trace-evaluator] unknown fix-hint placeholder: {${placeholder}}`);
}

function placeholderValue(
  name: string,
  context: FixHintContext,
): string | undefined {
  switch (name) {
    case "predecessor":
      return context.predecessor;
    case "successor":
      return context.successor;
    case "target_call":
    case "targetCall":
      return context.targetCall;
    case "receiver_arg":
    case "receiverArg":
      return context.receiverArg;
    case "actual_file":
    case "actualFile":
      return context.actualFile;
    case "actual_line":
    case "actualLine":
      return context.actualLine === undefined
        ? undefined
        : String(context.actualLine);
    case "actual_column":
    case "actualColumn":
      return context.actualColumn === undefined
        ? undefined
        : String(context.actualColumn);
    case "missing_method":
    case "missingMethod":
      return context.missingMethod;
    case "forbidden_node":
    case "forbiddenNode":
      return context.forbiddenNode;
    default:
      return undefined;
  }
}

/**
 * Substitute placeholders in `template`. Backticks are preserved verbatim.
 * Unknown placeholders are kept literally and warned about once per template
 * invocation.
 */
export function substituteFixHint(
  template: string,
  context: FixHintContext,
  warn: (placeholder: string) => void = defaultWarn,
): string {
  if (typeof template !== "string" || template.length === 0) {
    return template;
  }
  const env: SubstitutionEnv = { warned: new Set(), warn };
  return template.replace(PLACEHOLDER_REGEX, (match, raw: string) => {
    const value = placeholderValue(raw, context);
    if (value !== undefined) {
      return value;
    }
    if (!env.warned.has(raw)) {
      env.warned.add(raw);
      env.warn(raw);
    }
    return match;
  });
}

/**
 * Generate a default fix-hint when policy.fixHint is undefined.
 *
 * The hint forces the agent into an analysis branch BEFORE choosing an action:
 *   [A] Code issue → apply the suggested code change
 *   [B] Contract issue → investigate, document rationale, submit propose; do NOT
 *       edit the contract directly
 *
 * Rationale: a naked "Insert X before Y" hint pre-decides the answer is code-side
 * and lets the agent fix the symptom even when the rule itself is wrong/stale.
 * Forcing the A/B branch makes the agent think before acting; combined with the
 * protected-files glob + propose flow, contract changes can only happen through
 * a documented, user-approved path.
 *
 * The hint always contains a backtick snippet AND a file:line reference (passing
 * E0339 actionable check) AND the three keywords `code issue`, `contract issue`,
 * `propose` (asserted by FIX_HINT_REQUIRES_ANALYSIS_BRANCH self-protection
 * invariant).
 */
export function defaultFixHint(
  kind: TraceViolationKind,
  context: FixHintContext,
  policyId?: string,
): string {
  const fileLine =
    context.actualFile !== undefined && context.actualLine !== undefined
      ? `${context.actualFile}:${context.actualLine}`
      : context.actualFile ?? "<unknown>";
  const target = context.targetCall ?? "<target>";
  const codeBranch = codeIssueAdvice(kind, context, target, fileLine);
  const ruleRef = policyId ?? "<rule-id>";
  return [
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    `[A] Code issue — the rule is correct, the code at ${fileLine} is wrong:`,
    `    ${codeBranch}`,
    ``,
    `[B] Contract issue — the rule itself is wrong, outdated, or no longer applicable:`,
    `    1. Do NOT edit the contract directly — protected files reject agent edits.`,
    `    2. Investigate: read related code, run \`git log\` on the rule's source, run \`stele why ${ruleRef}\` for context.`,
    `    3. Document: write a rationale containing (a) scenarios researched, (b) evidence the rule no longer applies, (c) alternatives considered, (d) impact analysis (which other rules / files affected).`,
    `    4. Submit a YAML proposal at \`contract/design/proposals/<id>.yaml\` containing the kind (\`trace-policy\`), the rule id (\`${ruleRef}\`), and the rationale from step 3. Run \`stele design propose\` to validate it (use \`invariant\` / \`branded-id\` / \`aggregate\` as the closest existing built-in type — trace-policy-specific propose subcommand is a planned follow-up). Then ask the user to review the proposal.`,
    `    5. Wait for explicit user approval before any contract change.`,
    ``,
    `Choose [A] or [B] before acting. Default-suggestion in [A] is ONLY valid if you've confirmed it's a code issue, not a contract issue.`,
  ].join("\n");
}

function codeIssueAdvice(
  kind: TraceViolationKind,
  context: FixHintContext,
  target: string,
  fileLine: string,
): string {
  switch (kind) {
    case "missing_transit":
      return `Route the call to \`${target}\` through the required transit layer before reaching it at ${fileLine}.`;
    case "missing_predecessor": {
      const pred = context.predecessor ?? "<predecessor>";
      return `Insert \`${pred}(...)\` before \`${target}\` in ${fileLine}.`;
    }
    case "missing_successor": {
      const succ = context.successor ?? "<successor>";
      return `Insert \`${succ}(...)\` after \`${target}\` in ${fileLine}.`;
    }
    case "direct_call_denied":
      return `Stop calling \`${target}\` directly from ${fileLine}; introduce an intermediate layer.`;
    case "forbidden_transit": {
      const forbidden = context.forbiddenNode ?? "<forbidden>";
      return `Remove \`${forbidden}\` from the path to \`${target}\` at ${fileLine}.`;
    }
    case "path_exceeded_max_depth":
      return `Call chain to \`${target}\` exceeds the analyzer depth cap; shorten the chain or run \`stele check --trace-max-depth N\` (see ${fileLine}).`;
    default: {
      const exhaustive: never = kind;
      return `Trace constraint violated at ${fileLine}. (${String(exhaustive)})`;
    }
  }
}
