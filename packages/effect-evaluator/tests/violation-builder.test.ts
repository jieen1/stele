import { describe, expect, it } from "vitest";

import {
  buildDisallowedEffectViolation,
  buildForbiddenEffectViolation,
  buildUnresolvedCallViolation,
  defaultPriority,
} from "../src/violation-builder.js";
import type { PropagationEvidence } from "../src/types.js";
import {
  mkCallGraph,
  mkEdge,
  mkEffectPolicy,
  mkNode,
  mkUnresolved,
} from "./fixtures/helpers.js";

const POLICY = mkEffectPolicy({
  id: "NO_IO_IN_UI",
  targetScope: ["**/components/**::*"],
  forbid: ["db.read", "http.outgoing"],
});

const NODE = mkNode({
  id: "src/components/UserCard.tsx::UserCard(0)",
  filePath: "src/components/UserCard.tsx",
  line: 23,
  column: 5,
});

function basicEvidence(
  offending: string,
  direct: boolean,
  chain: readonly string[],
): PropagationEvidence {
  return {
    offendingEffect: offending,
    directEffectsOnNode: direct ? [offending] : [],
    inheritedEffects: direct ? [] : [offending],
    propagationRootNodes:
      chain.length === 0 ? [] : [chain[chain.length - 1] as string],
    propagationChain: chain,
  };
}

describe("buildForbiddenEffectViolation", () => {
  const cg = mkCallGraph({
    nodes: [
      NODE,
      mkNode({ id: "src/db/users.ts::getUserFromDb(1)", filePath: "src/db/users.ts" }),
    ],
    edges: [
      mkEdge({
        from: NODE.id,
        to: "src/db/users.ts::getUserFromDb(1)",
        line: 23,
        column: 5,
      }),
    ],
  });

  const evidence = basicEvidence("db.read", false, [
    NODE.id,
    "src/db/users.ts::getUserFromDb(1)",
  ]);

  const v = buildForbiddenEffectViolation({
    policy: POLICY,
    node: NODE,
    evidence,
    callGraph: cg,
    directOnNode: false,
  });

  it("uses rule_id `effect.<policy>.forbidden_effect`", () => {
    expect(v.rule_id).toBe("effect.NO_IO_IN_UI.forbidden_effect");
  });

  it("rule_kind is effect_violation", () => {
    expect(v.rule_kind).toBe("effect_violation");
  });

  it("priority defaults to `blocking`", () => {
    expect(v.priority).toBe("blocking");
  });

  it("group_id is the offending node's NodeId", () => {
    expect(v.group_id).toBe(NODE.id);
  });

  it("location matches caller node span", () => {
    expect(v.location.path).toBe(NODE.filePath);
    expect(v.location.line).toBe(NODE.span.line);
    expect(v.location.column).toBe(NODE.span.column);
  });

  it("cause.detail contains direct/inherited split", () => {
    expect(v.cause.detail).toContain("direct_effects_on_node: []");
    expect(v.cause.detail).toContain("inherited_effects: [db.read]");
  });

  it("cause.detail contains propagation_chain", () => {
    expect(v.cause.detail).toContain("propagation_chain:");
    expect(v.cause.detail).toContain("→ src/db/users.ts::getUserFromDb(1)");
    expect(v.cause.detail).toContain("[declares: db.read]");
  });

  it("fingerprint is deterministic across rebuilds", () => {
    const v2 = buildForbiddenEffectViolation({
      policy: POLICY,
      node: NODE,
      evidence,
      callGraph: cg,
      directOnNode: false,
    });
    expect(v2.fingerprint).toBe(v.fingerprint);
  });

  // Round 3 P1-6: typed effect_evidence field is populated alongside the
  // free-text cause.detail rendering.
  it("populates the first-class typed effect_evidence field", () => {
    expect(v.effect_evidence).toBeDefined();
    expect(v.effect_evidence!.offending_effect).toBe("db.read");
    expect(v.effect_evidence!.inherited_effects).toEqual(["db.read"]);
    expect(v.effect_evidence!.direct_effects_on_node).toEqual([]);
    expect(v.effect_evidence!.propagation_chain).toEqual([
      NODE.id,
      "src/db/users.ts::getUserFromDb(1)",
    ]);
    expect(v.effect_evidence!.propagation_root_nodes).toEqual([
      "src/db/users.ts::getUserFromDb(1)",
    ]);
  });

  // Round 3 P1-5 (Round 2 E-P2-3): propagation_chain rendering caps at 5 hops.
  it("collapses propagation_chain when it exceeds the render cap", () => {
    const longChain = [
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
      "src/c.ts::C(0)",
      "src/d.ts::D(0)",
      "src/e.ts::E(0)",
      "src/f.ts::F(0)",
      "src/g.ts::G(0)",
      "src/h.ts::H(0)", // 8 hops total → caps at 5 rendered (4 head + 1 root)
    ];
    const longEvidence = basicEvidence("db.read", false, longChain);
    const cgLong = mkCallGraph({ nodes: [NODE], edges: [] });
    const v = buildForbiddenEffectViolation({
      policy: POLICY,
      node: NODE,
      evidence: longEvidence,
      callGraph: cgLong,
      directOnNode: false,
    });
    expect(v.cause.detail).toContain("propagation_chain:");
    // Head — first 4 hops (cap - 1) preserved verbatim.
    expect(v.cause.detail).toContain("→ src/a.ts::A(0)");
    expect(v.cause.detail).toContain("→ src/b.ts::B(0)");
    expect(v.cause.detail).toContain("→ src/c.ts::C(0)");
    expect(v.cause.detail).toContain("→ src/d.ts::D(0)");
    // The 3 middle hops are collapsed (8 total − 4 head − 1 root = 3).
    expect(v.cause.detail).toContain("[... 3 more callees");
    expect(v.cause.detail).toContain(
      "stele explain effect src/h.ts::H(0)",
    );
    // Root preserved with the declares-marker.
    expect(v.cause.detail).toContain("→ src/h.ts::H(0) [declares: db.read]");
    // None of the middle ids should appear in the rendered chain.
    expect(v.cause.detail).not.toContain("src/e.ts::E(0)");
    expect(v.cause.detail).not.toContain("src/f.ts::F(0)");
    expect(v.cause.detail).not.toContain("src/g.ts::G(0)");
  });

  // Round 4 D-11: with cap=5, head=4, tail=1, a length-6 chain has
  // collapsedCount=1 and the collapse marker would be longer than the
  // single hop it replaces. In that case render the hop verbatim.
  it("renders length-6 chain verbatim instead of [... 1 more callees] marker (D-11)", () => {
    const sixChain = [
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
      "src/c.ts::C(0)",
      "src/d.ts::D(0)",
      "src/e.ts::E(0)",
      "src/f.ts::F(0)",
    ];
    const ev = basicEvidence("db.read", false, sixChain);
    const cgSix = mkCallGraph({ nodes: [NODE], edges: [] });
    const v = buildForbiddenEffectViolation({
      policy: POLICY,
      node: NODE,
      evidence: ev,
      callGraph: cgSix,
      directOnNode: false,
    });
    // No collapse marker.
    expect(v.cause.detail).not.toContain("more callees");
    // Every hop rendered verbatim (no skipped middle).
    for (const id of sixChain) {
      expect(v.cause.detail).toContain(`→ ${id}`);
    }
  });

  it("renders chains at or under cap verbatim with no collapse marker", () => {
    const fiveChain = [
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
      "src/c.ts::C(0)",
      "src/d.ts::D(0)",
      "src/e.ts::E(0)",
    ];
    const ev = basicEvidence("db.read", false, fiveChain);
    const cgShort = mkCallGraph({ nodes: [NODE], edges: [] });
    const v = buildForbiddenEffectViolation({
      policy: POLICY,
      node: NODE,
      evidence: ev,
      callGraph: cgShort,
      directOnNode: false,
    });
    expect(v.cause.detail).not.toContain("more callees");
    for (const id of fiveChain) {
      expect(v.cause.detail).toContain(`→ ${id}`);
    }
  });

  it("policy.fixHint overrides the default fix-hint", () => {
    const custom = mkEffectPolicy({
      id: POLICY.id,
      targetScope: POLICY.targetScope as string[],
      forbid: ["db.read"],
      fixHint: "See `src/db/users.ts::getUserFromDb(1)` and refactor at src/components/UserCard.tsx:23.",
    });
    const v3 = buildForbiddenEffectViolation({
      policy: custom,
      node: NODE,
      evidence,
      callGraph: cg,
      directOnNode: false,
    });
    expect(v3.fix?.summary).toContain("See `src/db/users.ts");
  });
});

describe("buildDisallowedEffectViolation", () => {
  const cg = mkCallGraph({ nodes: [NODE], edges: [] });
  const policy = mkEffectPolicy({
    id: "PURE_LIB",
    targetScope: ["**/lib/pure/**::*"],
    allowOnly: ["log.audit"],
  });
  const evidence = basicEvidence("db.read", true, [NODE.id]);
  const v = buildDisallowedEffectViolation({
    policy,
    node: NODE,
    evidence,
    callGraph: cg,
    allowOnly: ["log.audit"],
    directOnNode: true,
  });

  it("uses rule_id `effect.<policy>.disallowed_effect`", () => {
    expect(v.rule_id).toBe("effect.PURE_LIB.disallowed_effect");
  });

  it("renders allow_only inside cause.detail", () => {
    expect(v.cause.detail).toContain("allow_only: [log.audit]");
  });

  it("renders empty allow_only as `<none>`", () => {
    const v2 = buildDisallowedEffectViolation({
      policy: { ...policy, allowOnly: [] },
      node: NODE,
      evidence,
      callGraph: cg,
      allowOnly: [],
      directOnNode: true,
    });
    expect(v2.cause.detail).toContain("allow_only: <none>");
  });
});

describe("buildUnresolvedCallViolation", () => {
  const cg = mkCallGraph({
    nodes: [NODE],
    edges: [],
    unresolvedCalls: [
      mkUnresolved({ from: NODE.id, line: 30, column: 11, rawText: "dynamic()" }),
    ],
  });

  it("strictMode=true emits severity=error", () => {
    const v = buildUnresolvedCallViolation({
      policy: undefined,
      node: NODE,
      unresolved: cg.unresolvedCalls[0] ?? mkUnresolved({ from: NODE.id }),
      callGraph: cg,
      strictMode: true,
    });
    expect(v.severity).toBe("error");
    expect(v.rule_id).toBe("effect.unresolved_call_blocks_evaluation");
  });

  it("strictMode=false emits severity=warning", () => {
    const v = buildUnresolvedCallViolation({
      policy: undefined,
      node: NODE,
      unresolved: cg.unresolvedCalls[0] ?? mkUnresolved({ from: NODE.id }),
      callGraph: cg,
      strictMode: false,
    });
    expect(v.severity).toBe("warning");
  });

  it("priority is `major`", () => {
    const v = buildUnresolvedCallViolation({
      policy: undefined,
      node: NODE,
      unresolved: cg.unresolvedCalls[0] ?? mkUnresolved({ from: NODE.id }),
      callGraph: cg,
      strictMode: true,
    });
    expect(v.priority).toBe("major");
  });
});

describe("defaultPriority", () => {
  it("returns blocking for forbidden_effect", () => {
    expect(defaultPriority("forbidden_effect")).toBe("blocking");
  });

  it("returns blocking for disallowed_effect", () => {
    expect(defaultPriority("disallowed_effect")).toBe("blocking");
  });

  it("returns major for unresolved_call_blocks_evaluation", () => {
    expect(defaultPriority("unresolved_call_blocks_evaluation")).toBe("major");
  });
});
