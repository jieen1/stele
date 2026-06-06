/**
 * Test fixture helpers — construct synthetic CallGraph / Effect declarations
 * / Contract shapes plus a stub EffectAnnotationExtractor so tests can
 * exercise the evaluator without pulling in any per-backend extractor.
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
  EffectAnnotationDeclaration,
  EffectDeclarationsDeclaration,
  EffectName,
  EffectPolicyDeclaration,
  EffectSuppressionDeclaration,
} from "@stele/core";

import type {
  EffectAnnotationExtractor,
  ExtractEffectAnnotationsOptions,
  ExtractEffectAnnotationsResult,
  IgnoredAnnotation,
} from "../../src/trait.js";

const FAKE_SPAN = { line: 1, column: 1 } as const;

function fakeListNode(head: string): EffectDeclarationsDeclaration["node"] {
  return {
    kind: "list",
    head,
    items: [],
    span: FAKE_SPAN,
  } as unknown as EffectDeclarationsDeclaration["node"];
}

export function mkNode(opts: {
  id: string;
  filePath?: string;
  line?: number;
  column?: number;
  signature?: string;
  effects?: readonly string[];
}): CallGraphNode {
  return {
    id: opts.id,
    kind: "method",
    filePath: opts.filePath ?? "src/index.ts",
    span: { line: opts.line ?? 1, column: opts.column ?? 1 },
    signature: opts.signature ?? opts.id,
    isExported: false,
    isAsync: false,
    effects: opts.effects,
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

export function mkUnresolved(opts: {
  from: string;
  line?: number;
  column?: number;
  rawText?: string;
  reason?: UnresolvedCall["reason"];
}): UnresolvedCall {
  return {
    fromId: opts.from,
    callSite: { line: opts.line ?? 1, column: opts.column ?? 1 },
    rawText: opts.rawText ?? "dynamic()",
    reason: opts.reason ?? "dynamic",
  };
}

export function mkCallGraph(opts: {
  nodes: readonly CallGraphNode[];
  edges: readonly CallGraphEdge[];
  unresolvedCalls?: readonly UnresolvedCall[];
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
    unresolvedCalls: opts.unresolvedCalls ?? [],
    ambiguousCalls: [],
    methodResolutionHash: "0".repeat(64),
    fileHashes: {},
  } as TypedCallGraph<"Built">;
}

export function mkEffectDeclarations(
  names: readonly string[],
  filePath = "contract/effect.stele",
): EffectDeclarationsDeclaration {
  const effects: EffectName[] = names.map((name) => ({
    name,
    span: FAKE_SPAN,
  }));
  return {
    kind: "effect-declarations",
    filePath,
    node: fakeListNode("effect-declarations"),
    span: FAKE_SPAN,
    effects,
  };
}

export function mkEffectAnnotation(opts: {
  readonly target: readonly string[];
  readonly annotates: readonly string[];
  readonly filePath?: string;
}): EffectAnnotationDeclaration {
  return {
    kind: "effect-annotation",
    filePath: opts.filePath ?? "contract/effect.stele",
    node: fakeListNode("effect-annotation"),
    span: FAKE_SPAN,
    target: [...opts.target],
    annotates: [...opts.annotates],
  };
}

export function mkEffectPolicy(opts: {
  readonly id: string;
  readonly targetScope: readonly string[];
  readonly forbid?: readonly string[];
  readonly allowOnly?: readonly string[];
  readonly severity?: "error" | "warning";
  readonly description?: string;
  readonly fixHint?: string;
  readonly filePath?: string;
}): EffectPolicyDeclaration {
  return {
    kind: "effect-policy",
    filePath: opts.filePath ?? "contract/effect.stele",
    node: fakeListNode("effect-policy"),
    span: FAKE_SPAN,
    id: opts.id,
    description: opts.description,
    severity: opts.severity ?? "error",
    targetScope: [...opts.targetScope],
    forbid: opts.forbid === undefined ? undefined : [...opts.forbid],
    allowOnly: opts.allowOnly === undefined ? undefined : [...opts.allowOnly],
    fixHint: opts.fixHint,
  };
}

export function mkEffectSuppression(opts: {
  readonly target: string;
  readonly suppresses: readonly string[];
  readonly reason: string;
  readonly severity?: "warning" | "error";
  readonly filePath?: string;
}): EffectSuppressionDeclaration {
  return {
    kind: "effect-suppression",
    filePath: opts.filePath ?? "contract/effect.stele",
    node: fakeListNode("effect-suppression"),
    span: FAKE_SPAN,
    target: opts.target,
    suppresses: [...opts.suppresses],
    reason: opts.reason,
    severity: opts.severity ?? "warning",
  };
}

export function mkContract(opts: {
  readonly effectDeclarations?: readonly EffectDeclarationsDeclaration[];
  readonly effectAnnotations?: readonly EffectAnnotationDeclaration[];
  readonly effectPolicies?: readonly EffectPolicyDeclaration[];
  readonly effectSuppressions?: readonly EffectSuppressionDeclaration[];
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
    smartCtors: [],
    tracePolicies: [],
    typeStates: [],
    typeStateBindings: [],
    effectDeclarations: opts.effectDeclarations ?? [],
    effectAnnotations: opts.effectAnnotations ?? [],
    effectPolicies: opts.effectPolicies ?? [],
    effectSuppressions: opts.effectSuppressions ?? [],
  };
}

/**
 * Stub backend extractor. Tests provide a static `annotationsByNode` map and
 * the stub returns it verbatim. Records the options it was called with.
 */
export class StubExtractor implements EffectAnnotationExtractor {
  readonly language = "typescript" as const;
  public lastOptions: ExtractEffectAnnotationsOptions | null = null;
  public callCount = 0;

  constructor(
    private readonly annotationsByNode: ReadonlyMap<string, readonly string[]> =
      new Map<string, readonly string[]>(),
    private readonly ignoredAnnotations: readonly IgnoredAnnotation[] = [],
  ) {}

  async extractAnnotations(
    options: ExtractEffectAnnotationsOptions,
  ): Promise<ExtractEffectAnnotationsResult> {
    this.lastOptions = options;
    this.callCount += 1;
    return {
      annotationsByNode: this.annotationsByNode,
      ignoredAnnotations: this.ignoredAnnotations,
    };
  }
}
