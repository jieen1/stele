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
  TypeStateDeclaration,
  Violation,
} from "@stele/core";
import type {
  EvaluateTypeStateOptions,
  EvaluateTypeStateResult,
  TypeStateInferenceExtractor,
} from "@stele/type-state-evaluator";

type EvaluateFn = (
  options: EvaluateTypeStateOptions,
) => Promise<EvaluateTypeStateResult>;

import { buildTypeStateStage } from "../src/commands/check-stages-type-state.js";
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

function mkEdge(opts: { from: string; to: string; line?: number; column?: number }): CallGraphEdge {
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

function mkTypeState(opts: {
  id: string;
  target?: string;
  states?: readonly string[];
  initial?: string;
}): TypeStateDeclaration {
  return {
    kind: "type-state",
    filePath: "contract/test.stele",
    node: {
      kind: "list",
      head: "type-state",
      items: [],
      span: { file: "contract/test.stele", line: 1, column: 1 },
    } as unknown as TypeStateDeclaration["node"],
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id: opts.id,
    target: opts.target ?? "src/order.ts::Order",
    description: undefined,
    severity: "error",
    states: opts.states ?? ["Draft", "Submitted", "Paid"],
    initial: opts.initial ?? "Draft",
    terminal: [],
    stateTypeMapping: [],
    transitions: [],
    allowedOps: new Map(),
    fixHint: undefined,
  };
}

function mkContract(typeStates: readonly TypeStateDeclaration[]): Contract {
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
    typeStates,
    typeStateBindings: [],
    effectDeclarations: [],
    effectAnnotations: [],
    effectPolicies: [],
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
    projectDir: opts.projectDir ?? "/tmp/stele-type-state-test",
    config: {
      targetLanguage: opts.targetLanguage ?? "typescript",
    } as unknown as PreparedCheckContext["config"],
    contract: opts.contract,
    generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
    invariantCount: 0,
  };
}

function mkViolation(over: Partial<Violation> & Pick<Violation, "rule_id">): Violation {
  return {
    rule_id: over.rule_id,
    rule_kind: over.rule_kind ?? "type_state_violation",
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

// Stub extractor — the stage delegates inference to the evaluator dep when
// provided, so this is only present to satisfy the default-path type.
const STUB_EXTRACTOR: TypeStateInferenceExtractor = {
  language: "typescript",
  async inferTypeStates() {
    return { inferences: Object.freeze([]) };
  },
};

function okResult(): EvaluateTypeStateResult {
  return {
    violations: Object.freeze([]),
    notices: Object.freeze([]),
    stats: {
      declarationsEvaluated: 0,
      callSitesAnalyzed: 0,
      inferenceFailures: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTypeStateStage — empty contract", () => {
  it("returns ok with zero violations when no type-state declarations exist", async () => {
    const context = mkContext({ contract: mkContract([]) });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
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

describe("buildTypeStateStage — non-typescript target language", () => {
  it("returns ok with a warning notice for python", async () => {
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      targetLanguage: "python",
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    // Round 4 F-A-02: fail loud.
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("typestate.not-yet-supported.python");
    expect(report.violations[0]!.severity).toBe("error");
    expect(extract).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails loud for rust (Round 4 F-A-02)", async () => {
    const decl = mkTypeState({ id: "FILE" });
    const context = mkContext({
      contract: mkContract([decl]),
      targetLanguage: "rust",
    });

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(report.violations[0]!.rule_id).toBe("typestate.not-yet-supported.rust");
    expect(report.violations[0]!.severity).toBe("error");
  });
});

describe("buildTypeStateStage — missing tsconfig", () => {
  it("returns ok with typestate.no-tsconfig warning when tsconfig is absent", async () => {
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: "/tmp/stele-type-state-test-does-not-exist-xyz",
    });

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("typestate.no-tsconfig");
    expect(report.violations[0]!.severity).toBe("warning");
  });
});

describe("buildTypeStateStage — successful evaluation", () => {
  it("surfaces evaluator violations and flips ok=false", async () => {
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const violation: Violation = mkViolation({
      rule_id: "typestate.ORDER.disallowed_op",
      severity: "error",
    });
    const evaluate = vi.fn(
      async (): Promise<EvaluateTypeStateResult> => ({
        violations: Object.freeze([violation]),
        notices: Object.freeze([]),
        stats: {
          declarationsEvaluated: 1,
          callSitesAnalyzed: 1,
          inferenceFailures: 0,
        },
      }),
    );
    const extract = vi.fn(async () => mkCallGraph({}));

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("typestate.ORDER.disallowed_op");
    expect(report.summary.violation_count).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    _clearCallGraphCacheForTests(context);
  });

  it("surfaces multiple violations across declarations", async () => {
    const decl1 = mkTypeState({ id: "ORDER" });
    const decl2 = mkTypeState({ id: "FILE", target: "src/file.ts::FileHandle" });
    const context = mkContext({
      contract: mkContract([decl1, decl2]),
      projectDir: resolve(__dirname, ".."),
    });
    const v1 = mkViolation({ rule_id: "typestate.ORDER.disallowed_op" });
    const v2 = mkViolation({ rule_id: "typestate.FILE.disallowed_op" });
    const v3 = mkViolation({ rule_id: "typestate.FILE.disallowed_op", fingerprint: "fp2" });
    const evaluate = vi.fn(
      async (): Promise<EvaluateTypeStateResult> => ({
        violations: Object.freeze([v1, v2, v3]),
        notices: Object.freeze([]),
        stats: {
          declarationsEvaluated: 2,
          callSitesAnalyzed: 3,
          inferenceFailures: 0,
        },
      }),
    );

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(3);
    expect(report.summary.violation_count).toBe(3);
    const ids = report.violations.map((v) => v.rule_id);
    expect(ids).toContain("typestate.ORDER.disallowed_op");
    expect(ids).toContain("typestate.FILE.disallowed_op");
    _clearCallGraphCacheForTests(context);
  });

  it("returns ok=true with zero violations when evaluator emits nothing", async () => {
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn(async () => okResult());

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
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
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const notice = mkViolation({
      rule_id: "typestate.ORDER.inference_failed",
      severity: "warning",
    });
    const evaluate = vi.fn(
      async (): Promise<EvaluateTypeStateResult> => ({
        violations: Object.freeze([]),
        notices: Object.freeze([notice]),
        stats: {
          declarationsEvaluated: 1,
          callSitesAnalyzed: 1,
          inferenceFailures: 1,
        },
      }),
    );

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
      strictMode: false,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.severity).toBe("warning");
    expect(report.violations[0]!.rule_id).toBe("typestate.ORDER.inference_failed");
    // Notices live alongside violations in the merged array; ok stays true
    // because no error-severity entries were produced.
    expect(report.summary.violation_count).toBe(1);
    _clearCallGraphCacheForTests(context);
  });

  it("threads strictMode=true through to the evaluator by default", async () => {
    const decl = mkTypeState({ id: "ORDER" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn<EvaluateFn>(async () => okResult());

    await buildTypeStateStage(context, PROTECTED_STATE, "check", {
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

describe("buildTypeStateStage — CallGraph cache", () => {
  it("reuses CallGraph extraction across repeated stage calls for the same context", async () => {
    const decl = mkTypeState({ id: "CACHE_TEST" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });
    await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    _clearCallGraphCacheForTests(context);
  });

  it("re-extracts after the cache helper clears the entry", async () => {
    const decl = mkTypeState({ id: "CACHE_CLEAR_TEST" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn(async () => okResult());

    await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });
    _clearCallGraphCacheForTests(context);
    await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(extract).toHaveBeenCalledTimes(2);
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildTypeStateStage — failure paths", () => {
  it("surfaces typestate.extraction_error when extract throws", async () => {
    const decl = mkTypeState({ id: "EXTRACTION_FAIL" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => {
      throw new Error("ts boom");
    });
    const evaluate = vi.fn(async () => okResult());

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("typestate.extraction_error");
    expect(report.violations[0]!.cause.summary).toContain("ts boom");
    expect(evaluate).not.toHaveBeenCalled();
    _clearCallGraphCacheForTests(context);
  });

  it("surfaces typestate.evaluation_error when evaluate throws", async () => {
    const decl = mkTypeState({ id: "EVAL_FAIL" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });
    const evaluate = vi.fn(async () => {
      throw new Error("evaluator crashed");
    });

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: vi.fn(async () => mkCallGraph({})),
      evaluate,
      extractor: STUB_EXTRACTOR,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("typestate.evaluation_error");
    expect(report.violations[0]!.cause.summary).toContain("evaluator crashed");
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildTypeStateStage — cross-stage cache reuse", () => {
  it("picks up a CallGraph populated by the trace stage's shared cache", async () => {
    const decl = mkTypeState({ id: "SHARED_CACHE" });
    const context = mkContext({
      contract: mkContract([decl]),
      projectDir: resolve(__dirname, ".."),
    });

    // Seed the shared cache as if the trace stage had already run.
    const { setCachedCallGraph } = await import(
      "../src/commands/check-stages-call-graph-cache.js"
    );
    const seeded: CallGraph = mkCallGraph({
      nodes: [mkNode({ id: "src/seed.ts::seed(0)" })],
    });
    setCachedCallGraph(context, seeded);

    const extract = vi.fn(async () => mkCallGraph({}));
    const evaluate = vi.fn<EvaluateFn>(async () => okResult());

    const report = await buildTypeStateStage(context, PROTECTED_STATE, "check", {
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
