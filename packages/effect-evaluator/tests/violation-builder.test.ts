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
