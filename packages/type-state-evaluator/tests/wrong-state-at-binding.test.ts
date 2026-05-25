/**
 * Closeout 4 — `typestate.<id>.wrong_state_at_binding` rule.
 *
 * Verifies the evaluator emits the new rule when a
 * `(type-state-binding ...)` declaration's param state disagrees with
 * the per-backend extractor's static inference for the same parameter
 * index. Before this rule, bindings only suppressed inference_failed;
 * a binding could quietly contradict the type system and the mismatch
 * would never surface.
 */

import { describe, expect, it } from "vitest";

import { evaluateTypeStates } from "../src/evaluator.js";
import {
  buildWrongStateAtBindingViolation,
  defaultPriority,
} from "../src/violation-builder.js";
import { defaultWrongStateAtBindingFixHint } from "../src/fix-hint.js";
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
const ORDER_ADDITEM = "src/models/order.ts::Order::addItem(1)";
const ORDER_SUBMIT = "src/models/order.ts::Order::submit(0)";

const ORDER_DECL = mkTypeStateDecl({
  id: "ORDER_LIFECYCLE",
  target: "src/models/order.ts::Order",
  states: ["Draft", "Submitted", "Paid", "Shipped"],
  initial: "Draft",
  terminal: ["Shipped"],
  transitions: [
    { from: ["Draft"], via: "submit", to: "Submitted" },
    { from: ["Submitted"], via: "pay", to: "Paid" },
    { from: ["Paid"], via: "ship", to: "Shipped" },
  ],
  allowedOps: {
    Draft: ["addItem", "submit"],
    Submitted: ["pay"],
    Paid: ["ship"],
  },
});

function baseGraph(extraEdges: ReturnType<typeof mkEdge>[] = []) {
  return mkCallGraph({
    nodes: [
      mkNode({ id: CALLER, filePath: "src/services/order.ts" }),
      mkNode({ id: ORDER_ADDITEM, filePath: "src/models/order.ts" }),
      mkNode({ id: ORDER_SUBMIT, filePath: "src/models/order.ts" }),
    ],
    edges: extraEdges,
  });
}

describe("evaluateTypeStates — wrong_state_at_binding (closeout-4)", () => {
  it("fires when binding's declared state mismatches the inferred state for the same param index", async () => {
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_SUBMIT, line: 40, column: 5 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
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
          callerId: CALLER,
          line: 40,
          column: 5,
          method: "submit",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
          // Receiver IS param 0 of CALLER; the binding above says param 0 is
          // Submitted but the type system here resolved it to Draft.
          receiverParamIndex: 0,
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe(
      "typestate.ORDER_LIFECYCLE.wrong_state_at_binding",
    );
    expect(result.violations[0]!.priority).toBe("blocking");
    expect(result.violations[0]!.severity).toBe("error");
    expect(result.violations[0]!.group_id).toBe(CALLER);
    expect(result.violations[0]!.cause.detail).toContain(
      "binding_declared_state: Submitted",
    );
    expect(result.violations[0]!.cause.detail).toContain("inferred_state: Draft");
    expect(result.violations[0]!.cause.detail).toContain("binding_param_index: 0");
  });

  it("does NOT fire when binding state agrees with inferred state", async () => {
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_SUBMIT, line: 41, column: 5 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
      params: [{ index: 0, state: "Draft" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 41,
          column: 5,
          method: "submit",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
          receiverParamIndex: 0,
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });

  it("does NOT fire when receiverParamIndex is undefined (local-only variable)", async () => {
    // Receiver is a local variable, not a param. A binding declaration
    // for the function doesn't pin a local; we must not emit the rule.
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 50, column: 7 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
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
          callerId: CALLER,
          line: 50,
          column: 7,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
          // No receiverParamIndex — receiver is a local, not param 0.
        }),
      ]),
    });
    // Falls through to disallowed_op (addItem on Paid is not allowed),
    // but specifically does NOT emit wrong_state_at_binding.
    expect(
      result.violations.find(
        (v) => v.rule_id === "typestate.ORDER_LIFECYCLE.wrong_state_at_binding",
      ),
    ).toBeUndefined();
  });

  it("does NOT fire when binding's state is not a member of this declaration's state set", async () => {
    // The binding's state refers to a different lifecycle (e.g. SESSION
    // state name "Open"). For ORDER_LIFECYCLE, the binding is not this
    // declaration's business.
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 60, column: 3 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
      params: [{ index: 0, state: "Open" }],
    });
    const result = await evaluateTypeStates({
      contract: mkContract({
        typeStates: [ORDER_DECL],
        typeStateBindings: [binding],
      }),
      callGraph: graph,
      extractor: new StubExtractor([
        mkInference({
          callerId: CALLER,
          line: 60,
          column: 3,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Draft",
          receiverParamIndex: 0,
        }),
      ]),
    });
    // Inferred Draft, addItem is allowed on Draft → no violation at all.
    expect(
      result.violations.find(
        (v) => v.rule_id === "typestate.ORDER_LIFECYCLE.wrong_state_at_binding",
      ),
    ).toBeUndefined();
    expect(result.violations).toHaveLength(0);
  });

  it("suppresses the would-be disallowed_op when wrong_state_at_binding fires", async () => {
    // Without the new rule, addItem on Paid (disallowed) + binding=Submitted
    // would emit disallowed_op against the inferred Paid state. With the
    // new rule, the mismatch IS the report — disallowed_op is not also
    // emitted, so the operator gets a single, accurate finding.
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 70, column: 1 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
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
          callerId: CALLER,
          line: 70,
          column: 1,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: "Paid",
          receiverParamIndex: 0,
        }),
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe(
      "typestate.ORDER_LIFECYCLE.wrong_state_at_binding",
    );
  });

  it("inference_failed still suppressed by binding; wrong_state_at_binding does not double-fire", async () => {
    // The pre-closeout-4 contract is preserved: when inference fails AND
    // a binding covers the caller, no inference_failed is emitted. The
    // wrong_state_at_binding rule only fires when inference SUCCEEDS with
    // a state that disagrees, so this scenario emits zero violations.
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_ADDITEM, line: 80, column: 1 }),
    ]);
    const binding = mkBinding({
      function: CALLER,
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
          callerId: CALLER,
          line: 80,
          column: 1,
          method: "addItem",
          declarationId: "ORDER_LIFECYCLE",
          inferredState: undefined,
          receiverParamIndex: 0,
        }),
      ]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });
});

describe("buildWrongStateAtBindingViolation — shape + fix hint", () => {
  it("includes inference_source rendering and a forced-branching fix hint", () => {
    const graph = baseGraph([
      mkEdge({ from: CALLER, to: ORDER_SUBMIT, line: 90, column: 3 }),
    ]);
    const v = buildWrongStateAtBindingViolation({
      decl: ORDER_DECL,
      callerId: CALLER,
      callSite: { path: "src/services/order.ts", line: 90, column: 3 },
      method: "submit",
      paramIndex: 0,
      declaredState: "Submitted",
      inferredState: "Draft",
      inferenceSource: {
        origin: { path: "src/services/order.ts", line: 22, column: 1 },
        reason: 'parameter declared as Order<"Draft">',
        flowSteps: ["parameter ord: Order<\"Draft\">"],
      },
      callGraph: graph,
      receiverName: "ord",
    });
    expect(v.rule_id).toBe("typestate.ORDER_LIFECYCLE.wrong_state_at_binding");
    expect(v.priority).toBe("blocking");
    expect(v.cause.detail).toContain("inference_source:");
    expect(v.cause.detail).toContain(
      "origin: src/services/order.ts:22:1",
    );
    expect(v.fix?.summary ?? "").toContain("[A]");
    expect(v.fix?.summary ?? "").toContain("[B]");
    expect(v.fix?.summary ?? "").toContain("propose");
    expect(v.fix?.summary ?? "").toContain("contract issue");
    expect(v.fix?.summary ?? "").toContain("code issue");
  });

  it("defaultPriority for wrong_state_at_binding is blocking", () => {
    expect(defaultPriority("wrong_state_at_binding")).toBe("blocking");
  });

  it("default fix hint forces A/B branching with the binding context", () => {
    const hint = defaultWrongStateAtBindingFixHint(
      ORDER_DECL,
      CALLER,
      0,
      "Submitted",
      "Draft",
    );
    expect(hint).toContain("[A] Code issue");
    expect(hint).toContain("contract issue");
    expect(hint).toContain("propose");
    expect(hint).toContain("Submitted");
    expect(hint).toContain("Draft");
  });
});
