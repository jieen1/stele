import { describe, expect, it } from "vitest";

import {
  buildDisallowedOpViolation,
  buildInferenceFailedViolation,
  defaultPriority,
} from "../src/violation-builder.js";
import { mkCallGraph, mkEdge, mkNode, mkTypeStateDecl } from "./fixtures/helpers.js";

const CALLER = "src/services/order.ts::OrderService::process(1)";
const TARGET = "src/models/order.ts::Order::addItem(1)";

const ORDER = mkTypeStateDecl({
  id: "ORDER_LIFECYCLE",
  target: "src/models/order.ts::Order",
  states: ["Draft", "Submitted", "Paid"],
  initial: "Draft",
  transitions: [
    { from: ["Draft"], via: "submit", to: "Submitted" },
    { from: ["Submitted"], via: "pay", to: "Paid" },
  ],
  allowedOps: {
    Draft: ["addItem", "submit"],
    Submitted: ["pay", "cancel"],
    Paid: ["ship", "refund"],
  },
});

function basicCallGraph() {
  return mkCallGraph({
    nodes: [
      mkNode({ id: CALLER, filePath: "src/services/order.ts", line: 50 }),
      mkNode({ id: TARGET, filePath: "src/models/order.ts" }),
    ],
    edges: [mkEdge({ from: CALLER, to: TARGET, line: 74, column: 9 })],
  });
}

describe("buildDisallowedOpViolation", () => {
  const callGraph = basicCallGraph();
  const v = buildDisallowedOpViolation({
    decl: ORDER,
    callerId: CALLER,
    callSite: { path: "src/services/order.ts", line: 74, column: 9 },
    method: "addItem",
    inferredState: "Paid",
    inferenceSource: {
      origin: { path: "src/services/order.ts", line: 62, column: 5 },
      reason: 'return type of pay() is Order<"Paid">',
      flowSteps: [
        'Order<"Submitted"> created at src/services/order.ts:62',
        '→ Order<"Paid"> at src/services/order.ts:74 via pay()',
      ],
    },
    callGraph,
    receiverName: "order",
  });

  it("uses rule_id `typestate.<id>.disallowed_op`", () => {
    expect(v.rule_id).toBe("typestate.ORDER_LIFECYCLE.disallowed_op");
  });

  it("rule_kind is type_state_violation", () => {
    expect(v.rule_kind).toBe("type_state_violation");
  });

  it("group_id is callerId", () => {
    expect(v.group_id).toBe(CALLER);
  });

  it("priority is `blocking` (Round 2 design-time rule)", () => {
    expect(v.priority).toBe("blocking");
  });

  it("severity is decl.severity (`error`)", () => {
    expect(v.severity).toBe("error");
  });

  it("renders inference_source into cause.detail with origin, reason, flow_steps", () => {
    expect(v.cause.detail).toContain("inference_source:");
    expect(v.cause.detail).toContain("origin: src/services/order.ts:62:5");
    expect(v.cause.detail).toContain("reason:");
    expect(v.cause.detail).toContain("flow_steps:");
    expect(v.cause.detail).toContain('→ Order<"Paid">');
  });

  it("includes allowed_methods_in_state when allowed-ops is non-empty for state", () => {
    expect(v.cause.detail).toContain("allowed_methods_in_state: [ship, refund]");
  });

  it("fingerprint is deterministic across rebuilds", () => {
    const v2 = buildDisallowedOpViolation({
      decl: ORDER,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      inferredState: "Paid",
      inferenceSource: {
        origin: { path: "src/services/order.ts", line: 62, column: 5 },
        reason: 'return type of pay() is Order<"Paid">',
        flowSteps: [
          'Order<"Submitted"> created at src/services/order.ts:62',
          '→ Order<"Paid"> at src/services/order.ts:74 via pay()',
        ],
      },
      callGraph,
      receiverName: "order",
    });
    expect(v2.fingerprint).toBe(v.fingerprint);
  });

  it("location matches the call site exactly", () => {
    expect(v.location.path).toBe("src/services/order.ts");
    expect(v.location.line).toBe(74);
    expect(v.location.column).toBe(9);
  });

  it("fix.summary contains backtick code snippet and proposal flow", () => {
    expect(v.fix?.summary).toContain("`addItem`");
    expect(v.fix?.summary).toContain("ORDER_LIFECYCLE");
    expect(v.fix?.summary).toContain("stele design propose");
    expect(v.fix?.summary).toContain("contract/design/proposals/");
  });

  it("decl.fixHint override is preferred when set", () => {
    const declOverride = { ...ORDER, fixHint: "Custom fix: see src/models/order.ts:42." };
    const v3 = buildDisallowedOpViolation({
      decl: declOverride,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      inferredState: "Paid",
      inferenceSource: { flowSteps: [] },
      callGraph,
      receiverName: "order",
    });
    expect(v3.fix?.summary).toBe("Custom fix: see src/models/order.ts:42.");
  });

  it("source identifies tool=stele, command=check, kind=type-state", () => {
    expect(v.source.tool).toBe("stele");
    expect(v.source.command).toBe("check");
    expect(v.source.kind).toBe("type-state");
  });

  it("scope_paths includes caller filePath", () => {
    expect(v.scope_paths).toContain("src/services/order.ts");
  });
});

describe("buildInferenceFailedViolation", () => {
  const callGraph = basicCallGraph();

  it("severity is `error` in strict mode", () => {
    const v = buildInferenceFailedViolation({
      decl: ORDER,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      callGraph,
      receiverName: "order",
      strictMode: true,
    });
    expect(v.severity).toBe("error");
  });

  it("severity is `warning` in lenient mode", () => {
    const v = buildInferenceFailedViolation({
      decl: ORDER,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      callGraph,
      receiverName: "order",
      strictMode: false,
    });
    expect(v.severity).toBe("warning");
  });

  it("rule_id is `typestate.<id>.inference_failed`", () => {
    const v = buildInferenceFailedViolation({
      decl: ORDER,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      callGraph,
      receiverName: "order",
      strictMode: true,
    });
    expect(v.rule_id).toBe("typestate.ORDER_LIFECYCLE.inference_failed");
  });

  it("fix.summary references (type-state-binding ...) and propose command", () => {
    const v = buildInferenceFailedViolation({
      decl: ORDER,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 74, column: 9 },
      method: "addItem",
      callGraph,
      receiverName: "order",
      strictMode: true,
    });
    expect(v.fix?.summary).toContain("(type-state-binding");
    expect(v.fix?.summary).toContain("stele design propose");
  });
});

describe("defaultPriority", () => {
  it("returns `blocking` for disallowed_op", () => {
    expect(defaultPriority("disallowed_op")).toBe("blocking");
  });

  it("returns `major` for inference_failed", () => {
    expect(defaultPriority("inference_failed")).toBe("major");
  });
});
