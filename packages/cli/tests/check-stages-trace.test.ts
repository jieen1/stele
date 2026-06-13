import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  unresolvedCalls?: CallGraph["unresolvedCalls"];
}): CallGraph {
  return {
    schemaVersion: "1",
    language: opts.language ?? "typescript",
    generatedAt: "2026-01-01T00:00:00Z",
    projectRoot: "/tmp/fixture",
    nodes: opts.nodes ?? [],
    edges: opts.edges ?? [],
    unresolvedCalls: opts.unresolvedCalls ?? [],
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
  scope?: readonly string[];
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
    scope: opts.scope ?? [],
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

  it("fails loud with an error violation for rust (no extractor yet)", async () => {
    const policy = mkPolicy({ id: "P1", target: [DB] });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "rust",
    });

    const report = await buildTraceStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(report.violations[0]!.rule_id).toBe("trace.not-yet-supported.rust");
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

  it("returns ok=true with zero violations when an examined path is clean (indirect, not denied)", async () => {
    const policy = mkPolicy({
      id: "NO_DIRECT_DB",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    // The controller reaches DB only INDIRECTLY (via the repository), so the
    // policy examines a real caller→target call site (callSitesExamined > 0)
    // but finds no DIRECT controller→DB call. ok must stay true. (An EMPTY
    // edge set would now correctly trip the HIGH #3 vacuous-green guard —
    // 0 examined call sites — so we give the policy a path to examine.)
    const SVC = "src/services/order.ts::OrderService::run(0)";
    const callGraph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: SVC, filePath: "src/services/order.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      edges: [
        mkEdge({ from: CTRL, to: SVC }),
        mkEdge({ from: SVC, to: DB }),
      ],
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

  it("zero-binding guard: an error-severity policy with targets but an empty scope fails the build", async () => {
    // Targets are usually global externs that exist regardless of callers; a
    // non-empty scope that resolves to 0 nodes (e.g. a renamed scope path)
    // would otherwise leave the policy vacuously green. The guard must fire.
    const policy = mkPolicy({
      id: "SCOPED_NOWHERE",
      target: ["**/controllers/**::*"], // matches the CTRL node below → targets > 0
      scope: ["**/this-path-matches-nothing/**::*"], // 0 in-scope callers
      denyDirect: ["src/db/**::*"],
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
    const guard = report.violations.find((v) => v.rule_id === "trace.SCOPED_NOWHERE.zero_binding");
    expect(guard).toBeDefined();
    expect(guard!.cause?.summary).toContain("in-scope caller");
    _clearCallGraphCacheForTests(context);
  });

  it("zero-binding guard (HIGH #3): targets + scope bind but 0 call sites examined fails the build", async () => {
    // The classic blind spot: the protected sink (DB) exists, the in-scope
    // caller (CTRL) exists, but no in-scope caller actually reaches the sink —
    // e.g. APPROVE's scope contained no call to it. Previously vacuously green;
    // now the guard turns it into an error.
    const policy = mkPolicy({
      id: "UNEXERCISED",
      target: ["src/db/**::*"], // DB present below → targets > 0
      denyDirect: ["**/controllers/**::*"], // CTRL in scope → scope > 0
    });
    const callGraph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      edges: [], // CTRL never reaches DB → 0 examined call sites
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
    const guard = report.violations.find((v) => v.rule_id === "trace.UNEXERCISED.zero_binding");
    expect(guard).toBeDefined();
    expect(guard!.severity).toBe("error");
    expect(guard!.cause?.summary).toContain("0 in-scope caller");
    _clearCallGraphCacheForTests(context);
  });

  it("fail-closed (HIGH #1): an in-scope caller with a dynamic-dispatch call site fails the build", async () => {
    // A call the extractor could not resolve (obj[m]()) is never an edge, so
    // the ordering walks are blind to it. The stage must surface the
    // evaluator's fail-closed violation as an error.
    const policy = mkPolicy({
      id: "PAYMENT_GUARD",
      target: [DB],
      mustTransit: [REPO],
    });
    const callGraph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: REPO, filePath: "src/repository/orders.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      // CTRL transits REPO to reach DB — the resolved path is clean…
      edges: [
        mkEdge({ from: CTRL, to: REPO }),
        mkEdge({ from: REPO, to: DB }),
      ],
      // …but CTRL also has an unresolvable call the analyzer cannot prove
      // doesn't bypass REPO. Fail closed.
      unresolvedCalls: [
        {
          fromId: CTRL,
          callSite: { line: 14, column: 7 },
          rawText: "handlers[name]()",
          reason: "dynamic",
          nameHidden: true,
        },
      ],
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
    const failClosed = report.violations.find(
      (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toBeDefined();
    expect(failClosed!.severity).toBe("error");
    expect(failClosed!.location.line).toBe(14);
    _clearCallGraphCacheForTests(context);
  });

  it("P0 regression: a PYTHON graph with a name-hidden unresolved call fails closed", async () => {
    // The original hole: the Python extractor never emitted `nameHidden`, so on
    // a python-target project `!u.nameHidden` was truthy for EVERY unresolved
    // call and the fail-closed gate never fired — a getattr()/obj[expr]()
    // dispatch to a forbidden target passed green. With the extractor now
    // classifying nameHidden, a python-shaped graph must fail closed exactly
    // like the TypeScript one above.
    const policy = mkPolicy({ id: "PAYMENT_GUARD", target: [DB], mustTransit: [REPO] });
    const callGraph = mkCallGraph({
      language: "python",
      nodes: [
        mkNode({ id: CTRL, filePath: "controllers/order.py" }),
        mkNode({ id: REPO, filePath: "repository/orders.py" }),
        mkNode({ id: DB, filePath: "db/users.py" }),
      ],
      edges: [mkEdge({ from: CTRL, to: REPO }), mkEdge({ from: REPO, to: DB })],
      unresolvedCalls: [
        {
          fromId: CTRL,
          callSite: { line: 21, column: 9 },
          rawText: "getattr(self, name)()",
          reason: "reflection",
          nameHidden: true,
        },
      ],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(false);
    const failClosed = report.violations.find(
      (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toBeDefined();
    expect(failClosed!.severity).toBe("error");
    expect(failClosed!.location.line).toBe(21);
    _clearCallGraphCacheForTests(context);
  });

  it("precision: a PYTHON name-VISIBLE unresolved call (predicate()) does NOT over-block", async () => {
    // The companion guarantee: a visible-name callback that merely failed to
    // resolve (nameHidden:false) must NOT trip fail-closed, or trace-policy
    // would be unusable on any Python project that passes callbacks. The
    // controller reaches DB only INDIRECTLY (via the service), so deny-direct is
    // clean and an examined call site exists; the only unresolved site is
    // name-visible, so the build stays green.
    const SVC = "services/order.py::OrderService::run(0)";
    const policy = mkPolicy({
      id: "NO_DIRECT_DB",
      target: ["**/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
    });
    const callGraph = mkCallGraph({
      language: "python",
      nodes: [
        mkNode({ id: CTRL, filePath: "controllers/order.py" }),
        mkNode({ id: SVC, filePath: "services/order.py" }),
        mkNode({ id: DB, filePath: "db/users.py" }),
      ],
      edges: [mkEdge({ from: CTRL, to: SVC }), mkEdge({ from: SVC, to: DB })],
      unresolvedCalls: [
        {
          fromId: CTRL,
          callSite: { line: 7, column: 5 },
          rawText: "predicate()",
          reason: "dynamic",
          nameHidden: false,
        },
      ],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
      projectDir: resolve(__dirname, ".."),
    });
    const extract = vi.fn(async () => callGraph);

    const report = await buildTraceStage(context, PROTECTED_STATE, "check", {
      extractCallGraph: extract,
    });

    const failClosed = report.violations.find(
      (v) => v.rule_id === "trace.NO_DIRECT_DB.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Integration: REAL Python extractor -> trace stage (no injected graph).
// Closes the seam the two unit halves leave unverified (extractor JSON shape
// <-> evaluator contract) AND end-to-end-validates the P0 alias fix.
// ---------------------------------------------------------------------------

function pythonAvailable(): boolean {
  for (const c of ["python3", "python"]) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const describePy = pythonAvailable() ? describe : describe.skip;

describePy("buildTraceStage — REAL Python extractor (integration)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    dirs.length = 0;
  });

  function mkPyProject(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "stele-trace-py-"));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return root;
  }

  it("alias of a forbidden target (w = delete_all; w()) is CAUGHT via a real edge (P0 fix, end-to-end)", async () => {
    const root = mkPyProject({
      "db.py": "def delete_all():\n    pass\n",
      "handler.py":
        "from db import delete_all\n\ndef handler():\n    w = delete_all\n    w()\n",
    });
    const policy = mkPolicy({
      id: "NO_DELETE_ALL",
      target: ["db.py::delete_all"],
      denyDirect: ["handler.py::handler"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
      projectDir: root,
    });

    // NOTE: no extractCallGraph injected -> the real pyCallGraphExtractor runs.
    const report = await buildTraceStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) => v.rule_id === "trace.NO_DELETE_ALL.direct_call_denied"),
    ).toBe(true);
    _clearCallGraphCacheForTests(context);
  });

  it("getattr(self, name)() hidden dispatch fires fail-closed through the real pipeline", async () => {
    const root = mkPyProject({
      "db.py": "def delete_all():\n    pass\n",
      "svc.py":
        "class Svc:\n" +
        "    def run(self, name):\n" +
        "        return getattr(self, name)()\n",
    });
    const policy = mkPolicy({
      id: "GUARD",
      target: ["db.py::delete_all"],
      scope: ["svc.py::Svc::run"],
      mustTransit: ["repo.py::find"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "python",
      projectDir: root,
    });

    const report = await buildTraceStage(context, PROTECTED_STATE, "check");

    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) => v.rule_id === "trace.GUARD.unresolved_call_blocks_evaluation",
      ),
    ).toBe(true);
    _clearCallGraphCacheForTests(context);
  });
});

// ---------------------------------------------------------------------------
// Integration: REAL Go extractor -> trace stage (no injected graph).
// Gated on a reachable Go toolchain (STELE_GO env or `go` on PATH).
// ---------------------------------------------------------------------------

function goReachable(): boolean {
  const candidate =
    process.env.STELE_GO && process.env.STELE_GO.trim().length > 0 ? process.env.STELE_GO.trim() : "go";
  try {
    execFileSync(candidate, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeGo = goReachable() ? describe : describe.skip;

describeGo("buildTraceStage — REAL Go extractor (integration)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    dirs.length = 0;
  });

  function mkGoProject(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "stele-trace-go-"));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return root;
  }

  it("deny-direct fires on a real same-package edge to the forbidden target", async () => {
    const root = mkGoProject({
      "m.go": "package m\nfunc handler() { deleteAll() }\nfunc deleteAll() {}\n",
    });
    const policy = mkPolicy({
      id: "NO_DELETE_ALL",
      target: ["m.go::deleteAll"],
      denyDirect: ["m.go::handler"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "go",
      projectDir: root,
    });
    const report = await buildTraceStage(context, PROTECTED_STATE, "check");
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.rule_id === "trace.NO_DELETE_ALL.direct_call_denied")).toBe(true);
    _clearCallGraphCacheForTests(context);
  });

  it("computed dispatch (handlers[name]()) fires fail-closed through the real pipeline", async () => {
    const root = mkGoProject({
      "m.go":
        "package m\nfunc Run(name string, handlers map[string]func()) {\n\thandlers[name]()\n}\n",
    });
    const policy = mkPolicy({
      id: "GUARD",
      target: ["m.go::deleteAll"],
      scope: ["m.go::Run"],
      mustTransit: ["m.go::repo"],
    });
    const context = mkContext({
      contract: mkContract([policy]),
      targetLanguage: "go",
      projectDir: root,
    });
    const report = await buildTraceStage(context, PROTECTED_STATE, "check");
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) => v.rule_id === "trace.GUARD.unresolved_call_blocks_evaluation"),
    ).toBe(true);
    _clearCallGraphCacheForTests(context);
  });
});
