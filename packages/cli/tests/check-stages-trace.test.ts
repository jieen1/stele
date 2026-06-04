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
  RuleId,
  TracePolicyDeclaration,
} from "@stele/core";

import {
  _clearCallGraphCacheForTests,
  buildTraceStage,
} from "../src/commands/check-stages-trace.js";
import type {
  PreparedCheckContext,
  ProtectedCheckState,
} from "../src/architecture/types.js";

// ---------------------------------------------------------------------------
// Synthetic CallGraph + Contract helpers
// ---------------------------------------------------------------------------

const CTRL = "src/controllers/order.ts::OrderController::handle(0)";
const REPO = "src/repository/orders.ts::OrderRepository::find(1)";
const DB = "src/db/users.ts::Db::query(1)";

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

function mkEdge(opts: { from: string; to: string; line?: number }): CallGraphEdge {
  return {
    fromId: opts.from,
    toId: opts.to,
    callSite: { line: opts.line ?? 1, column: 1 },
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

function mkPolicy(opts: {
  id: string;
  target: readonly string[];
  mustTransit?: readonly string[];
  denyDirect?: readonly string[];
  severity?: "error" | "warning";
}): TracePolicyDeclaration {
  return {
    kind: "trace-policy",
    filePath: "contract/test.stele",
    node: {
      kind: "list",
      head: "trace-policy",
      items: [],
      span: { file: "contract/test.stele", line: 1, column: 1 },
    } as unknown as TracePolicyDeclaration["node"],
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id: opts.id,
    description: undefined,
    severity: opts.severity ?? "error",
    target: opts.target,
    mustTransit: opts.mustTransit ?? [],
    mustBePrecededBy: [],
    mustBeFollowedBy: [],
    denyDirect: opts.denyDirect ?? [],
    denyTransit: [],
    scope: [],
    exempt: [],
    fixHint: undefined,
  };
}

function mkContract(policies: readonly TracePolicyDeclaration[]): Contract {
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
  } as unknown as Contract;
}

function mkContext(opts: {
  contract: Contract;
  targetLanguage?: string;
  projectDir?: string;
}): PreparedCheckContext {
  return {
    projectDir: opts.projectDir ?? "/tmp/stele-trace-test",
    config: {
      targetLanguage: opts.targetLanguage ?? "typescript",
    } as unknown as PreparedCheckContext["config"],
    contract: opts.contract,
    generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
    invariantCount: 0,
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTraceStage — empty contract", () => {
  it("returns ok with zero violations when no trace-policies declared", async () => {
    const context = mkContext({ contract: mkContract([]) });
    const extract = vi.fn(async () => mkCallGraph({}));

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.summary.violation_count).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("buildTraceStage — non-typescript target language (Round 4 F-A-02 fail-loud)", () => {
  it("routes python projects through the Python CallGraph extractor (Round 14 P0)", async () => {
    // Round 14 P0: Python is now a supported Phase B target. The
    // trace stage SHOULD call the injected extractor (which the test
    // stubs with `mkCallGraph({})`) and produce a normal report
    // rather than fail-loud.
    const policy = mkPolicy({ id: "P1", target: [DB], denyDirect: [CTRL] });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
    });
    const extract = vi.fn(async () => mkCallGraph({}));

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    // Extractor was actually invoked (no fail-loud short-circuit).
    expect(extract).toHaveBeenCalledTimes(1);
    // No fail-loud rule fired.
    const ruleIds = report.violations.map((v) => v.rule_id);
    expect(ruleIds).not.toContain("trace.not-yet-supported.python");
  });

  it("fails loud with an error violation for go", async () => {
    const policy = mkPolicy({ id: "P1", target: [DB] });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "go",
    });

    const report = await buildTraceStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(report.violations[0]!.rule_id).toBe("trace.not-yet-supported.go");
    expect(report.violations[0]!.severity).toBe("error");
  });
});

describe("buildTraceStage — missing tsconfig", () => {
  it("returns ok with trace.no-tsconfig warning when tsconfig is absent", async () => {
    const policy = mkPolicy({ id: "P1", target: [DB], denyDirect: [CTRL] });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: "/tmp/stele-trace-test-does-not-exist-xyz",
    });

    const report = await buildTraceStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("trace.no-tsconfig");
    expect(report.violations[0]!.severity).toBe("warning");
  });
});

describe("buildTraceStage — successful evaluation", () => {
  it("surfaces deny-direct violations from the evaluator", async () => {
    const policy = mkPolicy({
      id: "NO_DIRECT_DB",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    const callGraph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      edges: [mkEdge({ from: CTRL, to: DB })],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."), // any existing dir; tsconfig presence will be tested below
    });

    // Pass through a fake tsconfig by stubbing extraction directly. We rely on
    // the existsSync check finding the CLI tests directory's parent tsconfig.
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(1);
    expect(report.violations[0]!.rule_id).toBe("trace.NO_DIRECT_DB.direct_call_denied");
    expect(report.summary.violation_count).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    _clearCallGraphCacheForTests(context);
  });

  it("returns ok=true with zero violations when graph has no offending edges", async () => {
    const policy = mkPolicy({
      id: "NO_DIRECT_DB",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    const callGraph = mkCallGraph({
      // DB node present so the policy target (src/db/**::*) binds — the
      // zero-binding guard requires a real target; the point of this test is
      // "target present, no OFFENDING edge", not "target absent".
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      edges: [], // no edge to DB
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.summary.violation_count).toBe(0);
    _clearCallGraphCacheForTests(context);
  });

  it("zero-binding guard: an error-severity policy matching 0 target nodes fails the build", async () => {
    const policy = mkPolicy({
      id: "NO_DIRECT_DB",
      target: ["src/db/**::*"], // no db node in the graph below → 0 targets
      denyDirect: ["**/controllers/**::*"],
    });
    const callGraph = mkCallGraph({
      nodes: [mkNode({ id: CTRL, filePath: "src/controllers/order.ts" })],
      edges: [],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.ok).toBe(false);
    const guard = report.violations.find((v) => v.rule_id === "trace.NO_DIRECT_DB.zero_binding");
    expect(guard).toBeDefined();
    expect(guard!.severity).toBe("error");
    _clearCallGraphCacheForTests(context);
  });

  it("merges evaluator notices into the violations array without flipping ok", async () => {
    const policy = mkPolicy({
      id: "TRACE_NOTICE",
      target: [DB],
      denyDirect: [CTRL],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const callGraph = mkCallGraph({});
    const extract = vi.fn(async () => callGraph);

    // Stub evaluator to return one warning-severity notice and zero errors.
    const evaluate = vi.fn(() => ({
      violations: [],
      notices: [
        {
          rule_id: "trace.TRACE_NOTICE.path_exceeded_max_depth" as RuleId,
          rule_kind: "trace_violation",
          severity: "warning" as const,
          source: { tool: "stele", command: "check", kind: "rule" },
          location: { path: "src/x.ts" },
          cause: { summary: "path exceeded depth cap" },
          fingerprint: "fp-notice",
          scope_paths: ["src/x.ts"],
          status: "active" as const,
        },
      ],
      stats: {
        policiesEvaluated: 1,
        pathsEnumeratedTotal: 0,
        pathsCappedTotal: 1,
      },
      coverage: [],
    }));

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
      evaluate,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.severity).toBe("warning");
    // Notices live alongside violations in the merged array; ok stays true
    // because no error-severity entries were produced.
    expect(report.summary.violation_count).toBe(1);
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildTraceStage — CallGraph cache", () => {
  it("reuses CallGraph extraction across repeated calls with the same context", async () => {
    const policy = mkPolicy({
      id: "CACHE_TEST",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const callGraph = mkCallGraph({});
    const extract = vi.fn(async () => callGraph);

    await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });
    await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    _clearCallGraphCacheForTests(context);
  });

  it("re-extracts after the cache helper clears the entry", async () => {
    const policy = mkPolicy({
      id: "CACHE_CLEAR_TEST",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => mkCallGraph({}));

    await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });
    _clearCallGraphCacheForTests(context);
    await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(extract).toHaveBeenCalledTimes(2);
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildTraceStage — extractor failures", () => {
  it("surfaces a trace.extraction_error violation when extract throws", async () => {
    const policy = mkPolicy({
      id: "EXTRACTION_FAIL",
      target: [DB],
      denyDirect: [CTRL],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => {
      throw new Error("boom");
    });

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule_id).toBe("trace.extraction_error");
    expect(report.violations[0]!.cause.summary).toContain("boom");
    _clearCallGraphCacheForTests(context);
  });
});

describe("buildTraceStage — extern pattern resolution defaults", () => {
  it("evaluates extern: patterns even with no externAliases registry", async () => {
    // extern:stripe::* matches an edge to extern:stripe::charge(2) directly
    // because the pattern matcher resolves literal extern: prefixes as the
    // logical name when no registry is provided.
    const STRIPE = "extern:stripe::charge(2)";
    const policy = mkPolicy({
      id: "STRIPE_GUARD",
      target: ["extern:stripe::*"],
      denyDirect: ["**::OrderController::*"],
    });
    const callGraph = mkCallGraph({
      nodes: [mkNode({ id: CTRL, filePath: "src/controllers/order.ts" })],
      edges: [mkEdge({ from: CTRL, to: STRIPE })],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(report.violations.length).toBeGreaterThanOrEqual(1);
    expect(report.violations[0]!.rule_id).toContain("STRIPE_GUARD");
    _clearCallGraphCacheForTests(context);
  });
});
