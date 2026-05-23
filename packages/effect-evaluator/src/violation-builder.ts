/**
 * Compose `Violation` records for effect findings. Single place that
 * materialises:
 *
 *   - rule_id `effect.<policy_id>.<kind>` (or `effect.unresolved_call_blocks_evaluation`)
 *   - rule_kind `effect_violation`
 *   - severity from the policy (default "error")
 *   - priority (Round 2 default mapping)
 *   - group_id = caller / offending NodeId
 *   - cause.detail rendering of direct/inherited/propagation fields
 *     (Round 2 E-P0-3)
 *   - propagation_chain rendering
 *   - fingerprint via createViolation
 */

import {
  type EffectPolicyDeclaration,
  type Violation,
  type ViolationPriority,
  type ViolationSeverity,
  createViolation,
} from "@stele/core";
import type { CallGraph, CallGraphNode, UnresolvedCall } from "@stele/call-graph-core";

import {
  defaultDisallowedEffectFixHint,
  defaultForbiddenEffectFixHint,
  defaultUnresolvedCallFixHint,
} from "./fix-hint.js";
import type { EffectViolationKind, PropagationEvidence } from "./types.js";

/** Default `priority` for each effect violation kind. */
export function defaultPriority(kind: EffectViolationKind): ViolationPriority {
  switch (kind) {
    case "forbidden_effect":
      // Design-time violation — Round 2 priority rule: blocking for forbids
      // because a forbidden effect in a strict scope usually points at a
      // boundary violation that must be fixed before continuing.
      return "blocking";
    case "disallowed_effect":
      // allow-only violations are also blocking — the policy declares a
      // hard ceiling on the allowed effect set.
      return "blocking";
    case "unresolved_call_blocks_evaluation":
      // D-CG-5 fail-closed: the agent should treat this as major-priority,
      // not blocking, because the resolution requires either a refactor or
      // a contract addition. We surface it but allow the agent to plan.
      return "major";
    default: {
      const exhaustive: never = kind;
      throw new Error(`defaultPriority: unreachable kind ${String(exhaustive)}`);
    }
  }
}

function findNode(callGraph: CallGraph, id: string): CallGraphNode | undefined {
  for (const n of callGraph.nodes) {
    if (n.id === id) {
      return n;
    }
  }
  return undefined;
}

function renderEvidence(evidence: PropagationEvidence): string {
  const lines: string[] = [];
  lines.push(`offending_effect: ${evidence.offendingEffect}`);
  lines.push(`direct_effects_on_node: [${[...evidence.directEffectsOnNode].sort().join(", ")}]`);
  lines.push(`inherited_effects: [${[...evidence.inheritedEffects].sort().join(", ")}]`);
  lines.push(`propagation_root_nodes: [${[...evidence.propagationRootNodes].sort().join(", ")}]`);
  if (evidence.propagationChain.length > 0) {
    lines.push(`propagation_chain:`);
    let indent = "  ";
    for (let i = 0; i < evidence.propagationChain.length; i += 1) {
      const id = evidence.propagationChain[i];
      const suffix =
        i === evidence.propagationChain.length - 1
          ? ` [declares: ${evidence.offendingEffect}]`
          : "";
      lines.push(`${indent}→ ${id}${suffix}`);
      indent += "  ";
    }
  }
  return lines.join("\n");
}

function scopePathsFor(callGraph: CallGraph, nodeId: string): string[] {
  const node = findNode(callGraph, nodeId);
  if (node === undefined || node.filePath.length === 0) {
    return [];
  }
  return [node.filePath];
}

function severityFromPolicy(
  policy: EffectPolicyDeclaration | undefined,
): ViolationSeverity {
  if (policy === undefined) {
    return "error";
  }
  return policy.severity;
}

export interface BuildForbiddenEffectOptions {
  readonly policy: EffectPolicyDeclaration;
  readonly node: CallGraphNode;
  readonly evidence: PropagationEvidence;
  readonly callGraph: CallGraph;
  readonly fixHintOverride?: string;
  readonly directOnNode: boolean;
}

/**
 * Build a `effect.<policy>.forbidden_effect` violation.
 */
export function buildForbiddenEffectViolation(
  options: BuildForbiddenEffectOptions,
): Violation {
  const {
    policy,
    node,
    evidence,
    callGraph,
    fixHintOverride,
    directOnNode,
  } = options;

  const ruleId = `effect.${policy.id}.forbidden_effect`;
  const callerFile = node.filePath;
  const callerLine = node.span.line;

  const summary =
    `Function \`${node.id}\` has forbidden effect \`${evidence.offendingEffect}\` ` +
    `under policy \`${policy.id}\`.`;

  const fixSummary =
    fixHintOverride ??
    policy.fixHint ??
    defaultForbiddenEffectFixHint(
      policy,
      node.id,
      evidence.offendingEffect,
      directOnNode,
      evidence.propagationRootNodes[0],
      callerFile,
      callerLine,
    );

  return createViolation({
    rule_id: ruleId,
    rule_kind: "effect_violation",
    severity: severityFromPolicy(policy),
    source: {
      tool: "stele",
      command: "check",
      kind: "effect",
    },
    location: {
      path: callerFile,
      line: callerLine,
      column: node.span.column,
    },
    cause: {
      summary,
      detail: renderEvidence(evidence),
    },
    scope_paths: scopePathsFor(callGraph, node.id),
    fix: {
      summary: fixSummary,
    },
    priority: defaultPriority("forbidden_effect"),
    group_id: node.id,
  });
}

export interface BuildDisallowedEffectOptions {
  readonly policy: EffectPolicyDeclaration;
  readonly node: CallGraphNode;
  readonly evidence: PropagationEvidence;
  readonly callGraph: CallGraph;
  readonly allowOnly: readonly string[];
  readonly fixHintOverride?: string;
  readonly directOnNode: boolean;
}

/**
 * Build a `effect.<policy>.disallowed_effect` violation (allow-only failure).
 */
export function buildDisallowedEffectViolation(
  options: BuildDisallowedEffectOptions,
): Violation {
  const {
    policy,
    node,
    evidence,
    callGraph,
    allowOnly,
    fixHintOverride,
    directOnNode,
  } = options;

  const ruleId = `effect.${policy.id}.disallowed_effect`;
  const callerFile = node.filePath;
  const callerLine = node.span.line;

  const allowList = [...allowOnly].sort((a, b) => a.localeCompare(b));
  const allowRendered = allowList.length === 0 ? "<none>" : `[${allowList.join(", ")}]`;

  const summary =
    `Function \`${node.id}\` has effect \`${evidence.offendingEffect}\` not in allow-only ` +
    `${allowRendered} under policy \`${policy.id}\`.`;

  const fixSummary =
    fixHintOverride ??
    policy.fixHint ??
    defaultDisallowedEffectFixHint(
      policy,
      node.id,
      evidence.offendingEffect,
      allowList,
      directOnNode,
      evidence.propagationRootNodes[0],
      callerFile,
      callerLine,
    );

  return createViolation({
    rule_id: ruleId,
    rule_kind: "effect_violation",
    severity: severityFromPolicy(policy),
    source: {
      tool: "stele",
      command: "check",
      kind: "effect",
    },
    location: {
      path: callerFile,
      line: callerLine,
      column: node.span.column,
    },
    cause: {
      summary,
      detail: [
        renderEvidence(evidence),
        `allow_only: ${allowRendered}`,
      ].join("\n"),
    },
    scope_paths: scopePathsFor(callGraph, node.id),
    fix: {
      summary: fixSummary,
    },
    priority: defaultPriority("disallowed_effect"),
    group_id: node.id,
  });
}

export interface BuildUnresolvedCallOptions {
  /** Optional — when the unresolved-call also has a known policy in scope. */
  readonly policy: EffectPolicyDeclaration | undefined;
  readonly node: CallGraphNode;
  readonly unresolved: UnresolvedCall;
  readonly callGraph: CallGraph;
  readonly strictMode: boolean;
  readonly fixHintOverride?: string;
}

/**
 * Build the Round 2 D-CG-5 fail-closed violation
 * `effect.unresolved_call_blocks_evaluation`. Severity follows strictMode:
 * `error` when true, `warning` (notice) when false.
 */
export function buildUnresolvedCallViolation(
  options: BuildUnresolvedCallOptions,
): Violation {
  const { policy, node, unresolved, callGraph, strictMode, fixHintOverride } = options;
  const ruleId = "effect.unresolved_call_blocks_evaluation";
  const callerFile = node.filePath;
  const callerLine = unresolved.callSite.line;

  const summary =
    `Cannot determine effects of \`${node.id}\` — unresolved call at ` +
    `${callerFile}:${callerLine} (${unresolved.reason}). Fail-closed per Round 2 D-CG-5.`;

  const fixSummary =
    fixHintOverride ??
    policy?.fixHint ??
    defaultUnresolvedCallFixHint(policy, node.id, callerFile, callerLine);

  return createViolation({
    rule_id: ruleId,
    rule_kind: "effect_violation",
    severity: strictMode ? "error" : "warning",
    source: {
      tool: "stele",
      command: "check",
      kind: "effect",
    },
    location: {
      path: callerFile,
      line: callerLine,
      column: unresolved.callSite.column,
    },
    cause: {
      summary,
      detail: [
        `node: ${node.id}`,
        `unresolved_call: ${unresolved.rawText}`,
        `reason: ${unresolved.reason}`,
        policy === undefined ? `policy: <none>` : `policy: ${policy.id}`,
        `mode: ${strictMode ? "strict (fail-closed)" : "lenient"}`,
      ].join("\n"),
    },
    scope_paths: scopePathsFor(callGraph, node.id),
    fix: {
      summary: fixSummary,
    },
    priority: defaultPriority("unresolved_call_blocks_evaluation"),
    group_id: node.id,
  });
}
