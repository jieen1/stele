/**
 * Test fixture helpers — construct synthetic CallGraph / TypeStateDeclaration /
 * TypeStateBindingDeclaration / Contract shapes plus a stub
 * TypeStateInferenceExtractor so tests can exercise the evaluator without
 * pulling in any per-backend extractor.
 */

import type {
  CallGraphEdge,
  CallGraphNode,
  SupportedLanguage,
  TypedCallGraph,
} from "@stele/call-graph-core";
import type {
  Contract,
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
  TypeStateMapping,
  TypeStateTransition,
} from "@stele/core";

import type {
  InferTypeStatesOptions,
  InferTypeStatesResult,
  InferredStateAtCallSite,
  TypeStateInferenceExtractor,
} from "../../src/trait.js";

export function mkNode(opts: {
  id: string;
  filePath?: string;
  line?: number;
  column?: number;
  signature?: string;
}): CallGraphNode {
  return {
    id: opts.id,
    kind: "method",
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
  projectRoot?: string;
}): TypedCallGraph<"Built"> {
  return {
    schemaVersion: "1",
    language: opts.language ?? "typescript",
    generatedAt: "2026-01-01T00:00:00Z",
    projectRoot: opts.projectRoot ?? "/tmp/fixture",
    nodes: opts.nodes,
    edges: opts.edges,
    unresolvedCalls: [],
    ambiguousCalls: [],
    methodResolutionHash: "0".repeat(64),
    fileHashes: {},
  } as TypedCallGraph<"Built">;
}

export interface MkDeclOpts {
  readonly id: string;
  readonly target: string;
  readonly states: readonly string[];
  readonly initial: string;
  readonly terminal?: readonly string[];
  readonly transitions?: ReadonlyArray<{
    readonly from: readonly string[];
    readonly via: string;
    readonly to: string;
  }>;
  readonly allowedOps?: Readonly<Record<string, readonly string[]>>;
  readonly stateTypeMapping?: ReadonlyArray<{ readonly state: string; readonly target: string }>;
  readonly severity?: "error" | "warning";
  readonly fixHint?: string;
  readonly filePath?: string;
}

export function mkTypeStateDecl(opts: MkDeclOpts): TypeStateDeclaration {
  const span = { line: 1, column: 1 };
  const transitions: TypeStateTransition[] = (opts.transitions ?? []).map((t) => ({
    from: [...t.from],
    via: t.via,
    to: t.to,
    span,
  }));
  const mapping: TypeStateMapping[] = (opts.stateTypeMapping ?? []).map((m) => ({
    state: m.state,
    target: m.target,
    span,
  }));
  const allowedOps = new Map<string, readonly string[]>();
  for (const [state, ops] of Object.entries(opts.allowedOps ?? {})) {
    allowedOps.set(state, [...ops]);
  }
  return {
    kind: "type-state",
    filePath: opts.filePath ?? "contract/test.stele",
    node: {
      kind: "list",
      head: "type-state",
      items: [],
      span,
    } as unknown as TypeStateDeclaration["node"],
    span,
    id: opts.id,
    target: opts.target,
    description: undefined,
    severity: opts.severity ?? "error",
    states: [...opts.states],
    initial: opts.initial,
    terminal: [...(opts.terminal ?? [])],
    stateTypeMapping: mapping,
    transitions,
    allowedOps,
    fixHint: opts.fixHint,
  };
}

export function mkBinding(opts: {
  readonly function: string;
  readonly params: ReadonlyArray<{ readonly index: number; readonly state: string }>;
  readonly filePath?: string;
}): TypeStateBindingDeclaration {
  const span = { line: 1, column: 1 };
  return {
    kind: "type-state-binding",
    filePath: opts.filePath ?? "contract/test.stele",
    node: {
      kind: "list",
      head: "type-state-binding",
      items: [],
      span,
    } as unknown as TypeStateBindingDeclaration["node"],
    span,
    function: opts.function,
    params: opts.params.map((p) => ({ ...p, span })),
  };
}

export function mkContract(opts: {
  typeStates?: readonly TypeStateDeclaration[];
  typeStateBindings?: readonly TypeStateBindingDeclaration[];
}): Contract {
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
    tracePolicies: [],
    typeStates: opts.typeStates ?? [],
    typeStateBindings: opts.typeStateBindings ?? [],
  };
}

/**
 * Stub backend extractor. Tests provide a static list of inferences and the
 * stub returns them verbatim (the evaluator does all the matching /
 * classification). The stub records the options it was called with so tests
 * can assert the evaluator passed the expected declarations + bindings.
 */
export class StubExtractor implements TypeStateInferenceExtractor {
  readonly language = "typescript" as const;
  public lastOptions: InferTypeStatesOptions | null = null;
  public callCount = 0;

  constructor(private readonly inferences: readonly InferredStateAtCallSite[]) {}

  async inferTypeStates(options: InferTypeStatesOptions): Promise<InferTypeStatesResult> {
    this.lastOptions = options;
    this.callCount += 1;
    return { inferences: this.inferences };
  }
}

export function mkInference(opts: {
  readonly callerId: string;
  readonly line?: number;
  readonly column?: number;
  readonly receiverName?: string;
  readonly receiverParamIndex?: number;
  readonly method: string;
  readonly declarationId: string;
  readonly inferredState: string | undefined;
  readonly reason?: string;
  readonly origin?: { readonly path: string; readonly line: number; readonly column: number };
  readonly flowSteps?: readonly string[];
  readonly viaFreeFunction?: boolean;
}): InferredStateAtCallSite {
  return {
    callerId: opts.callerId,
    callSite: { line: opts.line ?? 10, column: opts.column ?? 3 },
    receiverName: opts.receiverName ?? "order",
    receiverParamIndex: opts.receiverParamIndex,
    viaFreeFunction: opts.viaFreeFunction,
    method: opts.method,
    declarationId: opts.declarationId,
    inferredState: opts.inferredState,
    inferenceReason: opts.reason,
    inferenceOrigin: opts.origin,
    flowSteps: opts.flowSteps ?? [],
  };
}
