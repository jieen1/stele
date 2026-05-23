import { describe, expect, it } from "vitest";

import { evaluateTypeStates } from "../src/evaluator.js";
import {
  StubExtractor,
  mkBinding,
  mkCallGraph,
  mkContract,
  mkEdge,
  mkInference,
  mkNode,
  mkTypeStateDecl,
} from "./fixtures/helpers.js";

const CALLER = "src/services/order.ts::OrderService::process(1)";
const CALLER2 = "src/services/order.ts::OrderService::handleAnother(0)";

const ORDER_ADDITEM = "src/models/order.ts::Order::addItem(1)";
const ORDER_SUBMIT = "src/models/order.ts::Order::submit(0)";
const ORDER_PAY = "src/models/order.ts::Order::pay(0)";
const ORDER_SHIP = "src/models/order.ts::Order::ship(0)";

const ORDER_DECL = mkTypeStateDecl({
  id: "ORDER_LIFECYCLE",
  target: "src/models/order.ts::Order",
  states: ["Draft", "Submitted", "Paid", "Shipped", "Cancelled", "Refunded"],
  initial: "Draft",
  terminal: ["Shipped", "Cancelled", "Refunded"],
  transitions: [
    { from: ["Draft"], via: "submit", to: "Submitted" },
    { from: ["Submitted"], via: "pay", to: "Paid" },
    { from: ["Submitted"], via: "cancel", to: "Cancelled" },
    { from: ["Paid"], via: "ship", to: "Shipped" },
    { from: ["Paid"], via: "refund", to: "Refunded" },
  ],
  allowedOps: {
    Draft: ["addItem", "removeItem", "submit"],
    Submitted: ["pay", "cancel"],
    Paid: ["ship", "refund"],
  },
});

function baseCallGraph(extraEdges: ReturnType<typeof mkEdge>[] = []) {
  return mkCallGraph({
    nodes: [
      mkNode({ id: CALLER, filePath: "src/services/order.ts" }),
      mkNode({ id: CALLER2, filePath: "src/services/order.ts" }),
      mkNode({ id: ORDER_ADDITEM, filePath: "src/models/order.ts" }),
      mkNode({ id: ORDER_SUBMIT, filePath: "src/models/order.ts" }),
      mkNode({ id: ORDER_PAY, filePath: "src/models/order.ts" }),
      mkNode({ id: ORDER_SHIP, filePath: "src/models/order.ts" }),
    ],
    edges: extraEdges,
  });
}

describe("evaluateTypeStates — empty inputs", () => {
  it("returns empty result for empty declarations", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({}),
      callGraph: baseCallGraph(),
      extractor: new StubExtractor([]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
    expect(result.stats.declarationsEvaluated).toBe(0);
    expect(result.stats.callSitesAnalyzed).toBe(0);
  });

  it("does not invoke the extractor when no declarations exist", async () => {
    const stub = new StubExtractor([]);
    await evaluateTypeStates({
      contract: mkContract({}),
      callGraph: baseCallGraph(),
      extractor: stub,
    });
    expect(stub.callCount).toBe(0);
  });

  it("returns empty result when no inferences match any declaration", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: baseCallGraph(),
      extractor: new StubExtractor([]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
    expect(result.stats.declarationsEvaluated).toBe(1);
    expect(result.stats.callSitesAnalyzed).toBe(0);
  });
});

describe("evaluateTypeStates — disallowed-op detection", () => {
  it("flags addItem on Paid order", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 74, column: 9 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 74,
          column: 9,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
          reason: 'return type of pay() is Order<"Paid">',
          origin: { path: "src/services/order.ts", line: 62, column: 5 },
          flowSteps: [
            'Order<"Submitted"> created at src/services/order.ts:62',
            '→ Order<"Paid"> at src/services/order.ts:74 via pay()',
          ],
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("typestate.ORDER_LIFECYCLE.disallowed_op");
    expect(result.violations[0]!.priority).toBe("blocking");
    expect(result.violations[0]!.group_id).toBe(CALLER);
  });

  it("emits 0 violations for legitimate allowed-op (addItem on Draft)", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 10, column: 3 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 10,
          column: 3,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.stats.callSitesAnalyzed).toBe(1);
  });

  it("emits 0 violations for legitimate transition (submit on Draft)", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_SUBMIT, line: 12, column: 3 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 12,
          column: 3,
          method: "submit",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
  });

  it("flags submit on Submitted (transition not from current state)", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_SUBMIT, line: 20, column: 5 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 20,
          column: 5,
          method: "submit",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Submitted",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("typestate.ORDER_LIFECYCLE.disallowed_op");
  });
});

describe("evaluateTypeStates — inference failure handling (Round 2 D-CG-1)", () => {
  function failedInferenceGraph() {
    return baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 40, column: 5 }),
    ]);
  }

  const failedInf = [
    mkInference({
      callerId: CALLER,
      line: 40,
      column: 5,
      method: "addItem",
      declarationId: "ORDER_LIFECYCLE",
      inferredState: undefined,
    }),
  ];

  it("strictMode default = true (Round 2 D-CG-1) — failure becomes error", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: failedInferenceGraph(),
      extractor: new StubExtractor(failedInf),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("typestate.ORDER_LIFECYCLE.inference_failed");
    expect(result.violations[0]!.severity).toBe("error");
    expect(result.notices).toHaveLength(0);
    expect(result.stats.inferenceFailures).toBe(1);
  });

  it("strictMode = false — failure becomes warning notice", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: failedInferenceGraph(),
      extractor: new StubExtractor(failedInf),
      strictMode: false,
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]!.severity).toBe("warning");
    expect(result.notices[0]!.rule_id).toBe("typestate.ORDER_LIFECYCLE.inference_failed");
  });

  it("explicit strictMode = true matches default behaviour", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: failedInferenceGraph(),
      extractor: new StubExtractor(failedInf),
      strictMode: true,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.notices).toHaveLength(0);
  });

  it("inference-failure suppressed when a matching binding exists (Round 1 MC-2)", async () => {
    const binding = mkBinding({
      function: CALLER,
      params: [{ index: 0, state: "Submitted" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: failedInferenceGraph(),
      extractor: new StubExtractor(failedInf),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
    expect(result.stats.inferenceFailures).toBe(1);
  });

  it("binding for a different caller does NOT suppress this caller's failure", async () => {
    const binding = mkBinding({
      function: CALLER2,
      params: [{ index: 0, state: "Submitted" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: failedInferenceGraph(),
      extractor: new StubExtractor(failedInf),
    });
    expect(result.violations).toHaveLength(1);
  });
});

describe("evaluateTypeStates — Round 2 E-P1-1 inference_source", () => {
  it("violation carries origin + reason + flow_steps via cause.detail", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 74, column: 9 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 74,
          column: 9,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
          reason: 'return type of pay() is Order<"Paid">',
          origin: { path: "src/services/order.ts", line: 62, column: 5 },
          flowSteps: [
            'Order<"Submitted"> created at src/services/order.ts:62',
            '→ Order<"Paid"> at src/services/order.ts:74 via pay()',
          ],
        }),
      ]),
    });
    const detail = result.violations[0]!.cause.detail!;
    expect(detail).toContain("inference_source:");
    expect(detail).toContain("origin: src/services/order.ts:62:5");
    expect(detail).toContain('reason: return type of pay() is Order<"Paid">');
    expect(detail).toContain("flow_steps:");
    expect(detail).toContain("→ Order");
  });
});

describe("evaluateTypeStates — stats", () => {
  it("declarationsEvaluated matches contract.typeStates.length", async () => {
    const second = mkTypeStateDecl({
      id: "OTHER",
      target: "src/x.ts::Y",
      states: ["A", "B"],
      initial: "A",
      transitions: [{ from: ["A"], via: "go", to: "B" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL, second] }),
      callGraph: baseCallGraph(),
      extractor: new StubExtractor([]),
    });
    expect(result.stats.declarationsEvaluated).toBe(2);
  });

  it("callSitesAnalyzed counts only inferences whose edges are in the graph", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 10, column: 3 }),
      mkEdge({ from: CALLER, to: ORDER_PAY, line: 12, column: 3 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 10,
          column: 3,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
        }),
        mkInference({
          callerId: CALLER,
          line: 12,
          column: 3,
          method: "pay",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Submitted",
        }),
        // Inference at site not in graph — should NOT count.
        mkInference({
          callerId: CALLER,
          line: 999,
          column: 999,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
        }),
      ]),
    });
    expect(result.stats.callSitesAnalyzed).toBe(2);
  });

  it("inferenceFailures counts every undefined-state inference", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 5, column: 1 }),
      mkEdge({ from: CALLER, to: ORDER_PAY, line: 6, column: 1 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 5,
          column: 1,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: undefined,
        }),
        mkInference({
          callerId: CALLER,
          line: 6,
          column: 1,
          method: "pay",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: undefined,
        }),
      ]),
    });
    expect(result.stats.inferenceFailures).toBe(2);
  });
});

describe("evaluateTypeStates — multi-declaration", () => {
  it("evaluates two type-state decls independently", async () => {
    const declB = mkTypeStateDecl({
      id: "SESSION_LIFECYCLE",
      target: "src/models/session.ts::Session",
      states: ["Open", "Closed"],
      initial: "Open",
      terminal: ["Closed"],
      transitions: [{ from: ["Open"], via: "close", to: "Closed" }],
      allowedOps: {
        Open: ["use"],
      },
    });

    const SESS_USE = "src/models/session.ts::Session::use(0)";
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/order.ts" }),
        mkNode({ id: ORDER_ADDITEM, filePath: "src/models/order.ts" }),
        mkNode({ id: SESS_USE, filePath: "src/models/session.ts" }),
      ],
      edges: [
        mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 10, column: 1 }),
        mkEdge({ from: CALLER, to: SESS_USE, line: 20, column: 1 }),
      ],
    });

    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL, declB] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 10,
          column: 1,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid", // disallowed
        }),
        mkInference({
          callerId: CALLER,
          line: 20,
          column: 1,
          method: "use",
          declarationId: "SESSION_LIFECYCLE",
          inferredState: "Closed", // disallowed
          receiverName: "session",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(2);
    const ruleIds = result.violations.map((v) => v.rule_id).sort();
    expect(ruleIds).toEqual([
      "typestate.ORDER_LIFECYCLE.disallowed_op",
      "typestate.SESSION_LIFECYCLE.disallowed_op",
    ]);
  });
});

describe("evaluateTypeStates — Round 1 MC-3 Go separate-types", () => {
  it("target glob matches Go-style separate-types methods", async () => {
    const DRAFT_ADD = "src/order/draft.go::DraftOrder::AddItem(1)";
    const PAID_ADD = "src/order/paid.go::PaidOrder::AddItem(1)";
    const SVC = "src/order/svc.go::svc(0)";

    const goDecl = mkTypeStateDecl({
      id: "GO_ORDER",
      target: "src/order/*.go::*Order",
      states: ["Draft", "Paid"],
      initial: "Draft",
      transitions: [{ from: ["Draft"], via: "Submit", to: "Paid" }],
      allowedOps: {
        Draft: ["AddItem"],
        Paid: ["Ship"],
      },
    });

    const graph = mkCallGraph({
      language: "go",
      nodes: [
        mkNode({ id: SVC, filePath: "src/order/svc.go" }),
        mkNode({ id: DRAFT_ADD, filePath: "src/order/draft.go" }),
        mkNode({ id: PAID_ADD, filePath: "src/order/paid.go" }),
      ],
      edges: [
        mkEdge({ from: SVC, to: DRAFT_ADD, line: 5, column: 1 }),
        mkEdge({ from: SVC, to: PAID_ADD, line: 6, column: 1 }),
      ],
    });

    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [goDecl] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: SVC,
          line: 5,
          column: 1,
          method: "AddItem",
          declarationId: "GO_ORDER",
          inferredState: "Draft",
        }),
        mkInference({
          callerId: SVC,
          line: 6,
          column: 1,
          method: "AddItem",
          declarationId: "GO_ORDER",
          inferredState: "Paid",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.location.line).toBe(6);
  });

  it("state-type-mapping bridges Go separate-types to states", async () => {
    const DRAFT_ADD = "src/order.go::DraftOrder::AddItem(1)";
    const PAID_ADD = "src/order.go::PaidOrder::AddItem(1)";
    const SVC = "src/svc.go::run(0)";

    const goDecl = mkTypeStateDecl({
      id: "GO_ORDER_MAP",
      target: "src/order.go::Order",
      states: ["Draft", "Paid"],
      initial: "Draft",
      transitions: [{ from: ["Draft"], via: "Submit", to: "Paid" }],
      allowedOps: {
        Draft: ["AddItem"],
        Paid: ["Ship"],
      },
      stateTypeMapping: [
        { state: "Draft", target: "src/order.go::DraftOrder" },
        { state: "Paid", target: "src/order.go::PaidOrder" },
      ],
    });

    const graph = mkCallGraph({
      language: "go",
      nodes: [
        mkNode({ id: SVC, filePath: "src/svc.go" }),
        mkNode({ id: DRAFT_ADD, filePath: "src/order.go" }),
        mkNode({ id: PAID_ADD, filePath: "src/order.go" }),
      ],
      edges: [
        mkEdge({ from: SVC, to: DRAFT_ADD, line: 5, column: 1 }),
        mkEdge({ from: SVC, to: PAID_ADD, line: 6, column: 1 }),
      ],
    });

    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [goDecl] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: SVC,
          line: 5,
          column: 1,
          method: "AddItem",
          declarationId: "GO_ORDER_MAP",
          inferredState: "Draft",
        }),
        mkInference({
          callerId: SVC,
          line: 6,
          column: 1,
          method: "AddItem",
          declarationId: "GO_ORDER_MAP",
          inferredState: "Paid",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.location.line).toBe(6);
  });
});

describe("evaluateTypeStates — extractor contract", () => {
  it("invokes the extractor exactly once and passes declarations + bindings", async () => {
    const binding = mkBinding({
      function: CALLER,
      params: [{ index: 0, state: "Submitted" }],
    });
    const stub = new StubExtractor([]);
    await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: baseCallGraph(),
      extractor: stub,
    });
    expect(stub.callCount).toBe(1);
    expect(stub.lastOptions?.declarations).toEqual([ORDER_DECL]);
    expect(stub.lastOptions?.bindings).toEqual([binding]);
    expect(stub.lastOptions?.projectRoot).toBe("/tmp/fixture");
  });
});

describe("evaluateTypeStates — defensive behaviour", () => {
  it("ignores inferences whose call-site is not in the call graph", async () => {
    const graph = baseCallGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 10, column: 1 }),
    ]);
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 999,
          column: 999,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });

  it("ignores inferences whose target edge is not under any declaration", async () => {
    const UNRELATED = "src/other.ts::Unrelated::do(0)";
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: CALLER, filePath: "src/services/order.ts" }),
        mkNode({ id: UNRELATED, filePath: "src/other.ts" }),
      ],
      edges: [mkEdge({ from: CALLER, to: UNRELATED, line: 10, column: 1 })],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 10,
          column: 1,
          method: "do",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.stats.callSitesAnalyzed).toBe(0);
  });

  it("returns frozen violations / notices arrays", async () => {
    const result = await evaluateTypeStates({
      contract: mkContract({ typeStates: [ORDER_DECL] }),
      callGraph: baseCallGraph(),
      extractor: new StubExtractor([]),
    });
    expect(Object.isFrozen(result.violations)).toBe(true);
    expect(Object.isFrozen(result.notices)).toBe(true);
  });

  it("handles inference where the edge's NodeId disambiguator differs (binding match falls back to stripped form)", async () => {
    const callerWithDisambig = `${CALLER}#abcdef12`;
    const graph = mkCallGraph({
      nodes: [
        mkNode({ id: callerWithDisambig, filePath: "src/services/order.ts" }),
        mkNode({ id: ORDER_ADDITEM, filePath: "src/models/order.ts" }),
      ],
      edges: [mkEdge({ from: callerWithDisambig, to: ORDER_ADDITEM, line: 5, column: 1 })],
    });
    const binding = mkBinding({
      function: CALLER, // no disambiguator
      params: [{ index: 0, state: "Submitted" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: callerWithDisambig,
          line: 5,
          column: 1,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: undefined,
        }),
      ]),
    });
    // Binding match strips disambiguator; should suppress the failure.
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });
});
