/**
 * Test fixture helpers — construct synthetic CallGraph + TracePolicyDeclaration
 * shapes that exercise the evaluator without depending on backend extractors.
 */

import type {
  CallGraphEdge,
  CallGraphNode,
  SupportedLanguage,
  TypedCallGraph,
  UnresolvedCall,
} from "@stele/call-graph-core";
import type {
  Contract,
  TracePolicyDeclaration,
} from "@stele/core";

export interface MiniNode {
  readonly id: string;
  readonly filePath?: string;
}

export interface MiniEdge {
  readonly from: string;
  readonly to: string;
  readonly line?: number;
  readonly column?: number;
}

export function mkNode(opts: {
  id: string;
  filePath?: string;
  line?: number;
  column?: number;
  signature?: string;
}): CallGraphNode {
  return {
    id: opts.id,
    kind: "function",
    filePath: opts.filePath ?? "src/index.ts",
    span: { line: opts.line ?? 1, column: opts.column ?? 1 },
    signature: opts.signature ?? opts.id,
    isExported: false,
    isAsync: false,
  };
}

export function mkEdge(opts: {
  from: string;
  to: string;
  line?: number;
  column?: number;
}): CallGraphEdge {
  return {
    fromId: opts.from,
    toId: opts.to,
    callSite: { line: opts.line ?? 1, column: opts.column ?? 1 },
    isConditional: false,
    isLoop: false,
    isAsync: false,
  };
}

export function mkCallGraph(opts: {
  nodes: readonly CallGraphNode[];
  edges: readonly CallGraphEdge[];
  language?: SupportedLanguage;
  unresolvedCalls?: readonly UnresolvedCall[];
}): TypedCallGraph<"Built"> {
  return {
    schemaVersion: "1",
    language: opts.language ?? "typescript",
    generatedAt: "2026-01-01T00:00:00Z",
    projectRoot: "/tmp/fixture",
    nodes: opts.nodes,
    edges: opts.edges,
    unresolvedCalls: opts.unresolvedCalls ?? [],
    ambiguousCalls: [],
    methodResolutionHash: "0".repeat(64),
    fileHashes: {},
  } as TypedCallGraph<"Built">;
}

export function mkUnresolved(opts: {
  from: string;
  line?: number;
  column?: number;
  rawText?: string;
  reason?: UnresolvedCall["reason"];
  /** Defaults to `true` — the helper models a name-hidden computed-member
   * dispatch (`obj[m]()`), the shape that triggers the fail-closed gate. Pass
   * `false` to model a name-visible indirect call (e.g. `predicate()`) that
   * must NOT trigger the gate. */
  nameHidden?: boolean;
}): UnresolvedCall {
  return {
    fromId: opts.from,
    callSite: { line: opts.line ?? 1, column: opts.column ?? 1 },
    rawText: opts.rawText ?? "obj[m]()",
    reason: opts.reason ?? "dynamic",
    nameHidden: opts.nameHidden ?? true,
  };
}

export function mkPolicy(opts: {
  id: string;
  target: readonly string[];
  mustTransit?: readonly string[];
  mustBePrecededBy?: readonly string[];
  mustBeFollowedBy?: readonly string[];
  denyDirect?: readonly string[];
  denyTransit?: readonly string[];
  scope?: readonly string[];
  exempt?: readonly { pattern: string; reason: string }[];
  fixHint?: string;
  severity?: "error" | "warning";
  description?: string;
}): TracePolicyDeclaration {
  return {
    kind: "trace-policy",
    filePath: "contract/test.stele",
    node: {
      kind: "list",
      head: "trace-policy",
      items: [],
      span: { line: 1, column: 1 },
    } as unknown as TracePolicyDeclaration["node"],
    span: { line: 1, column: 1 },
    id: opts.id,
    description: opts.description,
    severity: opts.severity ?? "error",
    target: opts.target,
    mustTransit: opts.mustTransit ?? [],
    mustBePrecededBy: opts.mustBePrecededBy ?? [],
    mustBeFollowedBy: opts.mustBeFollowedBy ?? [],
    denyDirect: opts.denyDirect ?? [],
    denyTransit: opts.denyTransit ?? [],
    scope: opts.scope ?? [],
    exempt: (opts.exempt ?? []).map((e) => ({
      pattern: e.pattern,
      reason: e.reason,
      span: { line: 1, column: 1 },
    })),
    fixHint: opts.fixHint,
  };
}

export function mkContract(policies: readonly TracePolicyDeclaration[]): Contract {
  return {
    rootPath: "/tmp/fixture",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    architectures: [],
    coreNodes: [],
    brandedIds: [],
    smartCtors: [],
    tracePolicies: policies,
  };
}
