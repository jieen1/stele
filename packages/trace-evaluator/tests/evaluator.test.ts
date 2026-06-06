import { describe, expect, it } from "vitest";

import type { CallGraphEdge, CallGraphNode } from "@stele/call-graph-core";

import { evaluateTracePolicies } from "../src/evaluator.js";
import {
  mkCallGraph,
  mkContract,
  mkEdge,
  mkNode,
  mkPolicy,
  mkUnresolved,
} from "./fixtures/helpers.js";

const CTRL = "src/controllers/order.ts::OrderController::handle(0)";
const SVC = "src/services/order.ts::OrderService::run(0)";
const REPO = "src/repository/orders.ts::OrderRepository::find(1)";
const DB = "src/db/users.ts::Db::query(1)";

function ctrlGraph(opts?: {
  extraNodes?: readonly CallGraphNode[];
  extraEdges?: readonly CallGraphEdge[];
}) {
  return mkCallGraph({
    nodes: [
      mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
      mkNode({ id: SVC, filePath: "src/services/order.ts" }),
      mkNode({ id: REPO, filePath: "src/repository/orders.ts" }),
      mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ...(opts?.extraNodes ?? []),
    ],
    edges: opts?.extraEdges ?? [],
  });
}

describe("evaluateTracePolicies — must-transit (DB via Repository)", () => {
  const policy = mkPolicy({
    id: "DB_VIA_REPO",
    target: ["src/db/**::*"],
    mustTransit: ["**::OrderRepository::*"],
    // Repository itself is allowed to call DB directly (it IS the transit
    // layer); only non-repository callers need to transit through it.
    exempt: [{ pattern: "**::OrderRepository::*", reason: "is the transit layer" }],
    fixHint: "Route DB access through `Repository.find` in {actual_file}:{actual_line}",
  });

  it("emits violation when controller calls Db directly", () => {
    const graph = ctrlGraph({
      extraEdges: [mkEdge({ from: CTRL, to: DB, line: 5 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("trace.DB_VIA_REPO.missing_transit");
    expect(result.violations[0]!.group_id).toBe(CTRL);
    expect(result.violations[0]!.severity).toBe("error");
  });

  it("emits zero violations when controller goes through repository", () => {
    const graph = ctrlGraph({
      extraEdges: [
        mkEdge({ from: CTRL, to: SVC }),
        mkEdge({ from: SVC, to: REPO }),
        mkEdge({ from: REPO, to: DB }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });

  it("substitutes fix-hint placeholders", () => {
    const graph = ctrlGraph({
      extraEdges: [mkEdge({ from: CTRL, to: DB, line: 42 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations[0]!.fix?.summary).toContain("Repository.find");
    expect(result.violations[0]!.fix?.summary).toContain("src/controllers/order.ts:42");
  });
});

describe("evaluateTracePolicies — deny-direct", () => {
  const policy = mkPolicy({
    id: "NO_DIRECT_DB",
    target: ["src/db/**::*"],
    denyDirect: ["**/controllers/**::*"],
    fixHint: "Do not call `Db.query` directly from controller (src/controllers/order.ts:5).",
  });

  it("flags direct controller -> Db", () => {
    const graph = ctrlGraph({
      extraEdges: [mkEdge({ from: CTRL, to: DB })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("trace.NO_DIRECT_DB.direct_call_denied");
  });

  it("does NOT flag controller -> svc -> repo -> Db (indirect)", () => {
    const graph = ctrlGraph({
      extraEdges: [
        mkEdge({ from: CTRL, to: SVC }),
        mkEdge({ from: SVC, to: REPO }),
        mkEdge({ from: REPO, to: DB }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });
});

describe("evaluateTracePolicies — deny-transit", () => {
  const FORBIDDEN = "src/cache/unsafe.ts::CacheUnsafe::write(0)";
  const policy = mkPolicy({
    id: "NO_UNSAFE_CACHE",
    target: ["src/db/**::*"],
    denyTransit: ["**::CacheUnsafe::*"],
    fixHint: "Drop `CacheUnsafe.write` from the call chain.",
  });

  it("flags forbidden intermediate", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL }),
        mkNode({ id: FORBIDDEN }),
        mkNode({ id: DB }),
      ],
      edges: [
        mkEdge({ from: CTRL, to: FORBIDDEN }),
        mkEdge({ from: FORBIDDEN, to: DB }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("trace.NO_UNSAFE_CACHE.forbidden_transit");
  });

  it("does not flag a clean path", () => {
    const graph = ctrlGraph({
      extraEdges: [
        mkEdge({ from: CTRL, to: SVC }),
        mkEdge({ from: SVC, to: DB }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });
});

describe("evaluateTracePolicies — must-be-preceded-by", () => {
  const STRIPE = "extern:stripe::Charges::create(2)";
  const VERIFY = "src/permission/verify.ts::permission::verify(2)";
  const AUDIT = "src/audit/write.ts::audit::write(1)";
  const CALLER = "src/services/pay.ts::PayService::fastPay(1)";

  const policy = mkPolicy({
    id: "PAYMENT_GUARD",
    target: ["extern:stripe::*"],
    mustBePrecededBy: ["**::permission::verify(*)"],
    fixHint: "Insert `await permission.verify(...)` before `{target_call}` in {actual_file}:{actual_line}",
  });

  it("emits blocking violation when verify missing before stripe.charge", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: VERIFY, filePath: "src/permission/verify.ts" }),
      ],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("trace.PAYMENT_GUARD.missing_predecessor");
    expect(result.violations[0]!.priority).toBe("blocking");
    expect(result.violations[0]!.location.line).toBe(17);
    expect(result.violations[0]!.fix?.summary).toContain("permission.verify");
  });

  it("emits zero when verify appears before stripe.charge", () => {
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: VERIFY, filePath: "src/permission/verify.ts" }),
      ],
      edges: [
        mkEdge({ from: CALLER, to: VERIFY, line: 10, column: 5 }),
        mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });

  it("emits successor violation when must-be-followed-by audit missing", () => {
    const policyFollow = mkPolicy({
      id: "PAYMENT_AUDIT",
      target: ["extern:stripe::*"],
      mustBeFollowedBy: ["**::audit::write(*)"],
      fixHint: "Insert `await audit.write(...)` after `{target_call}` in {actual_file}:{actual_line}",
    });
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: AUDIT, filePath: "src/audit/write.ts" }),
      ],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policyFollow]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("trace.PAYMENT_AUDIT.missing_successor");
    expect(result.violations[0]!.priority).toBe("major");
  });
});

describe("evaluateTracePolicies — scope & exempt", () => {
  it("scope narrowing: caller outside scope does not violate even on direct call", () => {
    const helper = "src/util/helper.ts::helper(0)";
    const policy = mkPolicy({
      id: "DB_FROM_CTRL_ONLY",
      target: ["src/db/**::*"],
      denyDirect: ["**::*"],
      scope: ["**/controllers/**::*"],
      fixHint: "Avoid calling `Db.query` directly from controllers (see src/controllers/x.ts:1).",
    });
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: helper, filePath: "src/util/helper.ts" }),
        mkNode({ id: DB, filePath: "src/db/users.ts" }),
      ],
      edges: [mkEdge({ from: helper, to: DB })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });

  it("exempt caller is not flagged", () => {
    const policy = mkPolicy({
      id: "DB_VIA_REPO_EXEMPT",
      target: ["src/db/**::*"],
      mustTransit: ["**::OrderRepository::*"],
      exempt: [{ pattern: "**::OrderController::*", reason: "migration tool" }],
      fixHint: "Route via `Repository` in src/services/x.ts:1",
    });
    const graph = ctrlGraph({
      extraEdges: [mkEdge({ from: CTRL, to: DB })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });
});

describe("evaluateTracePolicies — path_exceeded_max_depth (strict vs lenient)", () => {
  function buildDepthCapFixture() {
    // Chain A -> B -> C -> D -> E -> F  with maxDepth=3
    const chain = ["A", "B", "C", "D", "E", "F"].map((n) =>
      mkNode({ id: `src/${n.toLowerCase()}.ts::${n}(0)`, filePath: `src/${n.toLowerCase()}.ts` }),
    );
    const edges: CallGraphEdge[] = [];
    for (let i = 0; i < chain.length - 1; i += 1) {
      edges.push(mkEdge({ from: chain[i]!.id, to: chain[i + 1]!.id }));
    }
    const graph = mkCallGraph({ nodes: chain, edges });
    const policy = mkPolicy({
      id: "DEEP_RULE",
      target: ["src/f.ts::F(*)"],
      mustTransit: ["src/c.ts::C(*)"],
      // Scope the rule to A only; otherwise nearer callers (D, E) emit
      // their own missing_transit violations on shorter paths.
      scope: ["src/a.ts::A(*)"],
      fixHint: "Shorten the chain — see `src/a.ts:1`.",
    });
    return { graph, policy };
  }

  it("strict mode (default): truncation surfaces as a violation at policy severity", () => {
    // Round 3 P0-5: in strict mode, the analyzer cannot prove the rule holds
    // for the truncated paths, so the depth-cap event MUST surface as a
    // first-class violation at the policy's severity, not a downgraded notice.
    const { graph, policy } = buildDepthCapFixture();
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
      maxDepth: 3,
    });
    const depthCap = result.violations.find(
      (v) => v.rule_id === "trace.DEEP_RULE.path_exceeded_max_depth",
    );
    expect(depthCap).toBeDefined();
    expect(depthCap!.severity).toBe("error");
    expect(depthCap!.priority).toBe("minor");
    // No analogous notice — strict mode promotes it.
    expect(
      result.notices.some(
        (n) => n.rule_id === "trace.DEEP_RULE.path_exceeded_max_depth",
      ),
    ).toBe(false);
  });

  it("lenient mode (strictMode=false): keeps legacy advisory notice + warning", () => {
    const { graph, policy } = buildDepthCapFixture();
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
      maxDepth: 3,
      strictMode: false,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.DEEP_RULE.path_exceeded_max_depth",
      ),
    ).toBe(false);
    expect(result.notices.length).toBeGreaterThan(0);
    expect(
      result.notices.some(
        (n) => n.rule_id === "trace.DEEP_RULE.path_exceeded_max_depth",
      ),
    ).toBe(true);
    expect(result.notices[0]!.severity).toBe("warning");
    expect(result.notices[0]!.priority).toBe("minor");
  });
});

describe("evaluateTracePolicies — fail-closed on unresolved calls (HIGH #1)", () => {
  // An in-scope caller with a call site the static graph could not resolve
  // (dynamic dispatch `obj[m]()`, an unfollowed alias, `Reflect.apply`,
  // `await import`) is never an edge, so the path/edge walks are blind to it.
  // The ordering analysis is therefore incomplete and MUST fail closed —
  // mirroring effect's `unresolved_call_blocks_evaluation`.
  const STRIPE = "extern:stripe::Charges::create(2)";
  const VERIFY = "src/permission/verify.ts::permission::verify(2)";
  const CALLER = "src/services/pay.ts::PayService::fastPay(1)";

  const policy = mkPolicy({
    id: "PAYMENT_GUARD",
    target: ["extern:stripe::*"],
    mustBePrecededBy: ["**::permission::verify(*)"],
    fixHint: "Insert `await permission.verify(...)` before `{target_call}`.",
  });

  it("emits an error-severity violation when an in-scope caller has a dynamic-dispatch call site", () => {
    // The caller verifies first, THEN reaches stripe — sequence is clean for
    // the resolved edges. But it ALSO has an unresolvable dynamic call: the
    // analyzer cannot prove that hidden call doesn't reach stripe before
    // verify, so it fails closed instead of reporting green.
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: VERIFY, filePath: "src/permission/verify.ts" }),
      ],
      edges: [
        mkEdge({ from: CALLER, to: VERIFY, line: 10, column: 5 }),
        mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 }),
      ],
      unresolvedCalls: [
        mkUnresolved({ from: CALLER, line: 14, column: 7, rawText: "handlers[name]()" }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const failClosed = result.violations.find(
      (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toBeDefined();
    expect(failClosed!.severity).toBe("error");
    expect(failClosed!.group_id).toBe(CALLER);
    expect(failClosed!.location.line).toBe(14);
    expect(failClosed!.cause?.detail).toContain("handlers[name]()");
  });

  it("does NOT fail closed for an out-of-scope caller's unresolved call", () => {
    const scoped = mkPolicy({
      id: "SCOPED_GUARD",
      target: ["extern:stripe::*"],
      mustBePrecededBy: ["**::permission::verify(*)"],
      // Only callers under src/payments/** are in scope; CALLER is not.
      scope: ["src/payments/**::*"],
      fixHint: "Verify first.",
    });
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: VERIFY, filePath: "src/permission/verify.ts" }),
      ],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 })],
      unresolvedCalls: [mkUnresolved({ from: CALLER, line: 14 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([scoped]),
      callGraph: graph,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.SCOPED_GUARD.unresolved_call_blocks_evaluation",
      ),
    ).toBe(false);
  });

  it("does NOT fail closed for an exempt caller's unresolved call", () => {
    const exempted = mkPolicy({
      id: "EXEMPT_GUARD",
      target: ["extern:stripe::*"],
      mustBePrecededBy: ["**::permission::verify(*)"],
      exempt: [{ pattern: "**::PayService::*", reason: "trusted entrypoint" }],
      fixHint: "Verify first.",
    });
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17 })],
      unresolvedCalls: [mkUnresolved({ from: CALLER, line: 14 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([exempted]),
      callGraph: graph,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.EXEMPT_GUARD.unresolved_call_blocks_evaluation",
      ),
    ).toBe(false);
  });

  it("emits ONE fail-closed violation per caller even with multiple unresolved sites", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17 })],
      unresolvedCalls: [
        mkUnresolved({ from: CALLER, line: 20, rawText: "b[k]()" }),
        mkUnresolved({ from: CALLER, line: 14, rawText: "a[k]()" }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const failClosed = result.violations.filter(
      (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toHaveLength(1);
    // Deterministic: the earliest call site (line 14) is reported.
    expect(failClosed[0]!.location.line).toBe(14);
    expect(failClosed[0]!.cause?.detail).toContain("a[k]()");
  });

  it("lenient mode demotes the fail-closed finding to a notice (warning)", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17 })],
      unresolvedCalls: [mkUnresolved({ from: CALLER, line: 14 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
      strictMode: false,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
      ),
    ).toBe(false);
    const notice = result.notices.find(
      (n) => n.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(notice).toBeDefined();
    expect(notice!.severity).toBe("warning");
  });

  it("fails closed even when the policy matched no targets (the hidden call could BE the edge)", () => {
    const noTargetPolicy = mkPolicy({
      id: "NO_TARGET",
      target: ["src/never/**::*"], // 0 targets in this graph
      denyDirect: ["**::*"],
      fixHint: "n/a",
    });
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [],
      unresolvedCalls: [mkUnresolved({ from: CALLER, line: 9 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([noTargetPolicy]),
      callGraph: graph,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.NO_TARGET.unresolved_call_blocks_evaluation",
      ),
    ).toBe(true);
  });

  it("does NOT fail closed for a NAME-VISIBLE indirect call (calling a named param/property)", () => {
    // `predicate()` — the callee name is statically visible. It is not the
    // named target, so it provably cannot be a hidden bypass. The refined gate
    // ignores it (nameHidden: false).
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/pay.ts" }),
        mkNode({ id: VERIFY, filePath: "src/permission/verify.ts" }),
      ],
      edges: [
        mkEdge({ from: CALLER, to: VERIFY, line: 10, column: 5 }),
        mkEdge({ from: CALLER, to: STRIPE, line: 17, column: 5 }),
      ],
      unresolvedCalls: [
        mkUnresolved({
          from: CALLER,
          line: 14,
          rawText: "predicate()",
          reason: "module-not-resolved",
          nameHidden: false,
        }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(
      result.violations.some(
        (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
      ),
    ).toBe(false);
  });

  it("fails closed for a name-hidden site but not for a sibling name-visible site on the same caller", () => {
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17 })],
      unresolvedCalls: [
        mkUnresolved({
          from: CALLER,
          line: 12,
          rawText: "predicate()",
          reason: "module-not-resolved",
          nameHidden: false,
        }),
        mkUnresolved({
          from: CALLER,
          line: 14,
          rawText: "handlers[name]()",
          nameHidden: true,
        }),
      ],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const failClosed = result.violations.filter(
      (v) => v.rule_id === "trace.PAYMENT_GUARD.unresolved_call_blocks_evaluation",
    );
    expect(failClosed).toHaveLength(1);
    // The reported site is the name-hidden one (line 14), not the visible one.
    expect(failClosed[0]!.location.line).toBe(14);
    expect(failClosed[0]!.cause?.detail).toContain("handlers[name]()");
  });
});

describe("evaluateTracePolicies — callSitesExamined coverage (HIGH #3)", () => {
  const CTRL = "src/controllers/order.ts::OrderController::handle(0)";
  const SVC = "src/services/order.ts::OrderService::run(0)";
  const DBN = "src/db/users.ts::Db::query(1)";

  it("counts enumerated paths reaching a target for path policies", () => {
    const policy = mkPolicy({
      id: "DB_VIA_REPO",
      target: ["src/db/**::*"],
      denyDirect: ["**/never/**::*"],
      fixHint: "n/a",
    });
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: SVC, filePath: "src/services/order.ts" }),
        mkNode({ id: DBN, filePath: "src/db/users.ts" }),
      ],
      edges: [mkEdge({ from: CTRL, to: SVC }), mkEdge({ from: SVC, to: DBN })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const cov = result.coverage.find((c) => c.policyId === "DB_VIA_REPO")!;
    expect(cov.callSitesExamined).toBeGreaterThan(0);
  });

  it("records callSitesExamined=0 when in-scope callers never reach the target (vacuous green)", () => {
    // Target + in-scope callers both bind, but there is NO edge from any
    // in-scope caller to the target — the policy examines nothing.
    const policy = mkPolicy({
      id: "VACUOUS",
      target: ["src/db/**::*"],
      denyDirect: ["**::*"],
      fixHint: "n/a",
    });
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CTRL, filePath: "src/controllers/order.ts" }),
        mkNode({ id: DBN, filePath: "src/db/users.ts" }),
      ],
      edges: [], // no caller→target call site
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const cov = result.coverage.find((c) => c.policyId === "VACUOUS")!;
    expect(cov.targetsMatched).toBeGreaterThan(0);
    expect(cov.scopeNodesMatched).toBeGreaterThan(0);
    expect(cov.callSitesExamined).toBe(0);
  });

  it("counts body edges matching a target pattern for sequence policies", () => {
    const STRIPE = "extern:stripe::Charges::create(2)";
    const CALLER = "src/services/pay.ts::PayService::fastPay(1)";
    const policy = mkPolicy({
      id: "SEQ",
      target: ["extern:stripe::*"],
      mustBePrecededBy: ["**::permission::verify(*)"],
      fixHint: "n/a",
    });
    const graph = mkCallGraph({
      nodes: [mkNode({ id: CALLER, filePath: "src/services/pay.ts" })],
      edges: [mkEdge({ from: CALLER, to: STRIPE, line: 17 })],
    });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const cov = result.coverage.find((c) => c.policyId === "SEQ")!;
    expect(cov.callSitesExamined).toBe(1);
  });
});

describe("evaluateTracePolicies — stats & misc", () => {
  it("policiesEvaluated matches input count", () => {
    const p1 = mkPolicy({
      id: "P1",
      target: ["src/db/**::*"],
      mustTransit: ["**::Repository::*"],
      fixHint: "Use `Repository`.",
    });
    const p2 = mkPolicy({
      id: "P2",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      fixHint: "No `Db.query` from controllers.",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB })] });
    const result = evaluateTracePolicies({
      contract: mkContract([p1, p2]),
      callGraph: graph,
    });
    expect(result.stats.policiesEvaluated).toBe(2);
    expect(result.stats.pathsEnumeratedTotal).toBeGreaterThan(0);
  });

  it("empty contract.tracePolicies yields empty result", () => {
    const result = evaluateTracePolicies({
      contract: mkContract([]),
      callGraph: ctrlGraph(),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
    expect(result.stats.policiesEvaluated).toBe(0);
  });

  it("two rules firing on same caller share group_id and get cross_rule_note", () => {
    const p1 = mkPolicy({
      id: "RULE_A",
      target: ["src/db/**::*"],
      mustTransit: ["**::Repository::*"],
      fixHint: "Use `Repository`.",
    });
    const p2 = mkPolicy({
      id: "RULE_B",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      fixHint: "No direct `Db.query` from controllers.",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB })] });
    const result = evaluateTracePolicies({
      contract: mkContract([p1, p2]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]!.group_id).toBe(CTRL);
    expect(result.violations[1]!.group_id).toBe(CTRL);
    expect(result.violations[0]!.also_violates).toBeDefined();
    expect(result.violations[0]!.cross_rule_note).toBeDefined();
  });

  it("non-matching target set yields no violations", () => {
    const policy = mkPolicy({
      id: "NO_MATCH",
      target: ["src/never/**::*"],
      denyDirect: ["**::*"],
      fixHint: "See `nothing` in src/x.ts:1",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB })] });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(0);
  });

  it("default severity is error; warning policy emits warning severity", () => {
    const warn = mkPolicy({
      id: "WARN_ONLY",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      severity: "warning",
      fixHint: "See `something` in src/x.ts:1",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB })] });
    const result = evaluateTracePolicies({
      contract: mkContract([warn]),
      callGraph: graph,
    });
    // Warning severity goes to notices, not violations (severity != "error").
    expect(result.violations).toHaveLength(0);
    expect(result.notices.length).toBeGreaterThan(0);
    expect(result.notices[0]!.severity).toBe("warning");
  });

  it("missing fix-hint falls back to a default with backticks or file:line", () => {
    const policy = mkPolicy({
      id: "NO_HINT",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      // no fixHint
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB, line: 7 })] });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations).toHaveLength(1);
    const fix = result.violations[0]!.fix?.summary ?? "";
    expect(fix.includes("`") || /\S:\d+/.test(fix)).toBe(true);
  });

  it("location is set to the call site when available", () => {
    const policy = mkPolicy({
      id: "DENY",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      fixHint: "See `it` in src/x.ts:1",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB, line: 11, column: 3 })] });
    const result = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(result.violations[0]!.location.line).toBe(11);
    expect(result.violations[0]!.location.column).toBe(3);
  });

  it("violation fingerprint is deterministic (re-run yields identical fingerprint)", () => {
    const policy = mkPolicy({
      id: "STABLE",
      target: ["src/db/**::*"],
      denyDirect: ["**/controllers/**::*"],
      fixHint: "See `it` in src/x.ts:1",
    });
    const graph = ctrlGraph({ extraEdges: [mkEdge({ from: CTRL, to: DB })] });
    const a = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    const b = evaluateTracePolicies({
      contract: mkContract([policy]),
      callGraph: graph,
    });
    expect(a.violations[0]!.fingerprint).toBe(b.violations[0]!.fingerprint);
  });

  it("performance smoke — 100-node graph + 10 policies finishes quickly", () => {
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    for (let i = 0; i < 100; i += 1) {
      nodes.push(mkNode({ id: `src/n${i}.ts::N${i}(0)`, filePath: `src/n${i}.ts` }));
      if (i > 0) {
        edges.push(mkEdge({ from: `src/n${i - 1}.ts::N${i - 1}(0)`, to: `src/n${i}.ts::N${i}(0)` }));
      }
    }
    const graph = mkCallGraph({ nodes, edges });
    const policies = Array.from({ length: 10 }, (_, idx) =>
      mkPolicy({
        id: `P${idx}`,
        target: [`src/n${idx + 50}.ts::N${idx + 50}(*)`],
        mustTransit: [`src/n${idx + 25}.ts::N${idx + 25}(*)`],
        fixHint: `Route through \`N${idx + 25}\` in src/x.ts:1`,
      }),
    );
    const start = Date.now();
    const result = evaluateTracePolicies({
      contract: mkContract(policies),
      callGraph: graph,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.stats.policiesEvaluated).toBe(10);
  });

  it("performance heavy — 1000-node graph + 20 policies < 5s", () => {
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    for (let i = 0; i < 1000; i += 1) {
      nodes.push(mkNode({ id: `src/n${i}.ts::N${i}(0)`, filePath: `src/n${i}.ts` }));
      if (i > 0) {
        edges.push(mkEdge({ from: `src/n${i - 1}.ts::N${i - 1}(0)`, to: `src/n${i}.ts::N${i}(0)` }));
      }
    }
    const graph = mkCallGraph({ nodes, edges });
    const policies = Array.from({ length: 20 }, (_, idx) =>
      mkPolicy({
        id: `P${idx}`,
        target: [`src/n${idx + 500}.ts::N${idx + 500}(*)`],
        denyDirect: ["src/never/**::*"],
        fixHint: `See \`thing\` in src/x.ts:1`,
      }),
    );
    const start = Date.now();
    const result = evaluateTracePolicies({
      contract: mkContract(policies),
      callGraph: graph,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.stats.policiesEvaluated).toBe(20);
  });
});
