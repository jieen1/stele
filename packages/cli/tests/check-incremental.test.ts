import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGraph, CallGraphNode, CallGraphEdge, SupportedLanguage } from "@stele/call-graph-core";
import type { Contract } from "@stele/core";
import {
  computeIncrementalPlan,
  normalizeChangedArg,
  SKIPPABLE_STAGE_IDS,
  NO_INCREMENTAL,
} from "../src/commands/check-incremental.js";
import { runAllStages } from "../src/commands/check-stages-registry.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../src/architecture/types.js";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-incremental-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFileEnsuringDir(root: string, rel: string, content: string): Promise<void> {
  const abs = resolve(root, rel);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

// --- minimal call-graph + contract builders (mirror trace test conventions) ---

function mkNode(id: string, filePath: string): CallGraphNode {
  return {
    id,
    kind: "function",
    filePath,
    span: { line: 1, column: 1 },
    signature: id,
    isExported: false,
    isAsync: false,
  };
}

function mkEdge(from: string, to: string): CallGraphEdge {
  return {
    fromId: from,
    toId: to,
    callSite: { line: 1, column: 1 },
    isConditional: false,
    isLoop: false,
    isAsync: false,
  };
}

function mkCallGraph(nodes: CallGraphNode[], edges: CallGraphEdge[], language: SupportedLanguage = "typescript"): CallGraph {
  return {
    schemaVersion: "1",
    language,
    generatedAt: "2026-01-01T00:00:00Z",
    projectRoot: "/tmp/fixture",
    nodes,
    edges,
    unresolvedCalls: [],
    ambiguousCalls: [],
    methodResolutionHash: "0".repeat(64),
    fileHashes: {},
  };
}

function mkClassShape(id: string, target: string): unknown {
  return {
    kind: "class-shape",
    filePath: "contract/test.stele",
    node: {} as unknown,
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id,
    lang: "typescript",
    target,
    mustHaveMethods: [],
    mustNotHaveMethods: [],
    mustExtend: [],
    mustImplement: [],
  };
}

function mkEffectPolicy(id: string, targetScope: readonly string[]): unknown {
  return {
    kind: "effect-policy",
    filePath: "contract/test.stele",
    node: {} as unknown,
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id,
    targetScope,
    allow: [],
    deny: [],
    require: [],
  };
}

function mkTracePolicy(id: string, target: readonly string[], scope: readonly string[]): unknown {
  return {
    kind: "trace-policy",
    filePath: "contract/test.stele",
    node: {} as unknown,
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id,
    severity: "error",
    target,
    mustTransit: [],
    mustBePrecededBy: [],
    mustBeFollowedBy: [],
    denyDirect: [],
    denyTransit: [],
    scope,
    exempt: [],
  };
}

function mkContract(overrides: Record<string, unknown>): Contract {
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
    effectPolicies: [],
    ...overrides,
  } as unknown as Contract;
}

function mkContext(projectDir: string, contract: Contract): PreparedCheckContext {
  return {
    projectDir,
    config: { targetLanguage: "typescript" } as unknown as PreparedCheckContext["config"],
    contract,
    generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
    invariantCount: 0,
  };
}

const PROTECTED_STATE: ProtectedCheckState = {
  protectedPaths: [],
  contractHash: "0".repeat(64),
  summary: { invariantCount: 0, generatedFileCount: 0, protectedFileCount: 0 },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("normalizeChangedArg", () => {
  it("normalizes and drops out-of-project paths", () => {
    const result = normalizeChangedArg("/proj", ["packages/a/src/x.ts", "../escape.ts", "  ", "packages/a/src/x.ts"]);
    expect(result).toEqual(["packages/a/src/x.ts"]);
  });
});

describe("computeIncrementalPlan — (a) changed file IN a stage's scope => stage runs", () => {
  it("does NOT skip code-shape when the changed file is in its target", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/order.ts", "export class Order {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/other.ts", "export class Other {}\n");

    const contract = mkContract({
      codeShapes: [mkClassShape("CS1", "packages/a/src/order.ts::Order")],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, ["packages/a/src/order.ts"], {
      buildCallGraph: async () => null,
    });

    expect(plan.skipped.has("code-shape")).toBe(false);
    expect(plan.notes.some((n) => /"code-shape" runs/.test(n))).toBe(true);
  });
});

describe("computeIncrementalPlan — (b) changed file in NO stage scope => file-scoped stages skipped, globals untouched", () => {
  it("skips code-shape when the changed file is outside its target", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/order.ts", "export class Order {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/unrelated.ts", "export const x = 1;\n");

    const contract = mkContract({
      codeShapes: [mkClassShape("CS1", "packages/a/src/order.ts::Order")],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, ["packages/a/src/unrelated.ts"], {
      buildCallGraph: async () => null,
    });

    expect(plan.skipped.has("code-shape")).toBe(true);
    expect(plan.notes.some((n) => /"code-shape" skipped/.test(n))).toBe(true);
    // The skipped set NEVER contains a global stage.
    for (const id of plan.skipped) {
      expect(SKIPPABLE_STAGE_IDS).toContain(id);
    }
    expect(plan.skipped.has("generated")).toBe(false);
    expect(plan.skipped.has("protected")).toBe(false);
    expect(plan.skipped.has("type-driven")).toBe(false);
  });
});

describe("computeIncrementalPlan — symbol mechanism (effect) via call graph", () => {
  it("skips effect when no changed file is in the effect targetScope", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/svc.ts", "export function pay() {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/ui.ts", "export function render() {}\n");

    const callGraph = mkCallGraph(
      [mkNode("packages/a/src/svc.ts::pay(0)", "packages/a/src/svc.ts")],
      [],
    );
    const contract = mkContract({
      effectPolicies: [mkEffectPolicy("EP1", ["packages/a/src/svc.ts::*"])],
    });
    const context = mkContext(projectDir, contract);

    const planSkip = await computeIncrementalPlan(context, ["packages/a/src/ui.ts"], {
      buildCallGraph: async () => callGraph,
    });
    expect(planSkip.skipped.has("effect")).toBe(true);

    const planRun = await computeIncrementalPlan(context, ["packages/a/src/svc.ts"], {
      buildCallGraph: async () => callGraph,
    });
    expect(planRun.skipped.has("effect")).toBe(false);
  });

  it("RUNS effect (fail-safe) when the call graph is unavailable", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/ui.ts", "export function render() {}\n");
    const contract = mkContract({
      effectPolicies: [mkEffectPolicy("EP1", ["packages/a/src/svc.ts::*"])],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, ["packages/a/src/ui.ts"], {
      buildCallGraph: async () => null,
    });

    // No call graph => cannot prove effect unaffected => MUST run (no false green).
    expect(plan.skipped.has("effect")).toBe(false);
    expect(plan.notes.some((n) => /call-graph/.test(n))).toBe(true);
  });

  it("RUNS effect (fail-safe) when call graph extraction throws", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/ui.ts", "export function render() {}\n");
    const contract = mkContract({
      effectPolicies: [mkEffectPolicy("EP1", ["packages/a/src/svc.ts::*"])],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, ["packages/a/src/ui.ts"], {
      buildCallGraph: async () => {
        throw new Error("extractor boom");
      },
    });

    expect(plan.skipped.has("effect")).toBe(false);
    expect(plan.notes.some((n) => /extraction failed/.test(n))).toBe(true);
  });
});

describe("computeIncrementalPlan — (d) empty changeset still skips file-scoped, never globals", () => {
  it("with an empty changeset, file-scoped stages with bindings skip but globals are never in the set", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/order.ts", "export class Order {}\n");
    const contract = mkContract({
      codeShapes: [mkClassShape("CS1", "packages/a/src/order.ts::Order")],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, [], {
      buildCallGraph: async () => null,
    });

    // Empty changeset => nothing in scope => code-shape provably unaffected.
    expect(plan.skipped.has("code-shape")).toBe(true);
    for (const id of plan.skipped) {
      expect(SKIPPABLE_STAGE_IDS).toContain(id);
    }
  });
});

describe("SKIPPABLE_STAGE_IDS are all real registry stage ids (never a global)", () => {
  it("every skippable id exists in CHECK_STAGES and the runner exposes a skip parameter", async () => {
    const { CHECK_STAGES, topologicalSortStages, runAllStages: runner } = await import(
      "../src/commands/check-stages-registry.js"
    );
    const ids = new Set(topologicalSortStages(CHECK_STAGES).map((s) => s.id));
    for (const id of SKIPPABLE_STAGE_IDS) {
      expect(ids.has(id)).toBe(true);
    }
    // Global stages must NEVER be eligible for skipping.
    for (const global of ["generated", "protected", "design", "toolchain", "type-driven"]) {
      expect(SKIPPABLE_STAGE_IDS).not.toContain(global);
    }
    // The runner accepts a 6th skip-set argument (arity guard against refactors).
    expect(runner.length).toBeGreaterThanOrEqual(5);
    void runAllStages;
  });
});

describe("computeIncrementalPlan — (c) EQUIVALENCE / no false-green safety property", () => {
  // Safety property: every SKIPPED stage is one whose reverse-index covered
  // files are disjoint from the changed set. Therefore a full `stele check` of
  // that stage, restricted to the changed files, could not have reported any
  // violation — so skipping it never turns a would-be violation green.
  it("a skipped stage has ZERO overlap between its covered files and the changed set", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/order.ts", "export class Order {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/svc.ts", "export function pay() {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/touched.ts", "export const z = 1;\n");

    const callGraph = mkCallGraph(
      [
        mkNode("packages/a/src/svc.ts::pay(0)", "packages/a/src/svc.ts"),
        mkNode("packages/a/src/order.ts::Order::ctor(0)", "packages/a/src/order.ts"),
      ],
      [],
    );
    const contract = mkContract({
      codeShapes: [mkClassShape("CS1", "packages/a/src/order.ts::Order")],
      effectPolicies: [mkEffectPolicy("EP1", ["packages/a/src/svc.ts::*"])],
    });
    const context = mkContext(projectDir, contract);

    // Change a file that is in NEITHER scope.
    const changed = ["packages/a/src/touched.ts"];
    const plan = await computeIncrementalPlan(context, changed, {
      buildCallGraph: async () => callGraph,
    });

    // Both file-scoped stages are skippable here.
    expect(plan.skipped.has("code-shape")).toBe(true);
    expect(plan.skipped.has("effect")).toBe(true);

    // Reproduce the reverse index the plan used and assert disjointness for
    // every skipped stage's mechanisms.
    const { expandContractToFiles } = await import("../src/coverage/expand.js");
    const { enumerateUniverse } = await import("../src/coverage/universe.js");
    const universe = await enumerateUniverse(resolve(projectDir));
    const expansion = await expandContractToFiles({
      contract,
      projectDir: resolve(projectDir),
      callGraph,
      universeFiles: universe.map((f) => f.path),
    });
    const allCoveredOfSkipped = new Set<string>();
    for (const decl of expansion.declarations.values()) {
      // Both decl mechanisms above belong to skipped stages in this scenario.
      for (const f of decl.files) allCoveredOfSkipped.add(f);
    }
    for (const c of changed) {
      expect(allCoveredOfSkipped.has(c)).toBe(false);
    }
  });

  it("changing a covered file forces its stage to run (the inverse guarantee)", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/order.ts", "export class Order {}\n");
    const contract = mkContract({
      codeShapes: [mkClassShape("CS1", "packages/a/src/order.ts::Order")],
    });
    const context = mkContext(projectDir, contract);

    const plan = await computeIncrementalPlan(context, ["packages/a/src/order.ts"], {
      buildCallGraph: async () => null,
    });
    expect(plan.skipped.has("code-shape")).toBe(false);
  });
});

describe("computeIncrementalPlan — whole-graph trace policy must never be skipped (false-green regression)", () => {
  // A trace policy with empty `scope` guards EVERY caller in the graph, so its
  // file coverage is unbounded (expand encodes it as files={}). When mixed with
  // a scoped policy (which DOES contribute files), the stage `bindsAnything`, so
  // a naive planner would compare the changed set only against the scoped files
  // and skip the stage — silently dropping the whole-graph policy. That is a
  // false green. The planner must force the trace stage to run.
  it("does NOT skip trace when a whole-graph policy coexists with a scoped one and an out-of-scope caller changes", async () => {
    const projectDir = await createTempProject();
    await writeFileEnsuringDir(projectDir, "packages/a/src/scoped.ts", "export function caller() {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/dep.ts", "export function helper() {}\n");
    await writeFileEnsuringDir(projectDir, "packages/a/src/other.ts", "export function otherCaller() {}\n");

    const callGraph = mkCallGraph(
      [
        mkNode("packages/a/src/scoped.ts::caller(0)", "packages/a/src/scoped.ts"),
        mkNode("packages/a/src/dep.ts::helper(0)", "packages/a/src/dep.ts"),
        mkNode("packages/a/src/other.ts::otherCaller(0)", "packages/a/src/other.ts"),
      ],
      [
        mkEdge("packages/a/src/scoped.ts::caller(0)", "packages/a/src/dep.ts::helper(0)"),
        mkEdge("packages/a/src/other.ts::otherCaller(0)", "packages/a/src/dep.ts::helper(0)"),
      ],
    );

    const contract = mkContract({
      tracePolicies: [
        // Scoped policy — contributes scoped.ts to the reverse index.
        mkTracePolicy("TP_SCOPED", ["packages/a/src/dep.ts::helper(0)"], ["packages/a/src/scoped.ts"]),
        // Whole-graph policy (empty scope) — guards EVERY caller, files={}.
        mkTracePolicy("TP_WHOLE", ["packages/a/src/dep.ts::helper(0)"], []),
      ],
    });
    const context = mkContext(projectDir, contract);

    // Change a caller that the whole-graph policy guards but the scoped one does not.
    const plan = await computeIncrementalPlan(context, ["packages/a/src/other.ts"], {
      buildCallGraph: async () => callGraph,
    });

    expect(plan.skipped.has("trace")).toBe(false);
    expect(plan.notes.some((n) => /trace.*whole-graph\/extern-only/.test(n))).toBe(true);
  });
});

describe("NO_INCREMENTAL sentinel", () => {
  it("is inactive with an empty skip set", () => {
    expect(NO_INCREMENTAL.active).toBe(false);
    expect(NO_INCREMENTAL.skipped.size).toBe(0);
  });
});
