import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
  SupportedLanguage,
} from "@stele/call-graph-core";
import type {
  Contract,
  EffectPolicyDeclaration,
  Violation,
} from "@stele/core";
import type {
  EffectAnnotationExtractor,
  EvaluateEffectOptions,
  EvaluateEffectResult,
} from "@stele/effect-evaluator";

type EvaluateFn = (
  options: EvaluateEffectOptions,
) => Promise<EvaluateEffectResult>;

import { buildEffectStage } from "../src/commands/check-stages-effect.js";
import { _clearCallGraphCacheForTests } from "../src/commands/check-stages-call-graph-cache.js";
import type {
  PreparedCheckContext,
  ProtectedCheckState,
} from "../src/architecture/types.js";

// ---------------------------------------------------------------------------
// Synthetic CallGraph + Contract helpers
// ---------------------------------------------------------------------------

function mkNode(opts: { id: string; filePath?: string }): CallGraphNode {
  return {
    id: opts.id,
    kind: "function",
    filePath: opts.filePath ?? "src/index.ts",
    span: { line: 1, column: 1 },
    signature: opts.id,
    isExported: false,
    isAsync: false,
  };
}

function mkEdge(opts: {
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

function mkCallGraph(opts: {
  nodes?: readonly CallGraphNode[];
  edges?: readonly CallGraphEdge[];
  language?: SupportedLanguage;
}): CallGraph {
  return {
    schemaVersion: "1",
    language: opts.language ?? "typescript",
    generatedAt: "2026-01-01T00:00:00Z",
    projectRoot: "/tmp/fixture",
    nodes: opts.nodes ?? [],
    edges: opts.edges ?? [],
    unresolvedCalls: [],
    ambiguousCalls: [],
    methodResolutionHash: "0".repeat(64),
    fileHashes: {},
  };
}

function mkEffectPolicy(opts: {
  id: string;
  targetScope?: readonly string[];
  forbid?: readonly string[];
  allowOnly?: readonly string[];
}): EffectPolicyDeclaration {
  return {
    kind: "effect-policy",
    filePath: "contract/test.stele",
    node: {
      kind: "list",
      head: "effect-policy",
      items: [],
      span: { file: "contract/test.stele", line: 1, column: 1 },
    } as unknown as EffectPolicyDeclaration["node"],
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id: opts.id,
    description: undefined,
    severity: "error",
    targetScope: opts.targetScope ?? ["src/**::*"],
    forbid: opts.forbid,
    allowOnly: opts.allowOnly,
    fixHint: undefined,
  };
}

function mkContract(
  effectPolicies: readonly EffectPolicyDeclaration[],
): Contract {
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
    effectDeclarations: [],
    effectAnnotations: [],
    effectPolicies,
    effectSuppressions: [],
    externAliases: [],
  } as unknown as Contract;
}

function mkContext(opts: {
  contract: Contract;
  targetLanguage?: string;
  projectDir?: string;
}): PreparedCheckContext {
  return {
    projectDir: opts.projectDir ?? "/tmp/stele-effect-test",
    config: {
      targetLanguage: opts.targetLanguage ?? "typescript",
    } as unknown as PreparedCheckContext["config"],
    contract: opts.contract,
    generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
    invariantCount: 0,
  };
}

function mkViolation(
  over: Partial<Violation> & Pick<Violation, "rule_id">,
): Violation {
  return {
    rule_id: over.rule_id,
    rule_kind: over.rule_kind ?? "forbidden_effect",
    severity: over.severity ?? "error",
    source: over.source ?? { tool: "stele", command: "check", kind: "rule" },
    location: over.location ?? { path: "src/x.ts", line: 1, column: 1 },
    cause: over.cause ?? { summary: "synthetic" },
    fingerprint: over.fingerprint ?? "fp-synth",
    scope_paths: over.scope_paths ?? ["src/x.ts"],
    status: over.status ?? "active",
  } as Violation;
}

const PROTECTED_STATE: ProtectedCheckState = {
  protectedPaths: [],
  contractHash: "0".repeat(64),
  summary: {
    invariantCount: 28,
    generatedFileCount: 0,
    protectedFileCount: 0,
  },
};

// Stub extractor — the stage delegates extraction to the evaluator dep when
// provided, so this is only present to satisfy the default-path type.
const STUB_EXTRACTOR: EffectAnnotationExtractor = {
  language: "typescript",
  async extractAnnotations() {
    return { annotationsByNode: new Map() };
  },
};

function okResult(): EvaluateEffectResult {
  return {
    violations: Object.freeze([]),
    notices: Object.freeze([]),
    stats: {
      policiesEvaluated: 0,
      nodesAnalyzed: 0,
      unresolvedFailures: 0,
      propagationRounds: 0,
      suppressionsActive: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildEffectStage — empty contract", () => {
  it("returns ok with zero violations when no effect-policy declarations exist", async () => {
    const context = mkContext({ contract: mkContract([]) });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.summary.violation_count).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("buildEffectStage — non-typescript target language", () => {
  it("routes python projects through the Python CallGraph + effect extractors (Round 14 P0)", async () => {
    // Round 14 P0: Python is now a supported Phase B target for the
    // effect stage. The extractor + evaluator should actually run
    // (test stubs them out) instead of fail-louding.
    const policy = mkEffectPolicy({ id: "NO_IO" });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const ruleIds = report.violations.map((v) => v.rule_id);
    expect(ruleIds).not.toContain("effect.not-yet-supported.python");
  });

  it("fails loud for rust (Round 4 F-A-02)", async () => {
    const policy = mkEffectPolicy({ id: "NO_NET" });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "rust",
    });

    const report = await buildEffectStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(report.violations[0]!.rule_id).toBe(
      "effect.not-yet-supported.rust",
    );
    expect(report.violations[0]!.severity).toBe("error");
  });
});

describe("buildEffectStage — missing tsconfig", () => {
  it("returns ok with effect.no-tsconfig warning when tsconfig is absent", async () => {
    const policy = mkEffectPolicy({ id: "NO_IO" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: "/tmp/stele-effect-test-does-not-exist-xyz",
    });

    const report = await buildEffectStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("effect.no-tsconfig");
    expect(report.violations[0]!.severity).toBe("warning");
  });
});

describe("buildEffectStage — successful evaluation", () => {
  it("surfaces evaluator violations and flips ok=false", async () => {
    const policy = mkEffectPolicy({ id: "NO_IO", forbid: ["io"] });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const violation: Violation = mkViolation({
      rule_id: "effect.NO_IO.forbidden",
      severity: "error",
    });
    const evaluate = vi.fn(
      async (): Promise<EvaluateEffectResult> => ({
        violations: Object.freeze([violation]),
        notices: Object.freeze([]),
        stats: {
          policiesEvaluated: 1,
          nodesAnalyzed: 1,
          unresolvedFailures: 0,
          propagationRounds: 1,
          suppressionsActive: 0,
        },
      }),
    );
    const extract = vi.fn(async () => mkCallGraph({}));

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("effect.NO_IO.forbidden");
    expect(report.summary.violation_count).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    _clearCallGraphCacheForTests(context);
  });

  it("surfaces multiple violations across policies", async () => {
    const p1 = mkEffectPolicy({ id: "NO_IO", forbid: ["io"] });
    const p2 = mkEffectPolicy({
      id: "NO_NET",
      targetScope: ["src/net/**::*"],
      forbid: ["net"],
    });
    const context = mkContext({
      contract: mkContract([p1, p2]),
      projectDir: resolve(__dirname, ".."),
    });
    const v1 = mkViolation({ rule_id: "effect.NO_IO.forbidden" });
    const v2 = mkViolation({ rule_id: "effect.NO_NET.forbidden" });
    const v3 = mkViolation({
      rule_id: "effect.NO_NET.forbidden",
      fingerprint: "fp2",
    });
    const evaluate = vi.fn(
      async (): Promise<EvaluateEffectResult> => ({
        violations: Object.freeze([v1, v2, v3]),
        notices: Object.freeze([]),
        stats: {
          policiesEvaluated: 2,
          nodesAnalyzed: 3,
          unresolvedFailures: 0,
          propagationRounds: 1,
          suppressionsActive: 0,
        },
      }),
    );

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(3);
    expect(report.summary.violation_count).toBe(3);
    const ids = report.violations.map((v) => v.rule_id);
    expect(ids).toContain("effect.NO_IO.forbidden");
    expect(ids).toContain("effect.NO_NET.forbidden");
    _clearCallGraphCacheForTests(context);
  });

  it("returns ok=true with zero violations when evaluator emits nothing", async () => {
    const policy = mkEffectPolicy({ id: "NO_IO" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn(async () => okResult());

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.summary.violation_count).toBe(0);
    _clearCallGraphCacheForTests(context);
  });

  it("merges evaluator notices into the report without flipping ok", async () => {
    const policy = mkEffectPolicy({ id: "NO_IO" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const notice = mkViolation({
      rule_id: "effect.unresolved_call_blocks_evaluation",
      severity: "warning",
    });
    const evaluate = vi.fn(
      async (): Promise<EvaluateEffectResult> => ({
        violations: Object.freeze([]),
        notices: Object.freeze([notice]),
        stats: {
          policiesEvaluated: 1,
          nodesAnalyzed: 1,
          unresolvedFailures: 1,
          propagationRounds: 1,
          suppressionsActive: 0,
        },
      }),
    );

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
      strictMode: false,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.severity).toBe("warning");
    expect(report.violations[0]!.rule_id).toBe(
      "effect.unresolved_call_blocks_evaluation",
    );
    // Notices live alongside violations in the merged array; ok stays true
    // because no error-severity entries were produced.
    expect(report.summary.violation_count).toBe(1);
    _clearCallGraphCacheForTests(context);
  });

  it("threads strictMode=true through to the evaluator by default", async () => {
    const policy = mkEffectPolicy({ id: "NO_IO" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn<EvaluateFn>(async () => okResult());

    await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    const call = evaluate.mock.calls[0]?.[0];
    expect(call?.strictMode).toBe(true);
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildEffectStage — CallGraph cache", () => {
  it("reuses CallGraph extraction across repeated stage calls for the same context", async () => {
    const policy = mkEffectPolicy({ id: "CACHE_TEST" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });
    await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    _clearCallGraphCacheForTests(context);
  });

  it("re-extracts after the cache helper clears the entry", async () => {
    const policy = mkEffectPolicy({ id: "CACHE_CLEAR_TEST" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });
    _clearCallGraphCacheForTests(context);
    await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(extract).toHaveBeenCalledTimes(2);
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildEffectStage — failure paths", () => {
  it("surfaces effect.extraction_error when extract throws", async () => {
    const policy = mkEffectPolicy({ id: "EXTRACTION_FAIL" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => {
      throw new Error("ts boom");
    });
    const evaluate = vi.fn(async () => okResult());

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("effect.extraction_error");
    expect(report.violations[0]!.cause.summary).toContain("ts boom");
    expect(evaluate).not.toHaveBeenCalled();
    _clearCallGraphCacheForTests(context);
  });

  it("surfaces effect.evaluation_error when evaluate throws", async () => {
    const policy = mkEffectPolicy({ id: "EVAL_FAIL" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn(async () => {
      throw new Error("evaluator crashed");
    });

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("effect.evaluation_error");
    expect(report.violations[0]!.cause.summary).toContain("evaluator crashed");
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildEffectStage — cross-stage cache reuse", () => {
  it("picks up a CallGraph populated by an earlier stage's shared cache", async () => {
    const policy = mkEffectPolicy({ id: "SHARED_CACHE" });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });

    // Seed the shared cache as if the trace/type-state stage had already run.
    const { setCachedCallGraph } = await import(
      "../src/commands/check-stages-call-graph-cache.js"
    );
    const seeded: CallGraph = mkCallGraph({
      nodes: [mkNode({ id: "src/seed.ts::seed(0)" })],
      edges: [mkEdge({ from: "src/seed.ts::seed(0)", to: "src/seed.ts::seed(0)" })],
    });
    setCachedCallGraph(context, seeded);

    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn<EvaluateFn>(async () => okResult());

    const report = await buildEffectStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(true);
    expect(extract).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    const passedGraph = evaluate.mock.calls[0]?.[0]?.callGraph;
    expect(passedGraph?.nodes?.[0]?.id).toBe("src/seed.ts::seed(0)");
    _clearCallGraphCacheForTests(context);
  });
});
