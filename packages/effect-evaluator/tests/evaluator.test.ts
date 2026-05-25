import { describe, expect, it } from "vitest";

import { evaluateEffects } from "../src/evaluator.js";
import {
  StubExtractor,
  mkCallGraph,
  mkContract,
  mkEdge,
  mkEffectAnnotation,
  mkEffectDeclarations,
  mkEffectPolicy,
  mkEffectSuppression,
  mkNode,
  mkUnresolved,
} from "./fixtures/helpers.js";

const ALL_EFFECTS = ["db.read", "db.write", "http.outgoing", "log.audit", "time.now"];

describe("evaluateEffects — empty / trivial", () => {
  it("empty contract + empty graph → empty result", async () => {
    const r = await evaluateEffects({
      contract: mkContract({}),
      callGraph: mkCallGraph({ nodes: [], edges: [] }),
      extractor: new StubExtractor(),
    });
    expect(r.violations).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.stats.policiesEvaluated).toBe(0);
  });

  it("declaration without any policy → no violations", async () => {
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
      }),
      callGraph: mkCallGraph({
        nodes: [mkNode({ id: "src/x.ts::x(0)" })],
        edges: [],
      }),
      extractor: new StubExtractor(),
    });
    expect(r.violations).toEqual([]);
  });
});

describe("evaluateEffects — annotations to nodes", () => {
  it("CDL effect-annotation puts effect on matching node", async () => {
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({
            target: ["src/db/users.ts::*"],
            annotates: ["db.read"],
          }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "P",
            targetScope: ["src/db/**::*"],
            forbid: ["db.read"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [mkNode({ id: "src/db/users.ts::getUser(1)", filePath: "src/db/users.ts" })],
        edges: [],
      }),
      extractor: new StubExtractor(),
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.rule_id).toBe("effect.P.forbidden_effect");
  });

  it("source-code annotation (extractor) merges with CDL annotations", async () => {
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "P",
            targetScope: ["src/svc/**::*"],
            forbid: ["http.outgoing"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [mkNode({ id: "src/svc/api.ts::call(0)", filePath: "src/svc/api.ts" })],
        edges: [],
      }),
      extractor: new StubExtractor(
        new Map([["src/svc/api.ts::call(0)", ["http.outgoing"]]]),
      ),
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.cause.detail).toContain("direct_effects_on_node: [http.outgoing]");
  });
});

describe("evaluateEffects — propagation", () => {
  it("UI inherits db.read from a callee chain", async () => {
    const ui = "src/components/UserCard.tsx::UserCard(0)";
    const fetcher = "src/services/userService.ts::fetchUserData(1)";
    const dbFn = "src/db/users.ts::getUserFromDb(1)";

    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({
            target: ["src/db/**::*"],
            annotates: ["db.read"],
          }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/components/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [
          mkNode({ id: ui, filePath: "src/components/UserCard.tsx" }),
          mkNode({ id: fetcher, filePath: "src/services/userService.ts" }),
          mkNode({ id: dbFn, filePath: "src/db/users.ts" }),
        ],
        edges: [
          mkEdge({ from: ui, to: fetcher, line: 23, column: 5 }),
          mkEdge({ from: fetcher, to: dbFn, line: 10, column: 2 }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const v = r.violations.find((x) => x.group_id === ui);
    expect(v?.rule_id).toBe("effect.NO_IO_IN_UI.forbidden_effect");
    expect(v?.cause.detail).toContain("direct_effects_on_node: []");
    expect(v?.cause.detail).toContain("inherited_effects: [db.read]");
    expect(v?.cause.detail).toContain("propagation_chain:");
    expect(v?.cause.detail).toContain(`→ ${dbFn}`);
  });

  it("allow-only catches violations in a pure reducer", async () => {
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({
            target: ["src/util/**::*"],
            annotates: ["time.now"],
          }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "REDUCERS_PURE",
            targetScope: ["**/reducers/**::*"],
            allowOnly: [],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [
          mkNode({ id: "src/reducers/order.ts::reduce(2)", filePath: "src/reducers/order.ts" }),
          mkNode({ id: "src/util/clock.ts::now(0)", filePath: "src/util/clock.ts" }),
        ],
        edges: [
          mkEdge({ from: "src/reducers/order.ts::reduce(2)", to: "src/util/clock.ts::now(0)" }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const v = r.violations.find((x) => x.rule_id === "effect.REDUCERS_PURE.disallowed_effect");
    expect(v).toBeDefined();
    expect(v?.cause.detail).toContain("allow_only: <none>");
  });
});

describe("evaluateEffects — suppression", () => {
  it("removes effect from initial set; downstream callers are clean", async () => {
    const ui = "src/components/UserCard.tsx::UserCard(0)";
    const cache = "src/cache/cached-get.ts::cachedGet(1)";

    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({
            target: [cache],
            annotates: ["db.read"],
          }),
        ],
        effectSuppressions: [
          mkEffectSuppression({
            target: cache,
            suppresses: ["db.read"],
            reason: "Cache wraps getUserFromDb; deliberate.",
          }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/components/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [
          mkNode({ id: ui, filePath: "src/components/UserCard.tsx" }),
          mkNode({ id: cache, filePath: "src/cache/cached-get.ts" }),
        ],
        edges: [mkEdge({ from: ui, to: cache })],
      }),
      extractor: new StubExtractor(),
    });
    expect(r.violations).toHaveLength(0);
    // The suppression-active notice must be present.
    const notice = r.notices.find((n) => n.rule_id === "effect.suppression_active");
    expect(notice).toBeDefined();
    expect(r.stats.suppressionsActive).toBe(1);
  });
});

describe("evaluateEffects — Round 2 D-CG-5 fail-closed (Closeout 1 per-policy gating)", () => {
  it("in-scope unresolved call still emits an error-severity violation", async () => {
    const node = mkNode({ id: "src/c/Q.tsx::Q(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/c/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({
            from: node.id,
            line: 30,
            column: 11,
            rawText: 'getattr(db, "query")()',
            reason: "reflection",
          }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const unresolvedHits = r.violations.filter(
      (x) => x.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(unresolvedHits).toHaveLength(1);
    expect(unresolvedHits[0]?.severity).toBe("error");
    expect(r.stats.unresolvedFailures).toBe(1);
  });

  it("out-of-scope unresolved call emits zero violations and zero notices", async () => {
    // Caller node lives in src/unrelated/** which is outside every policy
    // scope, so the per-policy gate skips emission entirely.
    const node = mkNode({
      id: "src/unrelated/helper.ts::dispatch(0)",
      filePath: "src/unrelated/helper.ts",
    });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/c/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 30, column: 11, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const violations = r.violations.filter(
      (x) => x.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    const notices = r.notices.filter(
      (x) => x.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(violations).toEqual([]);
    expect(notices).toEqual([]);
    expect(r.stats.unresolvedFailures).toBe(0);
  });

  it("unresolved call in overlap of two policy scopes emits exactly one violation (no per-policy duplication)", async () => {
    const node = mkNode({
      id: "src/overlap/area.ts::touch(0)",
      filePath: "src/overlap/area.ts",
    });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          // Both target-scopes match the same node.
          mkEffectPolicy({
            id: "AREA_RULE_A",
            targetScope: ["**/overlap/**::*"],
            forbid: ["db.*"],
          }),
          mkEffectPolicy({
            id: "AREA_RULE_B",
            targetScope: ["src/overlap/area.ts::*"],
            forbid: ["http.outgoing"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 17, column: 4, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const unresolvedHits = r.violations.filter(
      (x) => x.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(unresolvedHits).toHaveLength(1);
  });

  it("no contract policies → no unresolved-call emission anywhere on the graph", async () => {
    // Without policies there is no active scope, so the per-policy gate
    // suppresses every unresolved-call site. This replaces the prior
    // "strictMode default true" behaviour that emitted globally; under
    // Closeout 1 the principled behaviour is silence when no policy cares.
    const node = mkNode({ id: "src/c/Q.tsx::Q(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 30, column: 11, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    expect(r.stats.unresolvedFailures).toBe(0);
  });
});

describe("evaluateEffects — Closeout 1 EvaluateEffectOptions surface", () => {
  it("EvaluateEffectOptions has no `strictMode` field at the call site", async () => {
    // The argument object passed to evaluateEffects is a runtime witness
    // that the strictMode knob has been removed (Closeout 1). If anyone
    // re-adds the property they'll have to also re-add it here, which is
    // visible in a diff review.
    const options = {
      contract: mkContract({}),
      callGraph: mkCallGraph({ nodes: [], edges: [] }),
      extractor: new StubExtractor(),
    } as const;
    expect("strictMode" in options).toBe(false);
    const r = await evaluateEffects(options);
    expect(r.violations).toEqual([]);
  });
});

describe("evaluateEffects — Closeout 1 Category B: annotated nodes are closed-world", () => {
  it("in-scope unresolved call on a SOURCE-annotated node emits nothing", async () => {
    // The author declared `@stele:effects fs.read` on the caller. Even
    // though there is an unresolved callee in-scope, the author's
    // explicit declaration overrides the analyzer's uncertainty: we
    // trust the declaration and do not widen / emit.
    const node = mkNode({ id: "src/c/Q.tsx::handler(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "C_FORBIDS_HTTP",
            targetScope: ["src/c/**::*"],
            forbid: ["http.outgoing"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 12, column: 4, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(
        new Map<string, readonly string[]>([[node.id, ["db.read"]]]),
      ),
    });
    const unresolved = r.violations.filter(
      (v) => v.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(unresolved).toEqual([]);
    expect(r.stats.unresolvedFailures).toBe(0);
  });

  it("in-scope unresolved call on a CDL-annotated node emits nothing", async () => {
    // Same closed-world principle but the annotation comes from a CDL
    // `(effect-annotation ...)` declaration instead of source JSDoc.
    const node = mkNode({ id: "src/c/Q.tsx::handler(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({
            target: ["src/c/Q.tsx::handler(0)"],
            annotates: ["db.read"],
          }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "C_FORBIDS_HTTP",
            targetScope: ["src/c/**::*"],
            forbid: ["http.outgoing"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 12, column: 4, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(),
    });
    const unresolved = r.violations.filter(
      (v) => v.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(unresolved).toEqual([]);
    expect(r.stats.unresolvedFailures).toBe(0);
  });

  it("annotated node still fires policy violations for the DECLARED effects", async () => {
    // Closed-world means the analyzer trusts the declaration as the full
    // truth — but the declaration itself is still subject to per-policy
    // checks. An author who declares `http.outgoing` in a scope that
    // forbids it should still trip the forbid policy.
    const node = mkNode({ id: "src/c/Q.tsx::handler(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "C_FORBIDS_HTTP",
            targetScope: ["src/c/**::*"],
            forbid: ["http.outgoing"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [
          mkUnresolved({ from: node.id, line: 12, column: 4, reason: "dynamic" }),
        ],
      }),
      extractor: new StubExtractor(
        new Map<string, readonly string[]>([[node.id, ["http.outgoing"]]]),
      ),
    });
    const unresolved = r.violations.filter(
      (v) => v.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    const forbidHits = r.violations.filter(
      (v) => v.rule_id === "effect.C_FORBIDS_HTTP.forbidden_effect",
    );
    expect(unresolved).toEqual([]);
    expect(forbidHits).toHaveLength(1);
  });
});

describe("evaluateEffects — stats", () => {
  it("populates all stat fields", async () => {
    const node = mkNode({ id: "src/c/A.tsx::A(0)", filePath: "src/c/A.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "P1",
            targetScope: ["**/c/**::*"],
            forbid: ["db.read"],
          }),
          mkEffectPolicy({
            id: "P2",
            targetScope: ["**/c/**::*"],
            allowOnly: ["log.audit"],
          }),
        ],
      }),
      callGraph: mkCallGraph({ nodes: [node], edges: [] }),
      extractor: new StubExtractor(),
    });
    expect(r.stats.policiesEvaluated).toBe(2);
    expect(r.stats.nodesAnalyzed).toBe(1);
    expect(r.stats.unresolvedFailures).toBe(0);
    expect(r.stats.propagationRounds).toBeGreaterThan(0);
    expect(r.stats.suppressionsActive).toBe(0);
  });
});

describe("evaluateEffects — multi-policy isolation", () => {
  it("each policy emits its own violations independently", async () => {
    const ui = mkNode({ id: "src/c/A.tsx::A(0)", filePath: "src/c/A.tsx" });
    const lib = mkNode({ id: "src/lib/pure/B.ts::B(0)", filePath: "src/lib/pure/B.ts" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({ target: [ui.id], annotates: ["db.read"] }),
          mkEffectAnnotation({ target: [lib.id], annotates: ["time.now"] }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/c/**::*"],
            forbid: ["db.*"],
          }),
          mkEffectPolicy({
            id: "PURE_LIB",
            targetScope: ["**/lib/pure/**::*"],
            allowOnly: [],
          }),
        ],
      }),
      callGraph: mkCallGraph({ nodes: [ui, lib], edges: [] }),
      extractor: new StubExtractor(),
    });
    const noIO = r.violations.find((v) => v.rule_id === "effect.NO_IO_IN_UI.forbidden_effect");
    const pure = r.violations.find((v) => v.rule_id === "effect.PURE_LIB.disallowed_effect");
    expect(noIO).toBeDefined();
    expect(pure).toBeDefined();
  });
});

describe("evaluateEffects — fix-hint A/B enforcement (Round 2 MC-15)", () => {
  it("every violation's fix-hint contains code issue + contract issue + propose + [A] + [B]", async () => {
    const ui = mkNode({ id: "src/c/A.tsx::A(0)", filePath: "src/c/A.tsx" });
    const dbFn = mkNode({ id: "src/db/users.ts::g(1)", filePath: "src/db/users.ts" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({ target: [dbFn.id], annotates: ["db.read"] }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/c/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [ui, dbFn],
        edges: [mkEdge({ from: ui.id, to: dbFn.id })],
      }),
      extractor: new StubExtractor(),
    });
    expect(r.violations.length).toBeGreaterThan(0);
    for (const v of r.violations) {
      const fix = v.fix?.summary ?? "";
      expect(fix).toMatch(/\bcode\s+issue\b/i);
      expect(fix).toMatch(/\bcontract\s+issue\b/i);
      expect(fix).toMatch(/\bpropose\b/i);
      expect(fix).toMatch(/\[A\]/);
      expect(fix).toMatch(/\[B\]/);
    }
  });
});

describe("evaluateEffects — determinism", () => {
  it("two runs produce the same fingerprint set", async () => {
    const ui = mkNode({ id: "src/c/A.tsx::A(0)", filePath: "src/c/A.tsx" });
    const dbFn = mkNode({ id: "src/db/users.ts::g(1)", filePath: "src/db/users.ts" });
    const contract = mkContract({
      effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
      effectAnnotations: [
        mkEffectAnnotation({ target: [dbFn.id], annotates: ["db.read"] }),
      ],
      effectPolicies: [
        mkEffectPolicy({
          id: "NO_IO_IN_UI",
          targetScope: ["**/c/**::*"],
          forbid: ["db.*"],
        }),
      ],
    });
    const callGraph = mkCallGraph({
      nodes: [ui, dbFn],
      edges: [mkEdge({ from: ui.id, to: dbFn.id })],
    });
    const a = await evaluateEffects({ contract, callGraph, extractor: new StubExtractor() });
    const b = await evaluateEffects({ contract, callGraph, extractor: new StubExtractor() });
    const fingerprintsA = a.violations.map((v) => v.fingerprint).sort();
    const fingerprintsB = b.violations.map((v) => v.fingerprint).sort();
    expect(fingerprintsA).toEqual(fingerprintsB);
  });
});

describe("evaluateEffects — performance smoke", () => {
  it("100-node graph + 10 policies completes in < 500ms", async () => {
    const nodes = Array.from({ length: 100 }, (_, i) =>
      mkNode({ id: `src/p/n${i}.ts::n${i}(0)`, filePath: `src/p/n${i}.ts` }),
    );
    // Linear chain of edges + a few cross edges.
    const edges = [];
    for (let i = 0; i < 99; i += 1) {
      edges.push(mkEdge({ from: `src/p/n${i}.ts::n${i}(0)`, to: `src/p/n${i + 1}.ts::n${i + 1}(0)` }));
    }
    const policies = Array.from({ length: 10 }, (_, i) =>
      mkEffectPolicy({
        id: `P${i}`,
        targetScope: ["**/p/**::*"],
        forbid: [i % 2 === 0 ? "db.read" : "http.outgoing"],
      }),
    );
    const contract = mkContract({
      effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
      effectAnnotations: [
        mkEffectAnnotation({
          target: ["src/p/n99.ts::n99(0)"],
          annotates: ["db.read"],
        }),
      ],
      effectPolicies: policies,
    });
    const cg = mkCallGraph({ nodes, edges });
    const start = Date.now();
    const r = await evaluateEffects({
      contract,
      callGraph: cg,
      extractor: new StubExtractor(),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // 10 policies × 100 nodes × {db.read inherited} → some violations
    expect(r.violations.length).toBeGreaterThan(0);
  });
});

describe("evaluateEffects — in-scope unresolved is always an error", () => {
  it("an in-scope unresolved-call site fires error severity regardless of any flag", async () => {
    const node = mkNode({ id: "src/c/Q.tsx::Q(0)", filePath: "src/c/Q.tsx" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectPolicies: [
          mkEffectPolicy({
            id: "C_LAYER_FORBIDS_DB",
            targetScope: ["src/c/**::*"],
            forbid: ["db.read"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [node],
        edges: [],
        unresolvedCalls: [mkUnresolved({ from: node.id })],
      }),
      extractor: new StubExtractor(),
    });
    const unresolved = r.violations.filter(
      (v) => v.rule_id === "effect.unresolved_call_blocks_evaluation",
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.severity).toBe("error");
  });
});

describe("evaluateEffects — dormant suppression", () => {
  it("emits notice when suppression target NodeId is absent from the graph", async () => {
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectSuppressions: [
          mkEffectSuppression({
            target: "src/dead/code.ts::dead(0)",
            suppresses: ["db.read"],
            reason: "Dead code that should still record intent",
          }),
        ],
      }),
      callGraph: mkCallGraph({ nodes: [], edges: [] }),
      extractor: new StubExtractor(),
    });
    const dormant = r.notices.find((n) => n.rule_id === "effect.suppression_dormant");
    expect(dormant).toBeDefined();
  });
});

describe("evaluateEffects — extractor wiring", () => {
  it("extractor is called exactly once with projectRoot from callGraph", async () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/x.ts::x(0)" })],
      edges: [],
      projectRoot: "/srv/app",
    });
    const ex = new StubExtractor();
    await evaluateEffects({
      contract: mkContract({}),
      callGraph: cg,
      extractor: ex,
    });
    expect(ex.callCount).toBe(1);
    expect(ex.lastOptions?.projectRoot).toBe("/srv/app");
  });
});

describe("evaluateEffects — propagation root surfaced in evidence", () => {
  it("violation contains propagation_root_nodes pointing at declarer", async () => {
    const ui = mkNode({ id: "src/c/A.tsx::A(0)", filePath: "src/c/A.tsx" });
    const dbFn = mkNode({ id: "src/db/x.ts::g(1)", filePath: "src/db/x.ts" });
    const r = await evaluateEffects({
      contract: mkContract({
        effectDeclarations: [mkEffectDeclarations(ALL_EFFECTS)],
        effectAnnotations: [
          mkEffectAnnotation({ target: [dbFn.id], annotates: ["db.read"] }),
        ],
        effectPolicies: [
          mkEffectPolicy({
            id: "NO_IO_IN_UI",
            targetScope: ["**/c/**::*"],
            forbid: ["db.*"],
          }),
        ],
      }),
      callGraph: mkCallGraph({
        nodes: [ui, dbFn],
        edges: [mkEdge({ from: ui.id, to: dbFn.id })],
      }),
      extractor: new StubExtractor(),
    });
    const v = r.violations.find((x) => x.group_id === ui.id);
    expect(v?.cause.detail).toContain(
      `propagation_root_nodes: [${dbFn.id}]`,
    );
  });
});
