import { describe, expect, it } from "vitest";

import {
  checkAllowOnly,
  checkForbid,
  resolveScopeNodes,
} from "../src/policy-check.js";
import {
  mkCallGraph,
  mkEffectPolicy,
  mkNode,
} from "./fixtures/helpers.js";

const DECLARED = new Set([
  "db.read",
  "db.write",
  "http.outgoing",
  "payment.charge",
  "payment.refund",
  "log.audit",
]);

function setMap(
  entries: ReadonlyArray<readonly [string, readonly string[]]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, eff] of entries) {
    out.set(id, new Set(eff));
  }
  return out;
}

describe("checkForbid", () => {
  it("emits a match when scope node has forbidden effect", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/components/UserCard.tsx::UserCard(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "NO_IO_IN_UI",
      targetScope: ["**/components/**::*"],
      forbid: ["db.read"],
    });
    const effective = setMap([
      ["src/components/UserCard.tsx::UserCard(0)", ["db.read"]],
    ]);
    const direct = setMap([
      ["src/components/UserCard.tsx::UserCard(0)", []],
    ]);

    const matches = checkForbid({
      policy,
      callGraph: cg,
      effectiveByNode: effective,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.offendingEffect).toBe("db.read");
    expect(matches[0]?.directOnNode).toBe(false);
  });

  it("emits no match when node has none of the forbidden effects", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/components/Card.tsx::Card(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "NO_IO_IN_UI",
      targetScope: ["**/components/**::*"],
      forbid: ["db.read", "http.outgoing"],
    });
    const matches = checkForbid({
      policy,
      callGraph: cg,
      effectiveByNode: setMap([["src/components/Card.tsx::Card(0)", []]]),
      directByNode: setMap([["src/components/Card.tsx::Card(0)", []]]),
      declaredEffects: DECLARED,
    });
    expect(matches).toHaveLength(0);
  });

  it("supports effect-glob in forbid: `payment.*` matches both charge and refund", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/components/Pay.tsx::Pay(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "NO_PAY_IN_UI",
      targetScope: ["**/components/**::*"],
      forbid: ["payment.*"],
    });
    const effective = setMap([
      [
        "src/components/Pay.tsx::Pay(0)",
        ["payment.charge", "payment.refund", "db.read"],
      ],
    ]);
    const direct = setMap([
      ["src/components/Pay.tsx::Pay(0)", []],
    ]);
    const matches = checkForbid({
      policy,
      callGraph: cg,
      effectiveByNode: effective,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    const effects = matches.map((m) => m.offendingEffect).sort();
    expect(effects).toEqual(["payment.charge", "payment.refund"]);
  });

  it("scope pattern restricts to matching nodes only", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "src/components/A.tsx::A(0)" }),
        mkNode({ id: "src/services/B.ts::B(0)" }),
      ],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "P",
      targetScope: ["**/components/**::*"],
      forbid: ["db.read"],
    });
    const effective = setMap([
      ["src/components/A.tsx::A(0)", ["db.read"]],
      ["src/services/B.ts::B(0)", ["db.read"]],
    ]);
    const direct = setMap([
      ["src/components/A.tsx::A(0)", []],
      ["src/services/B.ts::B(0)", []],
    ]);
    const matches = checkForbid({
      policy,
      callGraph: cg,
      effectiveByNode: effective,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.id).toBe("src/components/A.tsx::A(0)");
  });

  it("directOnNode flag is true when offending effect is in direct set", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/c/Q.ts::Q(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "P",
      targetScope: ["**/c/**::*"],
      forbid: ["db.read"],
    });
    const matches = checkForbid({
      policy,
      callGraph: cg,
      effectiveByNode: setMap([["src/c/Q.ts::Q(0)", ["db.read"]]]),
      directByNode: setMap([["src/c/Q.ts::Q(0)", ["db.read"]]]),
      declaredEffects: DECLARED,
    });
    expect(matches[0]?.directOnNode).toBe(true);
  });
});

describe("checkAllowOnly", () => {
  it("violation when scope node has effect outside allow-only", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/lib/pure/util.ts::util(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "PURE_LIB",
      targetScope: ["**/lib/pure/**::*"],
      allowOnly: ["log.audit"],
    });
    const effective = setMap([
      ["src/lib/pure/util.ts::util(0)", ["db.read", "log.audit"]],
    ]);
    const direct = setMap([
      ["src/lib/pure/util.ts::util(0)", []],
    ]);
    const matches = checkAllowOnly({
      policy,
      callGraph: cg,
      effectiveByNode: effective,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.offendingEffect).toBe("db.read");
  });

  it("empty allow-only = nothing allowed: any reachable effect violates", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/reducers/x.ts::x(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "REDUCERS_PURE",
      targetScope: ["**/reducers/**::*"],
      allowOnly: [],
    });
    const matches = checkAllowOnly({
      policy,
      callGraph: cg,
      effectiveByNode: setMap([["src/reducers/x.ts::x(0)", ["time.now"]]]),
      directByNode: setMap([["src/reducers/x.ts::x(0)", ["time.now"]]]),
      declaredEffects: DECLARED,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.offendingEffect).toBe("time.now");
  });

  it("returns empty when scope is empty", () => {
    const cg = mkCallGraph({ nodes: [], edges: [] });
    const policy = mkEffectPolicy({
      id: "P",
      targetScope: ["**/none/**::*"],
      allowOnly: ["log.audit"],
    });
    expect(
      checkAllowOnly({
        policy,
        callGraph: cg,
        effectiveByNode: setMap([]),
        directByNode: setMap([]),
        declaredEffects: DECLARED,
      }),
    ).toEqual([]);
  });

  it("allow-only with glob `db.*` accepts both db.read and db.write", () => {
    const cg = mkCallGraph({
      nodes: [mkNode({ id: "src/svc/q.ts::q(0)" })],
      edges: [],
    });
    const policy = mkEffectPolicy({
      id: "DB_LAYER",
      targetScope: ["**/svc/**::*"],
      allowOnly: ["db.*"],
    });
    const matches = checkAllowOnly({
      policy,
      callGraph: cg,
      effectiveByNode: setMap([["src/svc/q.ts::q(0)", ["db.read", "db.write"]]]),
      directByNode: setMap([["src/svc/q.ts::q(0)", []]]),
      declaredEffects: DECLARED,
    });
    expect(matches).toEqual([]);
  });
});

describe("multi-policy isolation", () => {
  it("each policy evaluated independently", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "src/ui/A.tsx::A(0)" }),
        mkNode({ id: "src/lib/pure/B.ts::B(0)" }),
      ],
      edges: [],
    });
    const noIO = mkEffectPolicy({
      id: "NO_IO_IN_UI",
      targetScope: ["**/ui/**::*"],
      forbid: ["db.*"],
    });
    const pureLib = mkEffectPolicy({
      id: "PURE_LIB",
      targetScope: ["**/lib/pure/**::*"],
      allowOnly: [],
    });
    const eff = setMap([
      ["src/ui/A.tsx::A(0)", ["db.read"]],
      ["src/lib/pure/B.ts::B(0)", ["time.now"]],
    ]);
    const direct = setMap([
      ["src/ui/A.tsx::A(0)", []],
      ["src/lib/pure/B.ts::B(0)", []],
    ]);
    const f = checkForbid({
      policy: noIO,
      callGraph: cg,
      effectiveByNode: eff,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    const a = checkAllowOnly({
      policy: pureLib,
      callGraph: cg,
      effectiveByNode: eff,
      directByNode: direct,
      declaredEffects: DECLARED,
    });
    expect(f).toHaveLength(1);
    expect(a).toHaveLength(1);
    expect(f[0]?.node.id).toBe("src/ui/A.tsx::A(0)");
    expect(a[0]?.node.id).toBe("src/lib/pure/B.ts::B(0)");
  });
});

describe("resolveScopeNodes", () => {
  it("returns deterministic sorted list of matching node ids", () => {
    const cg = mkCallGraph({
      nodes: [
        mkNode({ id: "src/components/B.tsx::B(0)" }),
        mkNode({ id: "src/components/A.tsx::A(0)" }),
        mkNode({ id: "src/services/X.ts::X(0)" }),
      ],
      edges: [],
    });
    const ids = resolveScopeNodes(cg, ["**/components/**::*"]);
    expect(ids).toEqual([
      "src/components/A.tsx::A(0)",
      "src/components/B.tsx::B(0)",
    ]);
  });
});
