/**
 * Compose `Violation` records for type-state findings. Single place that
 * materialises the `typestate.<id>.<kind>` rule_id, the `group_id` (caller
 * NodeId), the deterministic fingerprint, and the `inference_source` rendering
 * required by Round 2 E-P1-1.
 *
 * The `Violation` schema (`@stele/core`) doesn't have a dedicated
 * `inference_source` field, so we render it into `cause.detail` as a
 * deterministic, line-oriented blob. Consumers that want structured access
 * read the underlying `InferenceSource` from this module before calling
 * `buildDisallowedOpViolation`; the rendered form is the on-wire
 * representation.
 */

import {
  type TypeStateDeclaration,
  type Violation,
  type ViolationPriority,
  type ViolationSeverity,
  createViolation,
} from "@stele/core";
import type { CallGraph, CallGraphNode } from "@stele/call-graph-core";

import {
  defaultDisallowedOpFixHint,
  defaultInferenceFailedFixHint,
} from "./fix-hint.js";
import type { InferenceSource, TypeStateViolationKind } from "./types.js";

/** Default `priority` for each type-state violation kind. */
export function defaultPriority(kind: TypeStateViolationKind): ViolationPriority {
  switch (kind) {
    case "disallowed_op":
      // Design-time violation — Round 2 priority rule: blocking.
      return "blocking";
    case "inference_failed":
      // strictMode=true escalates this to error severity; even then, the
      // agent can address it incrementally, so we keep priority=major.
      return "major";
    default: {
      const exhaustive: never = kind;
      throw new Error(`defaultPriority: unreachable kind ${String(exhaustive)}`);
    }
  }
}

export interface BuildDisallowedOpOptions {
  readonly decl: TypeStateDeclaration;
  readonly callerId: string;
  readonly callSite: { readonly path: string; readonly line: number; readonly column: number };
  readonly method: string;
  readonly inferredState: string;
  readonly inferenceSource: InferenceSource;
  readonly callGraph: CallGraph;
  readonly receiverName?: string;
  /** Optional CDL-supplied fix-hint override. */
  readonly fixHintOverride?: string;
}

export interface BuildInferenceFailedOptions {
  readonly decl: TypeStateDeclaration;
  readonly callerId: string;
  readonly callSite: { readonly path: string; readonly line: number; readonly column: number };
  readonly method: string;
  readonly callGraph: CallGraph;
  readonly receiverName?: string;
  /** When true, severity is `error` (strict mode). Otherwise `warning`. */
  readonly strictMode: boolean;
  readonly fixHintOverride?: string;
}

function findNode(callGraph: CallGraph, id: string): CallGraphNode | undefined {
  for (const n of callGraph.nodes) {
    if (n.id === id) {
      return n;
    }
  }
  return undefined;
}

function severityForDisallowed(decl: TypeStateDeclaration): ViolationSeverity {
  return decl.severity;
}

function renderInferenceSource(src: InferenceSource): string {
  const lines: string[] = ["inference_source:"];
  if (src.origin !== undefined) {
    lines.push(`  origin: ${src.origin.path}:${src.origin.line}:${src.origin.column}`);
  }
  if (src.reason !== undefined && src.reason.length > 0) {
    lines.push(`  reason: ${src.reason}`);
  }
  if (src.flowSteps.length > 0) {
    lines.push("  flow_steps:");
    for (const step of src.flowSteps) {
      lines.push(`    - ${step}`);
    }
  }
  return lines.join("\n");
}

function scopePathsFor(callGraph: CallGraph, callerId: string, callSitePath: string): string[] {
  const node = findNode(callGraph, callerId);
  const out: string[] = [];
  if (node !== undefined && node.filePath.length > 0) {
    out.push(node.filePath);
  }
  if (callSitePath.length > 0 && !out.includes(callSitePath)) {
    out.push(callSitePath);
  }
  return out;
}

/**
 * Build a `typestate.<id>.disallowed_op` violation. Always priority=blocking
 * (Round 2 design-time rule). The `inference_source` is rendered into
 * `cause.detail` (Round 2 E-P1-1).
 */
export function buildDisallowedOpViolation(options: BuildDisallowedOpOptions): Violation {
  const {
    decl,
    callerId,
    callSite,
    method,
    inferredState,
    inferenceSource,
    callGraph,
    receiverName,
    fixHintOverride,
  } = options;

  const ruleId = `typestate.${decl.id}.disallowed_op`;
  const receiverLabel = receiverName ?? "<receiver>";
  const summary = `Method \`${method}\` is not allowed when \`${receiverLabel}\` is in state \`${inferredState}\` (rule ${decl.id}).`;

  const fixSummary = fixHintOverride ?? decl.fixHint ?? defaultDisallowedOpFixHint(
    decl,
    inferredState,
    method,
    callSite.path,
    callSite.line,
  );

  const detailParts: string[] = [
    `inferred_state: ${inferredState}`,
    `receiver: ${receiverLabel}`,
    renderInferenceSource(inferenceSource),
  ];
  const allowed = decl.allowedOps.get(inferredState);
  if (allowed !== undefined && allowed.length > 0) {
    detailParts.push(`allowed_methods_in_state: [${allowed.join(", ")}]`);
  }

  return createViolation({
    rule_id: ruleId,
    rule_kind: "type_state_violation",
    severity: severityForDisallowed(decl),
    source: {
      tool: "stele",
      command: "check",
      kind: "type-state",
    },
    location: {
      path: callSite.path,
      line: callSite.line,
      column: callSite.column,
    },
    cause: {
      summary,
      detail: detailParts.join("\n"),
    },
    scope_paths: scopePathsFor(callGraph, callerId, callSite.path),
    fix: {
      summary: fixSummary,
    },
    priority: defaultPriority("disallowed_op"),
    group_id: callerId,
  });
}

/**
 * Build a `typestate.<id>.inference_failed` violation. `strictMode=true`
 * emits severity `error`; otherwise `warning` (acts as a notice). Default
 * priority=major.
 */
export function buildInferenceFailedViolation(options: BuildInferenceFailedOptions): Violation {
  const {
    decl,
    callerId,
    callSite,
    method,
    callGraph,
    receiverName,
    strictMode,
    fixHintOverride,
  } = options;

  const ruleId = `typestate.${decl.id}.inference_failed`;
  const receiverLabel = receiverName ?? "<receiver>";
  const summary = `Type-state inference failed for \`${receiverLabel}.${method}\` against rule \`${decl.id}\`.`;

  const fixSummary = fixHintOverride ?? defaultInferenceFailedFixHint(decl, callerId);

  return createViolation({
    rule_id: ruleId,
    rule_kind: "type_state_violation",
    severity: strictMode ? "error" : "warning",
    source: {
      tool: "stele",
      command: "check",
      kind: "type-state",
    },
    location: {
      path: callSite.path,
      line: callSite.line,
      column: callSite.column,
    },
    cause: {
      summary,
      detail: `caller: ${callerId}\nmethod: ${method}\nreceiver: ${receiverLabel}`,
    },
    scope_paths: scopePathsFor(callGraph, callerId, callSite.path),
    fix: {
      summary: fixSummary,
    },
    priority: defaultPriority("inference_failed"),
    group_id: callerId,
  });
}
